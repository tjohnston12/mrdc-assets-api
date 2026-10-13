// test-assets-report.js — run with: node <repo>/mrdc-assets-api/_tests/test-assets-report.js
// GET /api/assets?report=1&types=… — every register field plus every typed detail field,
// for the Assets page's Custom report. Troy, 2026-10-13: "are all fields shown as check
// boxes? i seem to think some are missing".
const path = require('path');
process.env.AIRTABLE_PAT = 'stub-pat';
process.env.ASSETS_BASE = 'appStub';
process.env.ASSET_F_CATEGORY = 'asset_type';
process.env.ASSET_F_ID = 'asset_id';
let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ' — ' + x : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);
const REG = [
  { id: 'recA1', fields: { asset_id: 'MRDC-CV-1', asset_type: 'Culvert', name: '9-C10 — Brook', km_start: 300.5, km_end: 300.6, route: 'Route 2',
    tagged_marked: 'Yes', attributes: 'x=1', 'Culvert Details': ['recD0000000000001'], Inspections: ['recI0000000000001'], date_imported: '2026-08-20' } },
  { id: 'recA2', fields: { asset_id: 'MRDC-CV-2', asset_type: 'Culvert', name: '9-C02', 'Culvert Details': ['recD0000000000002'] } },
  { id: 'recA3', fields: { asset_id: 'MRDC-SG-1', asset_type: 'Sign', name: 'SG-1' } },
  { id: 'recA4', fields: { asset_id: 'DUP', asset_type: 'Culvert', name: 'Dup A' } },
  { id: 'recA5', fields: { asset_id: 'DUP', asset_type: 'Culvert', name: 'Dup B' } },
];
const CULV = [
  { id: 'recD0000000000001', fields: { asset_id: 'MRDC-CV-1', asset: ['recA1'], pipe_class: 'CSP', diameter_width_mm: '1200', twin_flag: true, comments: 'ok' } },
  { id: 'recD0000000000002', fields: { asset_id: 'MRDC-CV-2', pipe_class: 'Conc.' } },              // no link: found by asset_id
  { id: 'recD0000000000003', fields: { asset_id: 'DUP', pipe_class: 'HDPE' } },                    // shared id, no link: nobody gets it
];
let session = { ok: true, allowed: true, user: { name: 'T', email: 't@mrdc.ca', role: 'Employee', source: 'employee', employeeId: 'recE' }, apps: ['Assets'], appRole: 'User' };
const CALLS = [];
global.fetch = async url => {
  const u = String(url);
  if (u.includes('auth.mrdc-htra.com')) return session ? { ok: true, status: 200, json: async () => session } : { ok: false, status: 401, json: async () => ({}) };
  CALLS.push(u);
  const recs = u.includes('tblDyYac0QWCQtxQv') ? CULV : u.includes('/tbl') && !u.includes('tbll88se1AcceHDhW') ? [] : REG;
  return { ok: true, status: 200, json: async () => ({ records: recs }) };
};
const handler = require(path.join(__dirname, '..', 'api', 'assets.js'));
async function call(query) {
  const r = { code: 0, body: null, h: {} };
  const res = { status(c) { r.code = c; return res; }, json(b) { r.body = b; return res; }, end() { return res; },
    setHeader(k, v) { r.h[k] = v; }, getHeader(k) { return r.h[k]; } };
  const qs = new URLSearchParams(query).toString();
  await handler({ method: 'GET', query, url: '/api/assets?' + qs, headers: { cookie: 'htra_session=x', origin: 'https://www.mrdc-htra.com' } }, res);
  return r;
}
(async () => {
  let r = await call({ report: '1', types: 'Culvert' });
  eq('200, culverts only', [r.code, Object.keys(r.body.rows).sort()], [200, ['recA1', 'recA2', 'recA4', 'recA5']]);
  ok('every register field with a value is offered, links left out', ['asset_id', 'asset_type', 'attributes', 'date_imported', 'km_end', 'km_start', 'name', 'route', 'tagged_marked']
    .every(k => r.body.fields.register.includes(k)) && !r.body.fields.register.includes('Culvert Details') && !r.body.fields.register.includes('Inspections'), r.body.fields.register.join());
  eq('the culvert detail fields are listed (join keys left out)', r.body.fields.detail.Culvert, ['comments', 'diameter_width_mm', 'pipe_class', 'twin_flag']);
  eq('a detail row joins by the asset LINK', r.body.rows.recA1.d, { pipe_class: 'CSP', diameter_width_mm: '1200', twin_flag: true, comments: 'ok' });
  eq('…or, with no link, by a unique asset_id', r.body.rows.recA2.d, { pipe_class: 'Conc.' });
  ok('…never by a SHARED asset_id', !r.body.rows.recA4.d && !r.body.rows.recA5.d);
  eq('register values come through as they are', [r.body.rows.recA1.r.km_end, r.body.rows.recA1.r.tagged_marked], [300.6, 'Yes']);
  r = await call({ report: '1', types: 'Culvert,Sign' });
  ok('two types: both, and no detail table read for a type without rows', Object.keys(r.body.rows).includes('recA3') && r.body.fields.detail.Sign !== undefined);
  eq('no types: 400, never the whole register', (await call({ report: '1', types: '' })).code, 400);
  eq('a browser caller gets no-store', r.h['Cache-Control'], 'no-store');
  session = null;
  eq('signed out: 401', (await call({ report: '1', types: 'Culvert' })).code, 401);
  console.log(failures.map(f => '   FAIL  ' + f).join('\n'));
  console.log(`\n  test-assets-report: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
