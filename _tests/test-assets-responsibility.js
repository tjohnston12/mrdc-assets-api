// test-assets-responsibility.js — run with: node <repo>/mrdc-assets-api/_tests/test-assets-responsibility.js
// Troy, 2026-11-03: "apply a filter to assets to hide any that are not MRDC, keep blank
// ones as they are to be determined" — "mrdc responsibility". The register tags an asset
// with `responsibility` only when a detail row names someone other than MRDC.
const path = require('path');
process.env.AIRTABLE_PAT = 'stub-pat';
process.env.ASSETS_BASE = 'appStub';
process.env.ASSET_F_CATEGORY = 'asset_type';
process.env.ASSET_F_ID = 'asset_id';
let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ' — ' + x : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);
const REG = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].map(k => ({ id: 'rec' + k, fields: { asset_id: 'MRDC-' + k, asset_type: 'Culvert', name: k, lat: 45.9, lng: -66.5 } }));
const CULV = [
  { id: 'recC1', fields: { asset: ['recA1'], maintenance_responsibility: 'NB DOT' } },
  { id: 'recC2', fields: { asset: ['recA2'], maintenance_responsibility: 'MRDC' } },       // formula slipped it through: re-checked
  { id: 'recC3', fields: { asset: ['recA3'], maintenance_responsibility: ' mrdc ' } },
  { id: 'recC4', fields: { asset: ['recA4'], maintenance_responsibility: '' } },           // blank: to be determined
  { id: 'recC5', fields: { asset: ['recA5'], maintenance_responsibility: 'Town of Oromocto' } },
];
const DRAIN_P1 = { records: [{ id: 'recD1', fields: { asset: ['recA6'], maintenance_responsibility: 'NBDOT' } }], offset: 'pg2' };
const DRAIN_P2 = { records: [{ id: 'recD2', fields: { asset: ['recA7'], maintenance_responsibility: 'DND' } }] };
let session = { ok: true, allowed: true, user: { name: 'T', email: 't@mrdc.ca', role: 'Employee', source: 'employee', employeeId: 'recE' }, apps: ['Assets'], appRole: 'User' };
const CALLS = [];
global.fetch = async url => {
  const u = String(url);
  if (u.includes('auth.mrdc-htra.com')) return { ok: true, status: 200, json: async () => session };
  CALLS.push(u);
  const body = u.includes('Culvert%20Details') ? { records: CULV }
    : u.includes('Drainage%20Structure%20Details') ? (u.includes('offset=pg2') ? DRAIN_P2 : DRAIN_P1)
    : u.includes('Sign%20Details') ? null
    : /Details/.test(decodeURIComponent(u)) ? { records: [] } : { records: REG };
  if (!body) return { ok: false, status: 500, json: async () => ({ error: 'boom' }), text: async () => 'boom' };
  return { ok: true, status: 200, json: async () => body };
};
const warn = console.warn; const WARN = []; console.warn = (...a) => WARN.push(a.join(' '));
const handler = require(path.join(__dirname, '..', 'api', 'assets.js'));
async function call(query) {
  const r = { code: 0, body: null, h: {} };
  const res = { status(c) { r.code = c; return res; }, json(b) { r.body = b; return res; }, end() { return res; },
    setHeader(k, v) { r.h[k] = v; }, getHeader(k) { return r.h[k]; } };
  await handler({ method: 'GET', query, url: '/api/assets?' + new URLSearchParams(query), headers: { cookie: 'htra_session=x', origin: 'https://www.mrdc-htra.com' } }, res);
  return r;
}
(async () => {
  const r = await call({ all: '1', audit: '1' });
  const list = Array.isArray(r.body) ? r.body : r.body.assets;
  const by = Object.fromEntries(list.map(a => [a.recId.slice(3), a.responsibility]));
  eq('200 and every asset still returned (the page hides, the API does not)', [r.code, list.length], [200, 7]);
  eq('non-MRDC tagged with who maintains it', [by.A1, by.A5], ['NB DOT', 'Town of Oromocto']);
  ok('MRDC untagged, whatever its case or spacing', by.A2 === undefined && by.A3 === undefined);
  ok('blank untagged (to be determined)', by.A4 === undefined);
  eq('a second page of a detail table is read too', [by.A6, by.A7], ['NBDOT', 'DND']);
  const det = CALLS.filter(u => /Details/.test(decodeURIComponent(u)));
  ok('the detail reads ask only for non-MRDC rows, two fields', det.length && det.every(u => decodeURIComponent(u).includes("LOWER(TRIM({maintenance_responsibility}))!='mrdc'")
    && decodeURIComponent(u).includes('fields[]=asset') && decodeURIComponent(u).includes('fields[]=maintenance_responsibility')));
  ok('only the six tables that carry the field are read', ['Culvert', 'Guiderail', 'Sign', 'Lighting', 'Wildlife Fence', 'Drainage Structure'].every(t => det.some(u => decodeURIComponent(u).includes(t + ' Details')))
    && !det.some(u => /Barrier Wall|Gate Details|Structure Details\?/.test(decodeURIComponent(u).replace('Drainage Structure Details', ''))));
  ok('a failing table is skipped, not fatal (warned)', WARN.some(w => w.includes('Sign Details')));
  const plain = await call({ all: '1' });
  const pl = Array.isArray(plain.body) ? plain.body : plain.body.assets;
  eq('?all=1 carries the tag too (field only, nothing removed)', [pl.length, pl.find(a => a.recId === 'recA1').responsibility], [7, 'NB DOT']);
  console.warn = warn;
  console.log(failures.map(f => '   FAIL  ' + f).join('\n'));
  console.log(`\n  test-assets-responsibility: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
