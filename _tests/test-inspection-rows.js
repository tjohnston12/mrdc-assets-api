// test-inspection-rows.js — run with: node <repo>/mrdc-assets-api/_tests/test-inspection-rows.js
// GET /api/inspections?rows=1 — every biennial (OMM 501) inspection row plus the per-asset
// rollup, for the Assets page's Excel reports. Troy, 2026-10-13: "can we create a report
// button to export an asset report which would include inspections".
const path = require('path');
const Module = require('module');
const API = path.join(__dirname, '..', 'api', 'inspections.js');
let CALLER = { user: { name: 'Roy King' }, allowed: true };
const authPath = path.join(__dirname, '..', 'api', '_auth.js');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
  requireCallerOrService: async (req, res) => { if (!CALLER) { res.status(401).json({ error: 'Not signed in.' }); return null; } return CALLER; } } };
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) { return r === './_auth' ? authPath : orig.call(this, r, ...rest); };
process.env.ASSETS_PAT = 'test-pat';
const ROWS = [
  { id: 'recB1', fields: { inspection_id: 'S-2022', asset_id: 'MRDC-ST-1', standard: 'OMM 501', year: 2022, next_due: 2024, inspection_firm: 'AMEC', result: 'Fair', report_url: 'https://x/1.pdf' } },
  { id: 'recB2', fields: { inspection_id: 'S-2024', asset_id: 'MRDC-ST-1', standard: 'OMM 501', year: 2024, next_due: 2026, inspection_firm: 'Hilcon', result: 'Good' } },
  { id: 'recB3', fields: { inspection_id: 'S2-2025', asset_id: 'MRDC-ST-2', standard: 'OMM 501', year: 2025, inspection_firm: 'Hilcon' } },
];
let calls = 0;
global.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ records: ROWS }) }; };
let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ' — ' + x : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);
const handler = require(API);
async function call(query) {
  const r = { code: 0, body: null, h: {} };
  const res = { status(c) { r.code = c; return res; }, json(b) { r.body = b; return res; }, end() { return res; },
    setHeader(k, v) { r.h[k] = v; }, getHeader(k) { return r.h[k]; } };
  await handler({ method: 'GET', query, headers: { origin: 'https://www.mrdc-htra.com' } }, res);
  return r;
}
(async () => {
  let r = await call({ rows: '1' });
  eq('rows: 200, every row, newest year first', [r.code, r.body.rows.map(x => x.inspection_id)], [200, ['S2-2025', 'S-2024', 'S-2022']]);
  eq('…with the firm, result and report link', [r.body.rows[2].firm, r.body.rows[2].result, r.body.rows[2].report_url], ['AMEC', 'Fair', 'https://x/1.pdf']);
  const st1 = r.body.byAsset['MRDC-ST-1'];
  eq('rollup: the latest inspection decides next due', [st1.count, st1.lastYear, st1.nextDue, st1.withReport], [2, 2024, 2026, 1]);
  eq('rollup: no next_due on file → last year + 2', r.body.byAsset['MRDC-ST-2'].nextDue, 2027);
  eq('a browser caller gets no-store (the CORS cache rule)', r.h['Cache-Control'], 'no-store');
  eq('narrowed by standard', (await call({ rows: '1', standard: 'OMM 999' })).body.rows.length, 0);
  eq('an empty ?asset= is still a 400, never this', (await call({ asset: '' })).code, 400);
  CALLER = null;
  eq('signed out: 401', (await call({ rows: '1' })).code, 401);
  console.log(failures.map(f => '   FAIL  ' + f).join('\n'));
  console.log(`\n  test-inspection-rows: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
