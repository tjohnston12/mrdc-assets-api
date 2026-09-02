// test-annual-inspections.js — run with: node <repo>/mrdc-assets-api/_tests/test-annual-inspections.js
// Absolute path always: `node test-x.js` from the wrong cwd exits silently with no
// output and looks exactly like a passing run (working-agreement.md §1).

const path = require('path');
const Module = require('module');

// Lives in mrdc-assets-api/_tests/ so it is NOT deployed as a serverless function.
// (mrdchtra-web/assets/test-assets-tiles.js is currently served live on www — the
// mistake this placement avoids.)
const API = path.join(__dirname, '..', 'api', 'annual-inspections.js');

// ── stub ./_auth before the handler requires it ──────────────────────────────
let SESSION = { user: { name: 'Roy King', email: 'rking@mrdc.ca' }, role: 'User', allowed: true, apps: ['Assets'] };
const authPath = path.join(__dirname, '..', 'api', '_auth.js');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true, exports: {
    getCaller: async () => SESSION,
    applyCors: () => {},
    requireSession: async () => SESSION,
    APP: 'Assets', ORIGIN: 'https://www.mrdc-htra.com',
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === './_auth') return authPath;
  return origResolve.call(this, req, ...rest);
};

process.env.ASSETS_PAT = 'test-pat';

// ── fake Airtable ────────────────────────────────────────────────────────────
const T = {
  ASSETS: 'tbll88se1AcceHDhW', INSP: 'tblieu34xMrNkx9fB',
  FIND: 'tbl35eSXEhr2L2a0I', CRIT: 'tblpTNV9HzkxL0yZ1',
  CULV: 'tblDyYac0QWCQtxQv',
};
let DB, WRITES, FAIL_ON;
function resetDb() {
  WRITES = []; FAIL_ON = null;
  DB = {
    [T.ASSETS]: [
      { id: 'recA1', fields: { asset_id: 'MRDC-CV-1', name: '9-C10 — Brook', asset_type: 'Culvert', route: 'Route 2', km_start: 300, direction: 'EB', lat: 45.8, lng: -66.1, status: '' } },
      { id: 'recA2', fields: { asset_id: 'MRDC-CV-2', name: '11-C20 — Creek', asset_type: 'Culvert', route: 'Route 2', km_start: 420, direction: 'WB', lat: 46, lng: -65.2 } },
      { id: 'recA3', fields: { asset_id: 'MRDC-CV-NBDOT', name: '6-D10 — Rte. 102', asset_type: 'Culvert', route: 'Route 2', km_start: 330 } },
      { id: 'recA4', fields: { asset_id: 'MRDC-CV-UNASSESSED', name: '12-D99', asset_type: 'Culvert', route: 'Route 2', km_start: 440 } },
      { id: 'recA5', fields: { asset_id: 'MRDC-CV-RETIRED', name: 'old one', asset_type: 'Culvert', route: 'Route 2', km_start: 310, status: 'Retired' } },
      { id: 'recA6', fields: { asset_id: 'MRDC-ST-SPAN', name: '9-C03E — Span', asset_type: 'Structure', route: 'Route 2', km_start: 351 } },
      { id: 'recD1', fields: { asset_id: 'DUP', name: 'twin one', asset_type: 'Culvert', route: 'Route 2', km_start: 350 } },
      { id: 'recD2', fields: { asset_id: 'DUP', name: 'twin two', asset_type: 'Culvert', route: 'Route 2', km_start: 350 } },
      { id: 'recS1', fields: { asset_id: 'MRDC-SN-1', name: 'S9-100', asset_type: 'Sign', route: 'Route 2', km_start: 380, direction: 'EB' } },
    ],
    'tblcRZosz76z6g2vk': [
      { id: 'recSD1', fields: { asset_id: 'MRDC-SN-1', maintenance_responsibility: 'MRDC' } },
    ],
    [T.CULV]: [
      { id: 'recC1', fields: { asset_id: 'MRDC-CV-1', maintenance_responsibility: 'MRDC' } },
      { id: 'recC2', fields: { asset_id: 'MRDC-CV-2', maintenance_responsibility: 'MRDC' } },
      { id: 'recC3', fields: { asset_id: 'MRDC-CV-NBDOT', maintenance_responsibility: 'NB DOT' } },
      { id: 'recC5', fields: { asset_id: 'MRDC-CV-RETIRED', maintenance_responsibility: 'MRDC' } },
      { id: 'recC6', fields: { asset_id: 'DUP', maintenance_responsibility: 'MRDC' } },
    ],
    [T.INSP]: [
      { id: 'recI1', fields: { inspection_id: 'AI-2025-CU-1', asset_id: 'MRDC-CV-1', programme: 'Culverts', standard: 'OMM 303', date: '2025-06-01', year: 2025, next_due: 2027, result: 'Pass', checks_total: 15, checks_failed: 0 } },
    ],
    [T.CRIT]: [
      { id: 'recX1', fields: { criterion_id: 'OMM303-q01', standard: 'OMM 303', standard_title: 'Maintenance of Culverts', check_ref: 'q01', clause: '303.2.2 (a)', defect: 'Internal obstructions', threshold: '> 10%', deadline_text: 'Within 6 months of inspection', deadline_rule: '6 months from inspection', scope: 'Asset', applies_to: ['Culvert'], sort_order: 1, active: true } },
      { id: 'recX2', fields: { criterion_id: 'OMM303-q11', standard: 'OMM 303', standard_title: 'Maintenance of Culverts', check_ref: 'q11', clause: '303.2.2 (j)', defect: 'Ditch / watercourse erosion at culvert', threshold: '> 10cm below culvert bottom over 3m', deadline_text: 'Within 6 months of inspection', deadline_rule: '6 months from inspection', scope: 'Asset', applies_to: ['Culvert'], sort_order: 11, active: true } },
      { id: 'recX3', fields: { criterion_id: 'OMM303-q15', standard: 'OMM 303', standard_title: 'Maintenance of Culverts', check_ref: 'q15', clause: '', defect: 'Significant structural damage', threshold: 'Any', deadline_text: 'Scheduled for rehabilitation or replacement on emergency basis', deadline_rule: 'Emergency basis - schedule rehab or replacement', scope: 'Asset', applies_to: ['Culvert'], sort_order: 15, active: true } },
      { id: 'recX4', fields: { criterion_id: 'OMM303-qOFF', standard: 'OMM 303', check_ref: 'qOFF', defect: 'Retired check', threshold: '', deadline_rule: 'No deadline stated', active: false } },
      { id: 'recX6', fields: { criterion_id: 'OMM704-q01', standard: 'OMM 704', standard_title: 'Signs', check_ref: 'q01', clause: '704.2.2 (a)', defect: 'Sign legibility', threshold: 'Any', deadline_text: 'Within 6 months of inspection', deadline_rule: '6 months from inspection', scope: 'Asset', applies_to: ['Sign'], sort_order: 1, active: true } },
      { id: 'recX5', fields: { criterion_id: 'OMM302-q01', standard: 'OMM 302', standard_title: 'Ditches', check_ref: 'q01', defect: 'Ponded water', threshold: '> 10cm', deadline_rule: 'October 31 same year', scope: 'Segment', applies_to: ['Ditch / watercourse'], sort_order: 1, active: true } },
    ],
  };
}

global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const table = decodeURIComponent(u.pathname.split('/')[3] || '');
  const method = opts.method || 'GET';
  if (FAIL_ON && FAIL_ON.table === table && FAIL_ON.method === method) {
    return { ok: false, status: FAIL_ON.status || 422, json: async () => ({ error: { message: FAIL_ON.message || 'boom' } }) };
  }
  if (method === 'GET') {
    const rows = DB[table] || [];
    // ⚠️ The real API returns ONLY the fields named in fields[]. A stub that answers
    // more generously than the real service tests nothing — that shipped a reminder
    // listing whole tables on 2026-08-27.
    const want = u.searchParams.getAll('fields[]');
    const recs = rows.map(r => {
      if (!want.length) return r;
      const f = {};
      for (const k of want) if (r.fields[k] !== undefined) f[k] = r.fields[k];
      return { id: r.id, fields: f };
    });
    return { ok: true, status: 200, json: async () => ({ records: recs }) };
  }
  const body = JSON.parse(opts.body || '{}');
  WRITES.push({ table, method, body });
  const recs = (body.records || []).map((r, i) => ({ id: `new${WRITES.length}_${i}`, fields: r.fields }));
  (DB[table] = DB[table] || []).push(...recs);
  return { ok: true, status: 200, json: async () => ({ records: recs }) };
};

// ── harness ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0; const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

function mkRes() {
  const r = { statusCode: null, body: null, headers: {} };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
async function call(req) {
  delete require.cache[require.resolve(API)];
  const h = require(API);
  const res = mkRes();
  await h(Object.assign({ method: 'GET', query: {}, headers: {} }, req), res);
  return res;
}
function mod() {
  delete require.cache[require.resolve(API)];
  return require(API).__test;
}

(async () => {
  resetDb();
  const M = mod();

  // ── divisionFor ────────────────────────────────────────────────────────────
  eq('division: km 300 Route 2 is Western', M.divisionFor({ route: 'Route 2', km: 300 }), 'Western');
  eq('division: km 420 Route 2 is Eastern', M.divisionFor({ route: 'Route 2', km: 420 }), 'Eastern');
  eq('division: km 364.98 is Western', M.divisionFor({ route: 'Route 2', km: 364.98 }), 'Western');
  eq('division: km 365.02 is Eastern', M.divisionFor({ route: 'Route 2', km: 365.02 }), 'Eastern');
  eq('division: Route 7 is Western', M.divisionFor({ route: 'Route 7', km: 8 }), 'Western');
  eq('division: Route 8 is Western', M.divisionFor({ route: 'Route 8', km: 200 }), 'Western');
  eq('division: Route 1 is Eastern', M.divisionFor({ route: 'Route 1', km: 240 }), 'Eastern');
  eq('division: no km is BLANK, never a guess', M.divisionFor({ route: 'Route 2', km: null }), '');
  eq('division: unknown route is blank', M.divisionFor({ route: '', km: 300 }), '');
  eq('division: on the line, EB off ramp is Western', M.divisionFor({ route: 'Route 2', km: 365, direction: 'EB', roadway_element: 'Off ramp' }), 'Western');
  eq('division: on the line, WB on ramp is Western', M.divisionFor({ route: 'Route 2', km: 365, direction: 'WB', roadway_element: 'On ramp' }), 'Western');
  eq('division: on the line, EB on ramp is Eastern', M.divisionFor({ route: 'Route 2', km: 365, direction: 'EB', roadway_element: 'On ramp' }), 'Eastern');
  eq('division: on the line, WB off ramp is Eastern', M.divisionFor({ route: 'Route 2', km: 365, direction: 'WB', roadway_element: 'Off ramp' }), 'Eastern');
  eq('division: on the line with no ramp info REFUSES', M.divisionFor({ route: 'Route 2', km: 365, direction: 'WB', roadway_element: '' }), '');

  // ── correctBy ──────────────────────────────────────────────────────────────
  eq('correct_by: 6 months', M.correctBy('6 months from inspection', '2027-05-20'), '2027-11-20');
  eq('correct_by: Oct 31 same year', M.correctBy('October 31 same year', '2027-05-20'), '2027-10-31');
  eq('correct_by: Oct 30 same year', M.correctBy('October 30 same year', '2027-05-20'), '2027-10-30');
  eq('correct_by: June 30 same year', M.correctBy('June 30 same year', '2027-02-01'), '2027-06-30');
  eq('correct_by: 4 weeks capped at Oct 31', M.correctBy('4 weeks, no later than October 31', '2027-10-20'), '2027-10-31');
  eq('correct_by: 4 weeks when earlier', M.correctBy('4 weeks, no later than October 31', '2027-05-01'), '2027-05-29');
  eq('correct_by: 48 hours', M.correctBy('48 hours from observation', '2027-05-20'), '2027-05-22');
  eq('correct_by: 10 working days', M.correctBy('10 working days', '2027-05-20'), '2027-06-03');
  eq('correct_by: immediate is same day', M.correctBy('Immediate - safety per OMM 005', '2027-05-20'), '2027-05-20');
  eq('correct_by: emergency basis has NO computable date', M.correctBy('Emergency basis - schedule rehab or replacement', '2027-05-20'), null);
  eq('correct_by: unknown rule yields null, never a fabricated date', M.correctBy('something new', '2027-05-20'), null);

  // ── stateFor ───────────────────────────────────────────────────────────────
  eq('state: no history is never', M.stateFor(null, 2027), 'never');
  eq('state: due year passed is overdue', M.stateFor(2025, 2027), 'overdue');
  eq('state: due this year is due', M.stateFor(2027, 2027), 'due');
  eq('state: future is ok', M.stateFor(2029, 2027), 'ok');

  // ── responsibility ─────────────────────────────────────────────────────────
  eq('responsibility: MRDC is ours', M.responsibilityOf({ maintenance_responsibility: 'MRDC' }), { value: 'MRDC', ours: true, assessed: true });
  eq('responsibility: NB DOT is not ours', M.responsibilityOf({ maintenance_responsibility: 'NB DOT' }).ours, false);
  eq('responsibility: NBDOT VERIFIED is not ours', M.responsibilityOf({ maintenance_responsibility: 'NBDOT VERIFIED' }).ours, false);
  eq('responsibility: dashes are not ours', M.responsibilityOf({ maintenance_responsibility: '----' }).ours, false);
  eq('responsibility: missing row is UNASSESSED, not MRDC', M.responsibilityOf(undefined), { value: '', ours: false, assessed: false });

  // ── worklist ───────────────────────────────────────────────────────────────
  resetDb();
  let wl = await mod().buildWorklist('Culverts', 2027, true);
  const ids = wl.rows.map(r => r.asset_id);
  ok('worklist: excludes NB DOT culverts', !ids.includes('MRDC-CV-NBDOT'));
  ok('worklist: excludes UNASSESSED culverts', !ids.includes('MRDC-CV-UNASSESSED'));
  ok('worklist: excludes retired assets', !ids.includes('MRDC-CV-RETIRED'));
  ok('worklist: excludes Structures (Hilcon does those)', !ids.includes('MRDC-ST-SPAN'));
  ok('worklist: includes MRDC culverts', ids.includes('MRDC-CV-1') && ids.includes('MRDC-CV-2'));
  eq('worklist: exclusion counts are reported', wl.excluded, { notOurs: 1, unassessed: 1, retired: 1 });
  eq('worklist: a 2025 inspection is due in 2027', wl.rows.find(r => r.asset_id === 'MRDC-CV-1').state, 'due');
  eq('worklist: no inspection is never', wl.rows.find(r => r.asset_id === 'MRDC-CV-2').state, 'never');
  eq('worklist: never sorts before due', wl.rows[0].state, 'never');
  eq('worklist: division is derived onto the row', wl.rows.find(r => r.asset_id === 'MRDC-CV-1').division, 'Western');
  eq('worklist: outstanding counts never+overdue+due', wl.outstanding, wl.counts.never + wl.counts.overdue + wl.counts.due);
  ok('worklist: reports how many cannot be located by GPS', typeof wl.noCoordinates === 'number');

  // ── guards ─────────────────────────────────────────────────────────────────
  SESSION = null;
  eq('guard: no session is 401', (await call({ query: { worklist: 'Culvert' } })).statusCode, 401);
  SESSION = { user: { name: 'X' }, role: 'User', allowed: false };
  eq('guard: no Assets access is 401', (await call({ query: { worklist: 'Culvert' } })).statusCode, 401);
  SESSION = { user: { name: 'Roy King', email: 'rking@mrdc.ca' }, role: 'User', allowed: true };

  eq('guard: DELETE is 405', (await call({ method: 'DELETE' })).statusCode, 405);
  eq('guard: empty worklist= is 400', (await call({ query: { worklist: '' } })).statusCode, 400);
  eq('guard: empty asset= is 400, not everything', (await call({ query: { asset: '' } })).statusCode, 400);
  eq('guard: empty criteria= is 400', (await call({ query: { criteria: '' } })).statusCode, 400);
  eq('guard: unknown programme is 400', (await call({ query: { worklist: 'Spaceships' } })).statusCode, 400);
  eq('guard: no filter at all is 400', (await call({ query: {} })).statusCode, 400);

  // ── criteria ───────────────────────────────────────────────────────────────
  let r = await call({ query: { criteria: 'OMM 303' } });
  eq('criteria: returns the standard', r.statusCode, 200);
  eq('criteria: retired criteria are excluded', r.body.criteria.map(c => c.check_ref).includes('qOFF'), false);
  eq('criteria: sorted by sort_order', r.body.criteria.map(c => c.check_ref), ['q01', 'q11', 'q15']);
  eq('criteria: unknown standard is 404', (await call({ query: { criteria: 'OMM 999' } })).statusCode, 404);

  // ── POST ───────────────────────────────────────────────────────────────────
  resetDb();
  r = await call({ method: 'POST', body: { programme: 'Culverts', rec: 'recA2', date: '2027-05-20',
    checks: [{ check_ref: 'q01', state: 'pass' }, { check_ref: 'q11', state: 'fail', notes: 'scoured out', severity: 'Deficiency' }] } });
  eq('post: creates the inspection', r.statusCode, 201);
  const inspWrite = WRITES.find(w => w.table === T.INSP);
  const F = inspWrite.body.records[0].fields;
  eq('post: result is Deficiency when a check fails', F.result, 'Deficiency');
  eq('post: deficiencies_found mirrors it', F.deficiencies_found, 'Yes');
  eq('post: checks_total counts what was graded', F.checks_total, 2);
  eq('post: checks_failed counts failures', F.checks_failed, 1);
  eq('post: next_due is year + biennial', F.next_due, 2029);
  eq('post: next_due_date is date + 2 years', F.next_due_date, '2029-05-20');
  eq('post: inspector comes from the SESSION', F.inspector, 'Roy King');
  eq('post: division derived onto the record', F.division, 'Eastern');
  eq('post: asset link is the record id', F.asset, ['recA2']);
  const findWrite = WRITES.find(w => w.table === T.FIND);
  eq('post: one finding per failure', findWrite.body.records.length, 1);
  const FF = findWrite.body.records[0].fields;
  eq('post: finding copies the threshold from the criterion', FF.threshold, '> 10cm below culvert bottom over 3m');
  eq('post: finding carries the clause', FF.clause, '303.2.2 (j)');
  eq('post: correct_by computed from the criterion rule', FF.correct_by, '2027-11-20');
  eq('post: finding opens', FF.status, 'Open');
  eq('post: finding id is deterministic', FF.finding_id, `${F.inspection_id}-q11`);

  // identity may not be self-declared
  resetDb();
  r = await call({ method: 'POST', body: { programme: 'Culverts', rec: 'recA2', date: '2027-05-20',
    inspector: 'Somebody Else', inspector_email: 'nope@example.com',
    checks: [{ check_ref: 'q01', state: 'pass' }] } });
  eq('post: a forged inspector name is ignored', WRITES.find(w => w.table === T.INSP).body.records[0].fields.inspector, 'Roy King');
  eq('post: a forged inspector email is ignored', WRITES.find(w => w.table === T.INSP).body.records[0].fields.inspector_email, 'rking@mrdc.ca');

  // the empty-form pass
  resetDb();
  r = await call({ method: 'POST', body: { programme: 'Culverts', rec: 'recA2', date: '2027-05-20', checks: [] } });
  eq('post: a Pass that graded nothing is refused', r.statusCode, 400);
  eq('post: refusing the empty pass writes nothing', WRITES.length, 0);

  // no access must not clear the obligation
  resetDb();
  r = await call({ method: 'POST', body: { programme: 'Culverts', rec: 'recA2', date: '2027-05-20',
    result: 'Not inspected - no access', checks: [] } });
  eq('post: no-access is accepted without checks', r.statusCode, 201);
  const NA = WRITES.find(w => w.table === T.INSP).body.records[0].fields;
  eq('post: no-access does NOT push the due date out', NA.next_due, 2027);
  eq('post: no-access sets no next_due_date', NA.next_due_date, undefined);

  // unknown check
  resetDb();
  r = await call({ method: 'POST', body: { programme: 'Culverts', rec: 'recA2', date: '2027-05-20',
    checks: [{ check_ref: 'qZZ', state: 'fail' }] } });
  eq('post: an invented check_ref is refused', r.statusCode, 400);
  eq('post: refusing an invented check writes nothing', WRITES.length, 0);

  // ambiguous asset_id
  resetDb();
  r = await call({ method: 'POST', body: { programme: 'Culverts', asset_id: 'DUP', date: '2027-05-20',
    checks: [{ check_ref: 'q01', state: 'pass' }] } });
  eq('post: a shared asset_id is refused with 409', r.statusCode, 409);
  eq('post: the 409 names both records', r.body.records.length, 2);
  eq('post: refusing an ambiguous save writes nothing', WRITES.length, 0);

  // wrong type
  resetDb();
  r = await call({ method: 'POST', body: { programme: 'Culverts', rec: 'recA6', date: '2027-05-20',
    checks: [{ check_ref: 'q01', state: 'pass' }] } });
  eq('post: a Structure cannot be filed under the culvert programme', r.statusCode, 400);

  // bad date / missing asset
  resetDb();
  eq('post: a missing date is refused', (await call({ method: 'POST', body: { programme: 'Culverts', rec: 'recA2', checks: [] } })).statusCode, 400);
  eq('post: an unknown programme is refused', (await call({ method: 'POST', body: { programme: 'Nope', rec: 'recA2', date: '2027-05-20' } })).statusCode, 400);
  eq('post: an asset inspection with no asset is refused', (await call({ method: 'POST', body: { programme: 'Culverts', date: '2027-05-20' } })).statusCode, 400);
  eq('post: an unknown rec is 404', (await call({ method: 'POST', body: { programme: 'Culverts', rec: 'recNOPE', date: '2027-05-20' } })).statusCode, 404);

  // findings failure must not lose the inspection
  resetDb();
  FAIL_ON = { table: T.FIND, method: 'POST', status: 422, message: 'bad field' };
  r = await call({ method: 'POST', body: { programme: 'Culverts', rec: 'recA2', date: '2027-05-20',
    checks: [{ check_ref: 'q11', state: 'fail' }] } });
  eq('post: a findings failure still saves the inspection', r.statusCode, 201);
  ok('post: and reports findingsError rather than pretending', !!r.body.findingsError);
  FAIL_ON = null;

  // segment scope
  resetDb();
  r = await call({ method: 'POST', body: { programme: 'Fall Culverts', scope: 'Segment', date: '2027-11-10',
    route: 'Route 2', km: 300, km_end: 305, description: 'ditch run', checks: [] , result: 'Pass' } });
  eq('post: a segment inspection needs no asset', r.statusCode, 400); // Pass with 0 graded still refused
  resetDb();
  r = await call({ method: 'POST', body: { programme: 'Fall Culverts', scope: 'Segment', date: '2027-11-10',
    route: 'Route 2', km: 300, km_end: 305, result: 'Not inspected - no access', checks: [] } });
  eq('post: a segment inspection files without an asset link', r.statusCode, 201);
  const SEG = WRITES.find(w => w.table === T.INSP).body.records[0].fields;
  eq('post: segment carries km_end', SEG.km_end, 305);
  eq('post: segment has no asset link', SEG.asset, undefined);
  eq('post: annual programme uses a 1-year cycle', SEG.cycle, 'Annual');

  // ⚠️ Added after mutation testing: replacing `year + prog.years` with `year + 2`
  // survived, because every POST test above used a BIENNIAL programme where the two
  // are identical. The mutation does change behaviour — for an annual programme —
  // so this is the input that proves the cadence is read per programme.
  resetDb();
  r = await call({ method: 'POST', body: { programme: 'Overhead & Ground Mounted Signs', rec: 'recS1',
    date: '2027-05-20', checks: [{ check_ref: 'q01', state: 'pass' }] } });
  eq('post: an annual programme files', r.statusCode, 201);
  const AN = WRITES.find(w => w.table === T.INSP).body.records[0].fields;
  eq('post: ANNUAL cycle is due the NEXT year, not in two', AN.next_due, 2028);
  eq('post: annual next_due_date is date + 1 year', AN.next_due_date, '2028-05-20');
  eq('post: annual programme records its own cycle', AN.cycle, 'Annual');
  eq('post: annual programme records its own standard', AN.standard, 'OMM 704');

  // and the biennial counterpart, so the pair pins the cadence from both sides
  resetDb();
  r = await call({ method: 'POST', body: { programme: 'Culverts', rec: 'recA2', date: '2027-05-20',
    checks: [{ check_ref: 'q01', state: 'pass' }] } });
  eq('post: BIENNIAL cycle is due in two years', WRITES.find(w => w.table === T.INSP).body.records[0].fields.next_due, 2029);

  // ── report ─────────────────────────────────────────────────────────────────
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFAILURES:'); for (const f of failures) console.log('  ✗ ' + f); process.exit(1); }
  process.exit(0);
})();
