// test-lighting-component.js — run with an ABSOLUTE path:
//   node <repo>/mrdc-assets-api/_tests/test-lighting-component.js
// Zero dependencies; fetch is stubbed, so no network and no credentials.
//
// 2026-09-29: kiosks and junction boxes go into the asset database as part of the
// lighting. They stay asset_type Lighting, and a new single-select on Lighting Details,
// `component`, says which kind of equipment a record is: Pole, High Mast Pole, Kiosk,
// Junction Box, Splice Pit, Floodlight. Troy: "they will both be basic locations for
// inspection and condition but perhaps more fields may be added at a later date."
//
// What this pins, against the REAL handler:
//   · ?detailfields=Lighting offers `component` FIRST, with its choices, even when the
//     sampled rows do not contain it
//   · the single-asset response carries the choices for the edit form
//   · a save with a listed value is written; an unlisted one is refused on its own
//     (reported in `rejected`) and nothing else in the save is lost
//   · creating a Kiosk writes the component to the new detail row; a typo is dropped
//   · other types are untouched: no choices, and their fields are written as before

const path = require('path');
const API = path.join(__dirname, '..', 'api');

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ` — ${x}` : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

process.env.AIRTABLE_PAT = 'stub-pat';
process.env.ASSETS_BASE = 'appStub';

const LIGHTING = 'tblrEdE23o4BNtlmM';
const SIGN = 'tblcRZosz76z6g2vk';
const ASSETS = [
  { id: 'recKIOSK', fields: { 'Asset ID': 'MRDC-HL-446 KIOSK-03', Name: '446 KIOSK-03', Category: 'Lighting', Latitude: 45.9, Longitude: -66.6 } },
  { id: 'recPOLE',  fields: { 'Asset ID': 'MRDC-HL-446 P-5', Name: '446 P-5', Category: 'Lighting', Latitude: 45.9, Longitude: -66.6 } },
  { id: 'recSIGN',  fields: { 'Asset ID': 'SGN-1', Name: 'Stop', Category: 'Sign', Latitude: 45.9, Longitude: -66.6 } },
];
// The sampled Lighting rows deliberately do NOT include `component`, to prove the
// field is offered from DETAIL_CHOICES and not only when the sample happens to hold it.
const DETAIL = {
  [LIGHTING]: [
    { id: 'recDK', fields: { asset_id: 'MRDC-HL-446 KIOSK-03', asset: ['recKIOSK'], pole_no: 'KIOSK-03', pole_type: 'n/a' } },
    { id: 'recDP', fields: { asset_id: 'MRDC-HL-446 P-5', asset: ['recPOLE'], pole_no: 'P-5', pole_type: 'Aluminum', lights_per_pole: 1 } },
  ],
  [SIGN]: [
    { id: 'recDS', fields: { asset_id: 'SGN-1', asset: ['recSIGN'], sign_class: 'R1', description: 'Stop' } },
  ],
};

let session = null; const writes = [];
global.fetch = async (url, opts = {}) => {
  const u = decodeURIComponent(String(url).replace(/\+/g, ' '));   // URLSearchParams encodes spaces as '+'
  const method = opts.method || 'GET';
  if (u.includes('auth.mrdc-htra.com')) {
    if (!session) return { ok: false, status: 401, json: async () => ({ ok: false }) };
    return { ok: true, status: 200, json: async () => session };
  }
  if (method !== 'GET') {
    const body = JSON.parse(opts.body || '{}');
    writes.push({ url: u, method, body });
    const rec = body.records ? body.records[0] : body;
    return { ok: true, status: 200, json: async () => (body.records ? { records: [{ id: 'recNEW', fields: rec.fields }] } : { id: 'recX', fields: body.fields }) };
  }
  for (const t of [LIGHTING, SIGN]) {
    if (u.includes('/' + t)) {
      const m = u.match(/\{asset_id\}='([^']*)'/);
      const rows = m ? DETAIL[t].filter(r => r.fields.asset_id === m[1]) : DETAIL[t];
      return { ok: true, status: 200, json: async () => ({ records: rows }) };
    }
  }
  if (/\/Assets(\?|\/|$)/.test(u)) {
    const m = u.match(/filterByFormula=.*'([^']*)'/);
    const rows = m ? ASSETS.filter(r => r.fields['Asset ID'] === m[1]) : ASSETS;
    return { ok: true, status: 200, json: async () => ({ records: rows }) };
  }
  return { ok: true, status: 200, json: async () => ({ records: [] }) };
};

const mkRes = () => {
  const r = { code: 0, body: null, headers: {} };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.getHeader = k => r.headers[k];
  return r;
};
const mkReq = (o = {}) => ({
  method: o.method || 'GET', query: o.query || {}, body: o.body, url: o.url || '/api/assets',
  headers: { cookie: 'htra_session=abc', origin: 'https://www.mrdc-htra.com' },
});
function fresh() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(API)) delete require.cache[k];
  return require(path.join(API, 'assets.js'));
}
const quiet = async fn => { const l = console.log, e = console.error; console.log = console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
const call = async (h, o) => { const res = mkRes(); await quiet(() => h(mkReq(o), res)); return res; };
const ADMIN = { ok: true, allowed: true, apps: ['Assets'], appRole: 'Admin',
  user: { name: 'Troy Johnston', email: 't@mrdc.ca', role: 'Owner', source: 'employee', employeeId: 'recEmp1' } };
const WANT = ['Pole', 'High Mast Pole', 'Kiosk', 'Junction Box', 'Floodlight'];

(async () => {
  session = ADMIN;

  // ── 1. The add form's field list ─────────────────────────────────────────
  {
    const h = fresh();
    const r = await call(h, { query: { detailfields: 'Lighting' }, url: '/api/assets?detailfields=Lighting' });
    eq('?detailfields=Lighting → 200', r.code, 200);
    const f = (r.body && r.body.fields) || [];
    eq('component is offered first', f[0], 'component');
    ok('…even though no sampled row holds it', !DETAIL[LIGHTING].some(x => 'component' in x.fields));
    ok('the pole fields are still offered', f.includes('pole_no') && f.includes('pole_type'), f.join(','));
    eq('component appears once', f.filter(k => k === 'component').length, 1);
    eq('choices for component', r.body && r.body.choices && r.body.choices.component, WANT);
    // Live, every Lighting row now HAS a component (backfilled 2026-09-29), so the
    // sample contains it too - it must still be listed once, and first.
    DETAIL[LIGHTING][1].fields.component = 'Pole';
    const r2 = await call(fresh(), { query: { detailfields: 'Lighting' }, url: '/api/assets?detailfields=Lighting' });
    const f2 = (r2.body && r2.body.fields) || [];
    eq('sampled rows hold component: still listed once', f2.filter(k => k === 'component').length, 1);
    eq('…and still first', f2[0], 'component');
    delete DETAIL[LIGHTING][1].fields.component;
    const s = await call(fresh(), { query: { detailfields: 'Sign' }, url: '/api/assets?detailfields=Sign' });
    eq('Sign has no choice fields', s.body && s.body.choices, {});
    ok('Sign is not offered a component', !((s.body && s.body.fields) || []).includes('component'));
  }

  // ── 2. The single-asset response, for the edit form ──────────────────────
  {
    const r = await call(fresh(), { query: { rec: 'recKIOSK' }, url: '/api/assets?rec=recKIOSK' });
    eq('kiosk asset → 200', r.code, 200);
    const d = r.body && r.body.detail;
    ok('detail present', !!d, JSON.stringify(r.body).slice(0, 200));
    eq('edit form gets component choices', d && d.choices && d.choices.component, WANT);
    eq('component is first in available', d && d.available && d.available[0], 'component');
    const s = await call(fresh(), { query: { rec: 'recSIGN' }, url: '/api/assets?rec=recSIGN' });
    eq('a Sign gets no choices', s.body && s.body.detail && s.body.detail.choices, {});
  }

  // ── 3. Saving ────────────────────────────────────────────────────────────
  {
    writes.length = 0;
    const r = await call(fresh(), { method: 'PATCH', body: { rec: 'recKIOSK', detail: { component: 'Kiosk' } } });
    eq('save Kiosk → 200', r.code, 200);
    const w = writes.find(x => x.url.includes(LIGHTING));
    eq('written to the kiosk detail row', w && w.url.endsWith('/recDK'), true);
    eq('value written as the choice name', w && w.body.fields, { component: 'Kiosk' });
    eq('nothing rejected', r.body && r.body.rejected, []);
  }
  {
    writes.length = 0;
    const r = await call(fresh(), { method: 'PATCH', body: { rec: 'recKIOSK', detail: { component: ' Junction Box ' } } });
    eq('surrounding spaces are trimmed', (writes.find(x => x.url.includes(LIGHTING)) || {}).body, { fields: { component: 'Junction Box' } });
    ok('…and saved', r.code === 200);
  }
  {
    writes.length = 0;
    const r = await call(fresh(), { method: 'PATCH', body: { rec: 'recKIOSK', detail: { component: 'kiosk', pole_type: 'N/A' } } });
    eq('a mis-cased value is refused (Airtable choices are exact)', r.body && r.body.rejected, ['component']);
    eq('…the rest of the save still goes through', (writes.find(x => x.url.includes(LIGHTING)) || {}).body, { fields: { pole_type: 'N/A' } });
  }
  {
    writes.length = 0;
    const r = await call(fresh(), { method: 'PATCH', body: { rec: 'recKIOSK', detail: { component: 'Splice Pit' } } });
    // Troy, 2026-09-29: "a splice pit is the junction box". No longer a separate value.
    eq('"Splice Pit" is no longer accepted (it is a Junction Box)', r.body && r.body.rejected, ['component']);
    eq('…nothing written', writes.length, 0);
  }
  {
    writes.length = 0;
    const r = await call(fresh(), { method: 'PATCH', body: { rec: 'recKIOSK', detail: { component: 'Cabinet' } } });
    eq('an unlisted value alone → 400 nothing to update', r.code, 400);
    eq('…and nothing written', writes.length, 0);
    eq('…and it says which field', r.body && r.body.rejected, ['component']);
  }
  {
    writes.length = 0;
    const r = await call(fresh(), { method: 'PATCH', body: { rec: 'recKIOSK', detail: { component: '' } } });
    eq('clearing component is allowed', (writes.find(x => x.url.includes(LIGHTING)) || {}).body, { fields: { component: null } });
    ok('…200', r.code === 200);
  }
  {
    writes.length = 0;
    const r = await call(fresh(), { method: 'PATCH', body: { rec: 'recSIGN', detail: { sign_class: 'R2', component: 'Kiosk' } } });
    // A Sign has no component column; with no choices for Sign the value is passed
    // through as before, exactly as any other unknown detail key always was.
    eq('other types: fields written as before', (writes.find(x => x.url.includes(SIGN)) || {}).body.fields.sign_class, 'R2');
    ok('…200', r.code === 200);
  }

  // ── 4. Creating ──────────────────────────────────────────────────────────
  {
    writes.length = 0;
    const r = await call(fresh(), { method: 'POST', body: {
      core: { asset_id: 'MRDC-HL-300 JB-01', asset_type: 'Lighting', name: '300 JB-01', km_start: 300 },
      detail: { component: 'Junction Box', pole_no: 'JB-01' } } });
    ok('create a junction box → 201', r.code === 201, `${r.code} ${JSON.stringify(r.body)}`);
    const w = writes.find(x => x.url.includes(LIGHTING) && x.method === 'POST');
    eq('detail row carries the component', w && w.body.records[0].fields.component, 'Junction Box');
    eq('…and the join keys', w && [w.body.records[0].fields.asset_id, w.body.records[0].fields.asset], ['MRDC-HL-300 JB-01', ['recNEW']]);
  }
  {
    writes.length = 0;
    const r = await call(fresh(), { method: 'POST', body: {
      core: { asset_id: 'MRDC-HL-301 KIOSK-09', asset_type: 'Lighting', name: '301 KIOSK-09' },
      detail: { component: 'Kiosque', pole_no: 'KIOSK-09' } } });
    ok('create with a typo still creates the asset', r.code === 201, r.code);
    const w = writes.find(x => x.url.includes(LIGHTING) && x.method === 'POST');
    ok('…the typo is not sent to Airtable', w && !('component' in w.body.records[0].fields), JSON.stringify(w && w.body));
    eq('…the rest of the detail row is kept', w && w.body.records[0].fields.pole_no, 'KIOSK-09');
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  failures.forEach(f => console.log('   FAIL ', f));
  process.exit(fail ? 1 : 0);
})();
