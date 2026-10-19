// test-asset-documents.js — run with an ABSOLUTE path:
//   node <repo>/mrdc-assets-api/_tests/test-asset-documents.js
// Zero dependencies; no network. Stubs the auth service and Airtable at fetch().
//
// Troy, 2026-10-19: documents on each asset (structures first), uploaded by Carlos; stored
// in Airtable; Assets editors upload and remove; everyone with Assets access sees them.
// Pinned: reading needs a session with Assets access; writing needs canEdit; documents key
// on the asset RECORD id; the file goes to Airtable's upload endpoint as base64 of the raw
// bytes; size, type, title, date checks; a failed file upload takes its row back; remove
// hides the row and keeps it; removed rows are not listed.
'use strict';
const path = require('path');
process.env.ASSETS_PAT = 'pat-test';
let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x !== undefined ? ` — ${String(x).slice(0, 300)}` : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

const R = s => ('rec' + s + 'XXXXXXXXXXXXXX').slice(0, 17);
const ASSET = R('BRIDGE1'), TWIN = R('BRIDGE2');
let SESSION = null, ROWS = {}, CALLS = [], FAIL_UPLOAD = false, seq = 0;
const H = 'https://api.airtable.com/v0/app0sXrUbOBr7a6vV/';
global.fetch = async (url, o = {}) => {
  url = String(url); const m = o.method || 'GET';
  const J = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
  if (url.includes('/api/session')) return SESSION ? J(SESSION) : J({ ok: false }, 401);
  CALLS.push({ url, m, body: o.body ? JSON.parse(o.body) : null, auth: (o.headers || {}).Authorization });
  if (url.startsWith(H + 'Assets/')) {
    const id = url.slice((H + 'Assets/').length);
    return id === ASSET || id === TWIN ? J({ id, fields: { 'Asset ID': '12-S04A', Category: 'Structure' } }) : J({ error: { type: 'NOT_FOUND' } }, 404);
  }
  if (url.startsWith('https://content.airtable.com/')) {
    if (FAIL_UPLOAD) return J({ error: { message: 'INVALID_FILE' } }, 422);
    const [, rec, fld] = url.match(/v0\/app0sXrUbOBr7a6vV\/(rec\w+)\/(fld\w+)\/uploadAttachment/);
    const b = JSON.parse(o.body);
    ROWS[rec][fld] = [{ url: 'https://v5.airtableusercontent.com/signed/' + b.filename, filename: b.filename, type: b.contentType, size: Buffer.from(b.file, 'base64').length }];
    return J({ id: rec });
  }
  if (url.startsWith(H + 'tblrPv20XR3B696CB')) {
    const rest = url.slice((H + 'tblrPv20XR3B696CB').length);
    if (m === 'POST') { const id = R('DOC' + (++seq)); ROWS[id] = Object.assign({}, JSON.parse(o.body).fields); return J({ id, fields: {} }); }
    const one = rest.match(/^\/(rec\w{14})/);
    if (one) {
      const id = one[1];
      if (!ROWS[id]) return J({ error: { type: 'NOT_FOUND' } }, 404);
      if (m === 'DELETE') { delete ROWS[id]; return J({ deleted: true, id }); }
      if (m === 'PATCH') { Object.assign(ROWS[id], JSON.parse(o.body).fields); return J({ id }); }
      return J({ id, fields: ROWS[id] });
    }
    const q = new URL(url).searchParams;
    const want = (q.get('filterByFormula').match(/\{asset_rec\}='(rec\w+)'/) || [])[1];
    return J({ records: Object.entries(ROWS).filter(([, f]) => f.fldu0mRG14IU12evD === want && !f.fldUsOKv2TR0s8Z4V).map(([id, f]) => ({ id, fields: f })) });
  }
  throw new Error('unexpected fetch ' + m + ' ' + url);
};
const handler = require(path.join(__dirname, '..', 'api', 'asset-documents.js'));
const S = (appRole, orgRole, allowed = true, source = 'employee') => ({ ok: true, allowed, appRole, user: { name: 'Carlos Hernandez', role: orgRole, source } });
async function call(method, query, body, contentType) {
  const req = { method, query: query || {}, headers: { cookie: 'htra_session=abc', origin: 'https://www.mrdc-htra.com', 'content-type': contentType || 'application/octet-stream' }, body };
  let code = 0, out = null; const hdr = {};
  const res = { setHeader: (k, v) => { hdr[k] = v; }, getHeader: k => hdr[k], status(c) { code = c; return this; }, json(o) { out = o; return this; }, end() { return this; } };
  await handler(req, res);
  return { code, body: out, hdr };
}
const up = (q, buf) => call('POST', Object.assign({ asset_rec: ASSET, doc_type: 'Work sheet', title: 'Deck repair work sheet', doc_date: '2026-10-01', filename: 'ws.pdf' }, q), buf === undefined ? Buffer.from('%PDF-1.4 test') : buf);

(async () => {
  // ── who ──
  SESSION = null;
  eq('signed out → 401', (await call('GET', { asset_rec: ASSET })).code, 401);
  SESSION = S('User', 'Employee', false);
  eq('no Assets access → 401', (await call('GET', { asset_rec: ASSET })).code, 401);
  SESSION = S('User', 'Employee');
  let r = await call('GET', { asset_rec: ASSET });
  eq('an Assets User reads; told they cannot upload', [r.code, r.body.canUpload, r.body.documents.length], [200, false, 0]);
  eq('…and the upload is refused', (await up({})).code, 403);
  ok('the list is never cached (file links expire)', r.hdr['Cache-Control'] === 'no-store');
  SESSION = S('User', 'Employee', true, 'admin');
  eq('a contractor session cannot upload', (await up({})).code, 403);

  // ── upload ──
  SESSION = S('Manager', 'Employee');
  CALLS = [];
  r = await up({});
  eq('an Assets Manager uploads', r.code, 201);
  const d = r.body.document;
  eq('row: keyed by record, asset_id and type copied, who from the session', [d.assetRec, d.assetId, d.docType, d.title, d.docDate, d.uploadedBy, d.fileName, d.fileSize],
    [ASSET, '12-S04A', 'Work sheet', 'Deck repair work sheet', '2026-10-01', 'Carlos Hernandez', 'ws.pdf', 13]);
  ok('document id format', /^AD-\d{8}-[A-Z0-9]{4}$/.test(d.documentId), d.documentId);
  const upl = CALLS.find(c => c.url.startsWith('https://content.airtable.com'));
  ok('file goes to Airtable\'s upload endpoint for the file field, as base64 of the raw bytes, with the PAT',
    upl && /\/uploadAttachment$/.test(upl.url) && upl.url.includes('/flderlrTTcnDtXYT8/') && Buffer.from(upl.body.file, 'base64').toString() === '%PDF-1.4 test' && upl.body.contentType === 'application/pdf' && upl.auth === 'Bearer pat-test');
  ok('returned with a file link', /airtableusercontent/.test(d.url));
  SESSION = S('User', 'Owner');
  eq('an Owner (org role) uploads too', (await up({ title: 'Drawing', doc_type: 'Drawing', filename: 'plan.PNG', doc_date: '' })).code, 201);

  // ── checks ──
  eq('no type → 400', (await up({ doc_type: 'Recipe' })).code, 400);
  eq('no title → 400', (await up({ title: '  ' })).code, 400);
  eq('bad date → 400', (await up({ doc_date: '01/10/2026' })).code, 400);
  eq('future date → 400', (await up({ doc_date: '2099-01-01' })).code, 400);
  eq('an .exe → 400', (await up({ filename: 'tool.exe' })).code, 400);
  eq('empty file → 400', (await up({}, Buffer.alloc(0))).code, 400);
  eq('over 4 MB → 413', (await up({}, Buffer.alloc(4 * 1024 * 1024 + 1))).code, 413);
  eq('exactly 4 MB is fine', (await up({ title: 'big' }, Buffer.alloc(4 * 1024 * 1024, 1))).code, 201);
  eq('an asset not in the register → 404', (await up({ asset_rec: R('GONE') })).code, 404);
  eq('no asset → 400', (await up({ asset_rec: '' })).code, 400);
  const before = Object.keys(ROWS).length;
  FAIL_UPLOAD = true; r = await up({ title: 'will fail' }); FAIL_UPLOAD = false;
  eq('a failed file upload → 502 and its row is taken back', [r.code, Object.keys(ROWS).length], [502, before]);

  // ── list ──
  SESSION = S('User', 'Employee');
  r = await call('GET', { asset_rec: ASSET });
  eq('newest first: undated sorts by its upload day (today), dated ones by their date', r.body.documents.map(x => x.title)[0], 'Drawing');
  ok('…the two 2026-10-01 documents follow', r.body.documents.slice(1).every(x => x.docDate === '2026-10-01'));
  eq('three documents', r.body.documents.length, 3);
  eq('the twin sharing the asset_id shows none of them', (await call('GET', { asset_rec: TWIN })).body.documents.length, 0);
  eq('empty asset_rec → 400, not everything', (await call('GET', { asset_rec: '' })).code, 400);
  eq('a malformed one → 400', (await call('GET', { asset_rec: "x' OR 1" })).code, 400);

  // ── remove ──
  eq('a User cannot remove', (await call('POST', { action: 'remove', id: d.id })).code, 403);
  SESSION = S('Admin', 'Employee');
  r = await call('POST', { action: 'remove', id: d.id });
  eq('an Assets Admin removes', r.code, 200);
  ok('…the row and file are kept, marked removed by whom', !!ROWS[d.id] && !!ROWS[d.id].fldUsOKv2TR0s8Z4V && ROWS[d.id].fldtXgiCmejDbQ8qA === 'Carlos Hernandez' && !!ROWS[d.id].flderlrTTcnDtXYT8);
  eq('…and it drops off the list', (await call('GET', { asset_rec: ASSET })).body.documents.map(x => x.id).includes(d.id), false);
  eq('removing twice is harmless', (await call('POST', { action: 'remove', id: d.id })).body.already, true);
  eq('remove an unknown → 404', (await call('POST', { action: 'remove', id: R('NOPE') })).code, 404);
  ok('nothing ever DELETEd except the failed half-write', CALLS.filter(c => c.m === 'DELETE').length === 1);

  console.log(`\n  test-asset-documents: ${pass} passed, ${fail} failed`);
  failures.forEach(f => console.log('   FAIL ', f));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('THREW', e.stack); process.exit(1); });
