// test-assets-delete.js — run with an ABSOLUTE path:
//   node <repo>/mrdc-assets-api/_tests/test-assets-delete.js
// Zero dependencies; no network, no credentials.
//
// Troy, 2026-11-05: "give emily blaney the right to delete an asset if it is a
// duplicate, ask to provide a reason."
//
// Pins:
//   · only the Owner and the people in ASSET_DELETERS may delete — not an Assets
//     Admin, not a Manager, not the service key, not a contractor
//   · a reason (>= 10 chars) and a kept record of the same type are required
//   · the Asset Deletions row is written BEFORE anything is deleted, and a failed
//     log write deletes nothing
//   · the detail row is deleted only when LINKED to this record, never matched on
//     the shared asset_id text alone
//   · ?can=delete answers the page truthfully

const path = require('path');
let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ` — ${x}` : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

process.env.AIRTABLE_PAT = 'stub-pat';
process.env.ASSETS_BASE  = 'appStub';

const EMILY = 'recqAH6l685WHKlaf';
const A1 = 'recAAAAAAAAAAAAA1', A2 = 'recAAAAAAAAAAAAA2', S1 = 'recSSSSSSSSSSSSS1';
const D1 = 'recDDDDDDDDDDDDD1', D2 = 'recDDDDDDDDDDDDD2';

let session = null, calls = [], failLog = false, linkDetail = true;
const assetsRows = () => ([
  { id: A1, fields: { 'Asset ID': 'MRDC-CV-1-C08', Name: 'Culvert dup', Category: 'Culvert', Latitude: 45.9, Longitude: -66.6 } },
  { id: A2, fields: { 'Asset ID': 'MRDC-CV-1-C08', Name: 'Culvert keep', Category: 'Culvert', Latitude: 45.9, Longitude: -66.6 } },
  { id: S1, fields: { 'Asset ID': 'MRDC-SN-1', Name: 'A sign', Category: 'Sign', Latitude: 45.9, Longitude: -66.6 } },
]);
global.fetch = async (url, opt = {}) => {
  const u = String(url), m = (opt.method || 'GET').toUpperCase();
  if (u.includes('auth.mrdc-htra.com')) {
    if (!session) return { ok: false, status: 401, json: async () => ({ ok: false }) };
    return { ok: true, status: 200, json: async () => session };
  }
  calls.push({ m, u, body: opt.body ? JSON.parse(opt.body) : null });
  const j = (b, s = 200) => ({ ok: s < 400, status: s, json: async () => b });
  if (m === 'POST' && u.includes('Asset%20Deletions')) return failLog ? j({ error: { message: 'no table' } }, 404) : j({ id: 'recLOG' });
  if (m === 'DELETE') return j({ deleted: true });
  if (m === 'GET' && /\/Assets\/rec/.test(u)) { const id = u.split('/').pop().split('?')[0]; return j(assetsRows().find(r => r.id === id) || {}); }
  if (m === 'GET' && /\/Assets\?/.test(u)) return j({ records: assetsRows() });
  if (m === 'GET' && /filterByFormula/.test(u)) {
    // two detail rows share the asset_id; only D1 links to A1
    return j({ records: [
      { id: D1, fields: { asset_id: 'MRDC-CV-1-C08', asset: linkDetail ? [A1] : [] } },
      { id: D2, fields: { asset_id: 'MRDC-CV-1-C08', asset: [A2] } },
    ] });
  }
  return j({ records: [] });
};

const assets = require(path.join(__dirname, '..', 'api', 'assets.js'));
const T = assets.__test;
const mkRes = () => { const r = { code: 0, body: null, headers: {} };
  r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; }; r.getHeader = k => r.headers[k]; return r; };
const call = async (o) => { const res = mkRes();
  await assets({ method: o.method || 'DELETE', query: o.query || {}, url: o.url || '/api/assets', body: o.body,
    headers: Object.assign({ cookie: 'htra_session=abc' }, o.headers || {}) }, res); return res; };
const S = (orgRole, appRole, employeeId, source = 'employee') => ({ ok: true, allowed: true, appRole, apps: ['Assets'],
  user: { name: employeeId === EMILY ? 'Emily Blaney' : 'Someone', email: 'x@mrdc.ca', role: orgRole, source, employeeId } });
const good = { rec: A1, keep: A2, reason: 'Same culvert entered twice from Device Magic' };

(async () => {
  // ── who
  eq('Emily is on the list', T.ASSET_DELETERS.has(EMILY), true);
  for (const [label, s, want] of [
    ['Emily (Employee, Assets Admin)', S('Employee', 'Admin', EMILY), 200],
    ['Owner',                          S('Owner', 'User', 'recOWNER000000001'), 200],
    ['an Assets Admin who is not on the list', S('Employee', 'Admin', 'recOTHER000000001'), 403],
    ['an Assets Manager',              S('Employee', 'Manager', 'recOTHER000000002'), 403],
    ['an org Admin',                   S('Admin', 'User', 'recOTHER000000003'), 403],
    ['a contractor carrying Emily\'s id', S('Contractor', '', EMILY, 'admin'), 403],
  ]) {
    session = s; calls = [];
    const r = await call({ body: good });
    eq(label + ' -> ' + want, r.code, want);
    if (want === 403) eq('  ...and nothing was written or deleted', calls.filter(c => c.m !== 'GET').length, 0);
  }
  session = null; calls = [];
  eq('no session -> 401', (await call({ body: good })).code, 401);
  calls = [];
  const svc = await call({ body: good, headers: { cookie: '' } });
  eq('no cookie -> 401', svc.code, 401);

  // ── a header cannot grant it
  session = S('Employee', 'User', 'recOTHER000000009');
  eq('x-user-role Owner header does not grant delete', (await call({ body: good, headers: { 'x-user-role': 'Owner' } })).code, 403);

  // ── what is required
  session = S('Employee', 'Admin', EMILY);
  for (const [label, body, code] of [
    ['no reason', { rec: A1, keep: A2 }, 400],
    ['a 9-character reason', { rec: A1, keep: A2, reason: 'duplicate' }, 400],
    ['whitespace reason', { rec: A1, keep: A2, reason: '            ' }, 400],
    ['no kept record', { rec: A1, reason: good.reason }, 400],
    ['kept = deleted', { rec: A1, keep: A1, reason: good.reason }, 400],
    ['malformed rec', { rec: 'A1', keep: A2, reason: good.reason }, 400],
    ['unknown rec', { rec: 'recZZZZZZZZZZZZZ9', keep: A2, reason: good.reason }, 404],
    ['unknown keep', { rec: A1, keep: 'recZZZZZZZZZZZZZ9', reason: good.reason }, 404],
    ['different asset type', { rec: A1, keep: S1, reason: good.reason }, 409],
  ]) {
    calls = [];
    const r = await call({ body });
    eq(label + ' -> ' + code, r.code, code);
    eq('  ...and nothing deleted', calls.filter(c => c.m === 'DELETE').length, 0);
  }

  // ── the happy path, in order
  calls = []; linkDetail = true;
  const r = await call({ body: good });
  eq('delete succeeds', r.code, 200);
  const writes = calls.filter(c => c.m !== 'GET');
  eq('three writes: log, detail, asset', writes.map(c => c.m), ['POST', 'DELETE', 'DELETE']);
  ok('log written first, to Asset Deletions', /Asset%20Deletions/.test(writes[0].u));
  ok('detail deleted is the LINKED row D1, not D2', writes[1].u.endsWith('/' + D1), writes[1].u);
  ok('asset deleted is A1', writes[2].u.endsWith('/Assets/' + A1), writes[2].u);
  const f = writes[0].body.fields;
  eq('log names the person from the session', f['Deleted By'], 'Emily Blaney');
  eq('log carries her employee id', f['Deleted By ID'], EMILY);
  eq('log carries the reason', f['Reason'], good.reason);
  eq('log names the kept record', f['Duplicate Of Record'], A2);
  eq('same asset_id is recorded', f['Same Asset ID'], true);
  const snap = JSON.parse(f['Snapshot']);
  eq('snapshot holds the asset row', snap.asset.fields.Name, 'Culvert dup');
  eq('snapshot holds the detail row', snap.detail.id, D1);
  eq('response reports sameAssetId', r.body.sameAssetId, true);

  // ── a forged name in the body is ignored
  calls = [];
  await call({ body: Object.assign({}, good, { deletedBy: 'Troy Johnston' }) });
  eq('body cannot set Deleted By', calls.find(c => c.m === 'POST').body.fields['Deleted By'], 'Emily Blaney');

  // ── unlinked detail rows are left alone
  calls = []; linkDetail = false;
  const r2 = await call({ body: good });
  eq('still deletes the asset', r2.code, 200);
  eq('but deletes no detail row it cannot prove is this one\'s', calls.filter(c => c.m === 'DELETE').length, 1);
  eq('and says so', r2.body.detailDeleted, null);
  linkDetail = true;

  // ── fail closed on the log
  calls = []; failLog = true;
  const r3 = await call({ body: good });
  ok('log failure is an error', r3.code >= 400, String(r3.code));
  eq('log failure deletes NOTHING', calls.filter(c => c.m === 'DELETE').length, 0);
  failLog = false;

  // ── the page's question
  session = S('Employee', 'Admin', EMILY);
  let q = await call({ method: 'GET', query: { can: 'delete' }, url: '/api/assets?can=delete' });
  eq('?can=delete -> true for Emily', q.body, { canDelete: true });
  session = S('Employee', 'Admin', 'recOTHER000000001');
  q = await call({ method: 'GET', query: { can: 'delete' }, url: '/api/assets?can=delete' });
  eq('?can=delete -> false for another Assets Admin', q.body, { canDelete: false });

  console.log(`  test-assets-delete: ${pass} passed, ${fail} failed`);
  for (const x of failures) console.log('   FAIL  ' + x);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
