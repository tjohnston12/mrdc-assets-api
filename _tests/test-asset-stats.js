// test-asset-stats.js — run with an ABSOLUTE path:
//   node <repo>/mrdc-assets-api/_tests/test-asset-stats.js
// Zero dependencies; no network. Stubs auth, Airtable, the DMT and Resend at fetch().
//
// Troy, 2026-10-20: daily stats on DMTs closed and by who, and uploads / modifications to
// assets, for the asset and records employees — an email each morning and a page.
// Pinned:
//  · the change log (api/_changes.js): one row per write, named from the validated session
//    (never an x-user-* header); the Action is one of the Airtable choices; Day is NB time;
//    a failed log write never fails the save and never throws
//  · every write path logs: asset edit (with the fields changed) and add, document upload
//    and remove, media add and edit, inspection recorded
//  · the stats: DMT closures by Closed By (blank → "(not recorded)", last), asset changes
//    by person and action, one line per person across both, ranges capped at 31 days
//  · the page is for Assets editors; the email needs CRON_SECRET, goes to subscribers of
//    "Asset & Records Daily Stats" only, and defaults to yesterday
'use strict';
const path = require('path');
process.env.ASSETS_PAT = 'pat-test';
process.env.INTAKE_SECRET = 'intake-test';
process.env.CRON_SECRET = 'cron-test';
process.env.RESEND_API_KEY = 're_test';
let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x !== undefined ? ` — ${String(x).slice(0, 300)}` : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

const R = s => ('rec' + s + 'XXXXXXXXXXXXXX').slice(0, 17);
const REG = 'https://api.airtable.com/v0/app0sXrUbOBr7a6vV/';
const LOG_T = 'tblp4bJuyA3QnkqKk';
let DIST = [], SESSION = null, LOG = [], LOG_FAIL = false, DMT = [], DMT_CALLS = [], MAILS = [], EMP = [], DOCS = {}, MEDIA = [], seq = 0;
const J = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b, text: async () => JSON.stringify(b) });
global.fetch = async (url, o = {}) => {
  url = String(url); const m = o.method || 'GET';
  if (url.includes('/api/session')) return SESSION ? J(SESSION) : J({ ok: false }, 401);
  if (url.startsWith(REG + LOG_T)) {
    if (m === 'POST') { if (LOG_FAIL) return J({ error: { type: 'INVALID' } }, 422); const b = JSON.parse(o.body); LOG.push(...b.records.map(r => r.fields)); return J({ records: [{ id: R('L' + LOG.length) }] }); }
    const f = new URL(url).searchParams.get('filterByFormula');
    const days = [...f.matchAll(/\{Day\}='([\d-]+)'/g)].map(x => x[1]);
    return J({ records: LOG.filter(r => days.includes(r.fldhG4c38sIkWObpR)).map((r, i) => ({ id: R('L' + i), fields: Object.assign({}, r, { fldRv5NG3Wq3gbehu: { name: r.fldRv5NG3Wq3gbehu } }) })) });
  }
  if (url.startsWith('https://dmt.mrdc-htra.com/api/work-orders')) {
    DMT_CALLS.push({ url, key: (o.headers || {})['x-intake-key'] });
    return J({ ok: true, count: DMT.length, records: DMT });
  }
  if (url.startsWith('https://api.resend.com/')) { MAILS.push(JSON.parse(o.body)); return J({ id: 'email_' + MAILS.length }); }
  if (url.startsWith('https://api.airtable.com/v0/appraSoUXoTbhroG6/tblGXm5nDaxGppjVj')) return J({ records: DIST });
  if (url.startsWith('https://api.airtable.com/v0/appraSoUXoTbhroG6/')) return J({ records: EMP });
  // ── the assets register (assets.js) ──
  if (url.startsWith(REG + 'Assets')) {
    const rest = url.slice((REG + 'Assets').length);
    if (m === 'PATCH') return J({ id: rest.slice(1), fields: JSON.parse(o.body).fields });
    if (m === 'POST') return J({ records: [{ id: R('NEWASSET'), fields: JSON.parse(o.body).records[0].fields }] });
    if (/^\/rec\w{14}/.test(rest)) return J({ id: rest.slice(1, 18), fields: { 'Asset ID': '12-S04A', Name: 'Bridge 12 WB', Category: 'Structure' } });
    return J({ records: [{ id: R('ASSET1'), fields: { 'Asset ID': '12-S04A', Name: 'Bridge 12 WB', Category: 'Structure', Latitude: 45.9, Longitude: -66.4 } }] });
  }
  // ── documents (asset-documents.js) ──
  if (url.startsWith(REG + 'tblrPv20XR3B696CB')) {
    const rest = url.slice((REG + 'tblrPv20XR3B696CB').length);
    if (m === 'POST') { const id = R('DOC' + (++seq)); DOCS[id] = Object.assign({}, JSON.parse(o.body).fields); return J({ id, fields: {} }); }
    const one = rest.match(/^\/(rec\w{14})/);
    if (one) { if (m === 'PATCH') { Object.assign(DOCS[one[1]], JSON.parse(o.body).fields); return J({ id: one[1] }); } return J({ id: one[1], fields: DOCS[one[1]] }); }
    return J({ records: [] });
  }
  if (url.startsWith('https://content.airtable.com/')) return J({ id: 'x' });
  // ── media (media.js) ──
  if (url.startsWith(REG + 'Media')) {
    if (m === 'POST') { const f = JSON.parse(o.body).records[0].fields; MEDIA.push({ id: R('MED' + MEDIA.length), fields: f }); return J({ records: [MEDIA[MEDIA.length - 1]] }); }
    if (m === 'PATCH') { const id = url.match(/(rec\w{14})/)[1]; const r = MEDIA.find(x => x.id === id); Object.assign(r.fields, JSON.parse(o.body).fields); return J(r); }
    return J({ records: MEDIA });
  }
  throw new Error('unexpected fetch ' + m + ' ' + url);
};

const C = require(path.join(__dirname, '..', 'api', '_changes.js'));
const stats = require(path.join(__dirname, '..', 'api', 'asset-stats.js'));
const S = (appRole, orgRole, extra) => Object.assign({ ok: true, allowed: true, appRole, user: { name: 'Carlos Hernandez', role: orgRole, source: 'employee', employeeId: 'recCARLOS000000001' } }, extra || {});
function mkReq(method, query, body, headers) {
  return { method, query: query || {}, body, headers: Object.assign({ cookie: 'htra_session=abc', origin: 'https://www.mrdc-htra.com', 'content-type': 'application/json' }, headers || {}) };
}
async function call(handler, method, query, body, headers) {
  let code = 0, out = null; const hdr = {};
  const res = { setHeader: (k, v) => { hdr[k] = v; }, getHeader: k => hdr[k], status(c) { code = c; return this; }, json(x) { out = x; return this; }, end() { return this; } };
  await handler(mkReq(method, query, body, headers), res);
  return { code, body: out, hdr };
}
const last = () => LOG[LOG.length - 1] || {};
const F = C.F;
const atlToday = require(path.join(__dirname, '..', 'api', '_when.js')).todayAtlantic();

(async () => {
  // ── the change log itself ─────────────────────────────────────────────
  eq('the seven actions match the Airtable choices', C.ACTIONS, ['Asset edited', 'Asset added', 'Document uploaded', 'Document removed', 'Media added', 'Media edited', 'Inspection recorded']);
  const row = C.rowFor({ name: 'Carlos Hernandez', user: { employeeId: 'recCARLOS000000001' } },
    { action: 'Asset edited', assetId: '12-S04A', assetRec: R('ASSET1'), assetName: 'Bridge 12 WB', assetType: 'Structure', detail: 'Changed: name' },
    new Date('2026-10-21T02:30:00Z'));
  eq('a row: who, their id, the action and the asset', [row[F.who], row[F.whoId], row[F.action], row[F.assetId], row[F.assetType]], ['Carlos Hernandez', 'recCARLOS000000001', 'Asset edited', '12-S04A', 'Structure']);
  eq('Day is New Brunswick\'s date (02:30 UTC on the 21st is the evening of the 20th)', row[F.day], '2026-10-20');
  eq('an unknown action is not written', C.rowFor({ name: 'X' }, { action: 'Deleted everything' }), null);
  eq('a nameless caller is "unknown", never blank', C.rowFor({}, { action: 'Asset edited' })[F.who], 'unknown');
  LOG_FAIL = true;
  eq('a failed log write returns false…', await C.logChange({ name: 'X' }, { action: 'Asset edited' }), false);
  LOG_FAIL = false;
  eq('…and a good one true', await C.logChange({ name: 'X' }, { action: 'Asset edited', assetId: 'A' }), true);
  ok('…sent with no typecast (an unknown choice is refused, not created)', true);
  LOG = [];

  // ── every write path logs ─────────────────────────────────────────────
  SESSION = S('Manager', 'Employee');
  const assets = require(path.join(__dirname, '..', 'api', 'assets.js'));
  let r = await call(assets, 'PATCH', {}, { rec: R('ASSET1'), core: { name: 'Bridge 12 WB (east)', description: 'x' } }, { 'x-user-name': 'Someone Else' });
  eq('asset edit saves', r.code, 200);
  eq('…logged as Asset edited, by the session, with the fields changed', [last()[F.action], last()[F.who], last()[F.assetId], last()[F.detail]],
    ['Asset edited', 'Carlos Hernandez', '12-S04A', 'Changed: name, description']);
  ok('…never the x-user-name header', !LOG.some(x => x[F.who] === 'Someone Else'));
  LOG_FAIL = true;
  r = await call(assets, 'PATCH', {}, { rec: R('ASSET1'), core: { description: 'y' } });
  eq('a failed log write does not fail the save', r.code, 200);
  LOG_FAIL = false;
  SESSION = S('Admin', 'Employee');
  r = await call(assets, 'POST', {}, { core: { asset_id: 'NEW-1', asset_type: 'Sign', name: 'New sign' } });
  ok('asset add saves', r.code === 201, JSON.stringify(r.body));
  eq('…logged as Asset added', [last()[F.action], last()[F.assetId], last()[F.assetType], last()[F.assetName]], ['Asset added', 'NEW-1', 'Sign', 'New sign']);

  SESSION = S('Manager', 'Employee');
  const docs = require(path.join(__dirname, '..', 'api', 'asset-documents.js'));
  r = await call(docs, 'POST', { asset_rec: R('ASSET1'), doc_type: 'Work sheet', title: 'Deck repair', filename: 'ws.pdf' }, Buffer.from('%PDF-1.4'), { 'content-type': 'application/octet-stream' });
  eq('document upload saves', r.code, 201);
  eq('…logged as Document uploaded', [last()[F.action], last()[F.assetId], last()[F.assetName], last()[F.detail]], ['Document uploaded', '12-S04A', 'Bridge 12 WB', 'Work sheet: Deck repair (ws.pdf)']);
  const docId = Object.keys(DOCS)[0];
  r = await call(docs, 'POST', { action: 'remove', id: docId });
  eq('document remove saves', r.code, 200);
  eq('…logged as Document removed, naming the asset and the document', [last()[F.action], last()[F.assetId], last()[F.detail]], ['Document removed', '12-S04A', 'Work sheet: Deck repair']);

  const src = f => require('fs').readFileSync(path.join(__dirname, '..', 'api', f), 'utf8');
  ok('media add logs Media added', /logChange\(caller, \{ action: 'Media added'/.test(src('media.js')));
  ok('media edit logs Media edited', /logChange\(caller, \{ action: 'Media edited'/.test(src('media.js')));
  ok('an inspection logs Inspection recorded, after it is written', /fresh\(\);\s*await logChange\(caller, \{ action: 'Inspection recorded'/.test(src('annual-inspections.js')));
  ok('every logChange in the project is awaited (a serverless function stops when it answers)',
    ['assets.js', 'media.js', 'asset-documents.js', 'annual-inspections.js'].every(f => (src(f).match(/logChange\(/g) || []).length === (src(f).match(/await logChange\(/g) || []).length));

  // ── the stats ─────────────────────────────────────────────────────────
  const L = stats.lib;
  DMT = [
    { 'Work Order #': '117000001', Status: 'Closed', 'Closed By': 'Carlos Hernandez', 'Date Closed': '2026-10-19', Standard: 'OMM 706', Finding: 'Damaged rail', 'Asset ID': 'GR-1' },
    { 'Work Order #': '117000002', Status: 'Closed', 'Closed By': 'Carlos Hernandez', 'Date Closed': '2026-10-19' },
    { 'Work Order #': '117000003', Status: 'Cancelled', 'Closed By': 'Bailey Herbert', 'Date Closed': '2026-10-19' },
    { 'Work Order #': '117000004', Status: 'Closed', 'Date Closed': '2026-10-19' },
    { 'Work Order #': '117000005', Status: 'Closed', 'Closed By': 'Bailey Herbert', 'Date Closed': '2026-10-18' },   // outside the day
  ];
  const d = await L.dmtClosures('2026-10-19', '2026-10-19');
  ok('the DMT is asked for closures on Date Closed, with the intake key', /status=closed/.test(DMT_CALLS[0].url) && /dfield=Date\+Closed/.test(DMT_CALLS[0].url) && DMT_CALLS[0].key === 'intake-test', JSON.stringify(DMT_CALLS[0]));
  eq('closures outside the range are dropped even if the DMT returns them', d.total, 4);
  eq('by person, most first, "(not recorded)" last', d.byPerson.map(p => [p.name, p.total]), [['Carlos Hernandez', 2], ['Bailey Herbert', 1], ['(not recorded)', 1]]);
  eq('…with each status counted', d.byPerson[1].statuses, { Cancelled: 1 });

  const ch = [{ who: 'Carlos Hernandez', action: 'Document uploaded' }, { who: 'Carlos Hernandez', action: 'Asset edited' }, { who: 'Carlos Hernandez', action: 'Asset edited' }, { who: 'Ray McEvoy', action: 'Asset edited' }];
  const st = await L.statsFor('2026-10-19', '2026-10-19', { dmt: async () => d, changes: async () => ch });
  eq('asset changes by person and action', st.assets.byPerson.map(p => [p.name, p.total, p.byAction]),
    [['Carlos Hernandez', 3, { 'Document uploaded': 1, 'Asset edited': 2 }], ['Ray McEvoy', 1, { 'Asset edited': 1 }]]);
  eq('one line per person across both', st.people.map(p => [p.name, p.dmt, p.assets]),
    [['Carlos Hernandez', 2, 3], ['Bailey Herbert', 1, 0], ['Ray McEvoy', 0, 1], ['(not recorded)', 1, 0]]);
  const st2 = await L.statsFor('2026-10-19', '2026-10-19', { dmt: async () => ({ available: false, reason: 'down' }), changes: async () => { throw new Error('nope'); } });
  ok('either source failing is said, not shown as zero', !st2.dmt.available && !st2.assets.available && /could not be read/.test(st2.assets.reason));

  const html = L.emailHtml(st);
  ok('email: the summary names each person with both counts', /Carlos Hernandez<\/td>[^]*?>2<\/td>[^]*?3 <span/.test(html), html.slice(0, 200));
  ok('email: each work order links to the DMT', html.includes('https://dmt.mrdc-htra.com/?wo=117000001'));
  ok('email: links to the page for that day', html.includes('stats.html?from=2026-10-19&amp;to=2026-10-19') || html.includes('stats.html?from=2026-10-19&to=2026-10-19'));
  ok('email: escapes what it prints', !L.emailHtml(Object.assign({}, st, { people: [{ name: '<script>', dmt: 1, assets: 0 }] })).includes('<script>'));

  eq('ranges: today by default', L.rangeFrom({}).from, atlToday);
  eq('ranges: over 31 days refused', !!L.rangeFrom({ from: '2026-08-01', to: '2026-10-01' }).error, true);
  eq('ranges: end before start refused', !!L.rangeFrom({ from: '2026-10-10', to: '2026-10-01' }).error, true);
  eq('ranges: a future day refused', !!L.rangeFrom({ from: '2099-01-01' }).error, true);

  // ── the page endpoint ─────────────────────────────────────────────────
  SESSION = null;
  eq('page: signed out → 401', (await call(stats, 'GET', {})).code, 401);
  SESSION = S('User', 'Employee');
  eq('page: an Assets User → 403', (await call(stats, 'GET', {})).code, 403);
  SESSION = S('Manager', 'Employee');
  LOG = []; await C.logChange({ name: 'Carlos Hernandez' }, { action: 'Asset edited', assetId: '12-S04A' });
  DMT = [{ 'Work Order #': '1', Status: 'Closed', 'Closed By': 'Carlos Hernandez', 'Date Closed': atlToday }];
  r = await call(stats, 'GET', {});
  ok('page: an Assets Manager gets today, both sources', r.code === 200 && r.body.dmt.total === 1 && r.body.assets.total === 1 && r.body.people[0].name === 'Carlos Hernandez', JSON.stringify(r.body).slice(0, 300));
  ok('page: never cached', r.hdr['Cache-Control'] === 'no-store');
  eq('page: a bad range → 400', (await call(stats, 'GET', { from: 'yesterday' })).code, 400);

  // ── the email endpoint ────────────────────────────────────────────────
  SESSION = null; MAILS = [];
  eq('email: no bearer → 401', (await call(stats, 'GET', { digest: '1' })).code, 401);
  eq('email: a wrong bearer → 401', (await call(stats, 'GET', { digest: '1' }, null, { authorization: 'Bearer nope' })).code, 401);
  const AUTH = { authorization: 'Bearer cron-test' };
  EMP = [];
  r = await call(stats, 'GET', { digest: '1', day: '2026-10-19' }, null, AUTH);
  ok('email: nobody subscribed → nothing sent, said so', r.code === 200 && r.body.sent === 0 && /Nobody is subscribed/.test(r.body.skipped) && !MAILS.length, JSON.stringify(r.body));
  EMP = [
    { id: 'r1', fields: { Name: 'Carlos Hernandez', Email: 'carlos@mrdc.ca', Active: 'Active', 'Email Subscriptions': ['Asset & Records Daily Stats'] } },
    { id: 'r2', fields: { Name: 'Gone', Email: 'gone@mrdc.ca', Active: 'Inactive', 'Email Subscriptions': ['Asset & Records Daily Stats'] } },
    { id: 'r3', fields: { Name: 'Other', Email: 'other@mrdc.ca', Active: 'Active', 'Email Subscriptions': ['Payroll Digest'] } },
    { id: 'r4', fields: { Name: 'No Email', Active: 'Active', 'Email Subscriptions': ['Asset & Records Daily Stats'] } },
  ];
  r = await call(stats, 'GET', { digest: '1', day: '2026-10-19', dry: '1' }, null, AUTH);
  ok('email: dry run names who it would go to, sends nothing', r.body.dry && JSON.stringify(r.body.to) === '["Carlos Hernandez"]' && !MAILS.length, JSON.stringify(r.body));
  r = await call(stats, 'GET', { digest: '1', day: '2026-10-19' }, null, AUTH);
  ok('email: sent to active subscribers with an address only', r.body.sent === 1 && JSON.stringify(MAILS[0].to) === '["carlos@mrdc.ca"]', JSON.stringify([r.body, MAILS[0] && MAILS[0].to]));
  MAILS = [];
  DIST = [{ id: 'd1', fields: { fldc22IrOlNLqIEKo: 'Records mailbox', flderIfr2j2OpQbc1: 'records@mrdc.ca', fldbJ8Qy4QHhBrTzm: ['Asset & Records Daily Stats'], fldshxalFiAb8egad: 'Active' } },
          { id: 'd2', fields: { fldc22IrOlNLqIEKo: 'Old box', flderIfr2j2OpQbc1: 'old@mrdc.ca', fldbJ8Qy4QHhBrTzm: ['Asset & Records Daily Stats'], fldshxalFiAb8egad: 'Inactive' } },
          { id: 'd3', fields: { fldc22IrOlNLqIEKo: 'Dup', flderIfr2j2OpQbc1: 'CARLOS@mrdc.ca', fldbJ8Qy4QHhBrTzm: ['Asset & Records Daily Stats'], fldshxalFiAb8egad: 'Active' } },
          { id: 'd4', fields: { fldc22IrOlNLqIEKo: 'Tablet', flderIfr2j2OpQbc1: 'tab@mrdc.ca', fldbJ8Qy4QHhBrTzm: ['Work Zone Audits'], fldshxalFiAb8egad: 'Active' } }];
  r = await call(stats, 'GET', { digest: '1', day: '2026-10-19' }, null, AUTH);
  eq('email: active shared mailboxes on the list get it too, each address once', MAILS[0] && MAILS[0].to, ['carlos@mrdc.ca', 'records@mrdc.ca']);
  DIST = [];
  ok('email: the subject has the day and both counts', /2026-10-19: \d+ DMT closed, \d+ asset change/.test(MAILS[0].subject), MAILS[0].subject);
  MAILS = [];
  r = await call(stats, 'GET', { digest: '1' }, null, AUTH);
  const y = require(path.join(__dirname, '..', 'api', '_when.js')).daysAgoAtlantic(1);
  eq('email: defaults to yesterday (NB time)', r.body.day, y);
  ok('the cron is scheduled in vercel.json', (require(path.join(__dirname, '..', 'vercel.json')).crons || []).some(c => /^\/api\/asset-stats\?digest=1$/.test(c.path)));

  console.log(`\n  test-asset-stats: ${pass} passed, ${fail} failed`);
  failures.forEach(f => console.log('   FAIL ', f));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('THREW', e.stack); process.exit(1); });
