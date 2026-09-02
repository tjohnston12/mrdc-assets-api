// api/annual-inspections.js — mrdc-assets-api · https://assets.mrdc-htra.com/api/annual-inspections
//
// MRDC's OWN inspection record — the in-house programme, as opposed to the
// consultant biennial bridge inspections that `inspections.js` serves.
//
//   `Inspections`        tblOQpwrLZtyMng08  AMEC / Hilcon, OMM 501, structures, report PDFs
//   `Annual Inspections` tblieu34xMrNkx9fB  MRDC crews, everything else   ← THIS FILE
//
// Replaces the standalone Annual Inspection base appRLI1oeEw4875Dg (10,340 rows,
// 2021-2026), which is being retired and archived. That base kept its own copies of
// the asset lists (Culverts Sync, Guiderail Sync, Road Signs…) and they drifted;
// this table links straight to the registry instead. See
// claude/asset-inspections-app.md and claude/inspections-2027-culvert-pass.md.
//
//   GET  ?worklist=Culvert[&year=2027]   what needs doing, one row per asset
//   GET  ?asset=<asset_id> | ?rec=<recId>  one asset's inspection history
//   GET  ?criteria=OMM+303               the checklist for a standard
//   GET  ?summary=1[&programme=Culverts] per-asset rollup
//   POST                                 file an inspection + its findings
//
// ⚠️ AN EMPTY FILTER IS AN ERROR, NOT "NO FILTER" — the same rule inspections.js
// carries. `?asset=` present but empty is a 400, never a silent "everything".
//
// Env: ASSETS_PAT / AIRTABLE_PAT (records read+write on the registry base),
//      ASSETS_BASE, AUTH_URL, WEB_ORIGIN.

const { getCaller, applyCors } = require('./_auth');

const PAT  = process.env.ASSETS_PAT || process.env.AIRTABLE_PAT;
const BASE = process.env.ASSETS_BASE || 'app0sXrUbOBr7a6vV';

const T_ASSETS     = process.env.ASSETS_TABLE      || 'tbll88se1AcceHDhW';
const T_INSPECTION = process.env.ANNUAL_INSP_TABLE || 'tblieu34xMrNkx9fB';
const T_FINDING    = process.env.INSP_FINDING_TABLE|| 'tbl35eSXEhr2L2a0I';
const T_CRITERIA   = process.env.INSP_CRITERIA_TABLE|| 'tblpTNV9HzkxL0yZ1';

// Typed detail tables — needed only for `maintenance_responsibility`, which is the
// field that decides whether an asset is MRDC's to inspect at all. See RESPONSIBILITY.
const DETAIL_TABLE = {
  Culvert: 'tblDyYac0QWCQtxQv',
  Guiderail: 'tblUwHs6Im2OY7Arc',
  Sign: 'tblcRZosz76z6g2vk',
  Lighting: 'tblrEdE23o4BNtlmM',
  Structure: 'tblYM98CKDkmYhB4A',
  'Barrier Wall': 'tblfDzv7MlCqCDncd',
  Fencing: 'tblW7bcJpCiSYKABl',
  Gate: 'tbl5sldKignbSszJV',
  'Drainage Structure': 'tblK2La03BWIjxVB3',
};

// ── The programme map ────────────────────────────────────────────────────────
// Which asset type each inspection programme covers, the OMM standard whose
// criteria apply, and the cadence. Cadence is PER STANDARD and must never be a
// constant: `inspections.js` assumes +2 years everywhere because it was written for
// biennial bridge inspections, and a culvert inheriting that assumption would show
// as due two years late.
const PROGRAMME = {
  Culverts:                          { type: 'Culvert',           standard: 'OMM 303', cycle: 'Biennial', years: 2 },
  'Fall Culverts':                   { type: 'Culvert',           standard: 'Internal - no OMM standard', cycle: 'Annual', years: 1 },
  'Steel Beam Guiderail':            { type: 'Guiderail',         standard: 'OMM 706', cycle: 'Biennial', years: 2 },
  'Overhead & Ground Mounted Signs': { type: 'Sign',              standard: 'OMM 704', cycle: 'Annual',   years: 1 },
  'Highway Illumination':            { type: 'Lighting',          standard: 'OMM 702', cycle: 'Annual',   years: 1 },
  'Wildlife Fences':                 { type: 'Fencing',           standard: 'OMM 406', cycle: 'Annual',   years: 1 },
  'Catch Basins & Manholes':         { type: 'Drainage Structure',standard: 'OMM 304', cycle: 'Annual',   years: 1 },
};
// Reverse: the default programme for an asset type, so a worklist can be asked for
// by type ("Culvert") as well as by programme name ("Culverts").
const TYPE_PROGRAMME = {};
for (const [name, p] of Object.entries(PROGRAMME)) if (!TYPE_PROGRAMME[p.type]) TYPE_PROGRAMME[p.type] = name;

// ⚠️ RESPONSIBILITY — 82 of the 811 registry culverts are NOT MRDC's to maintain
// (NB DOT 65, NBDOT VERIFIED 7, "----" 7, Town of Oromocto 2, DND 1). Every one of
// them is absent from the retired base and has never been inspected: the gap was
// never an oversight. Putting another authority's culverts on a crew's worklist is
// worse than leaving them off, so they are excluded — and anything UNASSESSED is
// excluded too rather than defaulted to MRDC. 30 culverts created by the 2026-08-31
// Device Magic backfill have no detail row at all and land in that bucket.
// The fact currently lives as free text on the typed detail table; promoting it to a
// select on `Assets` is recommended in claude/inspections-2027-culvert-pass.md §6.
const MRDC_RESPONSIBLE = /^\s*mrdc\s*$/i;
function responsibilityOf(detail) {
  const v = str(detail && detail.maintenance_responsibility);
  if (!v) return { value: '', ours: false, assessed: false };
  return { value: v, ours: MRDC_RESPONSIBLE.test(v), assessed: true };
}

// ── Division: derived, never stored ──────────────────────────────────────────
// Troy, 2026-09-01: "the border for east vs west is Exit 365. West does EB off and
// WB on, and east takes EB On and WB off." Tested against every Route 2 culvert with
// a km and a recorded inspection division: 560 of 560 agree.
// Division is a pure function of route + km, both of which are actively being
// corrected, so storing it would create a copy that goes stale the moment a km is
// fixed. `division` is empty on all 4,754 registry assets and stays that way.
// ⚠️ The boundary MOVED — in 2022 it sat near km 341. Historical division values on
// old inspections are the OLD boundary, not errors. Do not rewrite them.
const DIVISION_KM = Number(process.env.DIVISION_BOUNDARY_KM || 365);
const ROUTE_DIVISION = { 'Route 7': 'Western', 'Route 8': 'Western', 'Route 1': 'Eastern' };

function divisionFor(asset) {
  const route = str(asset.route);
  if (ROUTE_DIVISION[route]) return ROUTE_DIVISION[route];   // observed practice, 13/13, 15/15, 3/3
  if (route !== 'Route 2') return '';                        // unknown route - say nothing
  const km = num(asset.km);
  if (km == null) return '';                                 // no km - NOT a guess
  if (km < DIVISION_KM) return 'Western';
  if (km > DIVISION_KM) return 'Eastern';
  // Exactly on the boundary: the split is by ramp (EB off / WB on = Western,
  // EB on / WB off = Eastern) and `roadway_element` is populated on 2.7% of assets,
  // so this is a field decision, not a lookup. Refuse rather than guess.
  const el = str(asset.roadway_element).toLowerCase();
  const dir = str(asset.direction).toUpperCase();
  if (dir === 'EB' && el === 'off ramp') return 'Western';
  if (dir === 'WB' && el === 'on ramp')  return 'Western';
  if (dir === 'EB' && el === 'on ramp')  return 'Eastern';
  if (dir === 'WB' && el === 'off ramp') return 'Eastern';
  return '';
}

// ── Correction deadlines ─────────────────────────────────────────────────────
// The rule comes from the criterion, never from a constant: the OMM 300 series alone
// uses eight different clocks. An unrecognised rule yields NO date rather than a
// wrong one — a fabricated deadline on a safety record is worse than a blank.
function correctBy(rule, inspectionDate) {
  const d = new Date(inspectionDate + 'T00:00:00Z');
  if (isNaN(d)) return null;
  const y = d.getUTCFullYear();
  const iso = x => x.toISOString().slice(0, 10);
  const plusDays = n => { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return iso(c); };
  switch (str(rule)) {
    case '6 months from inspection': { const c = new Date(d); c.setUTCMonth(c.getUTCMonth() + 6); return iso(c); }
    case 'October 31 same year':     return `${y}-10-31`;
    case 'October 30 same year':     return `${y}-10-30`;
    case 'June 30 same year':        return `${y}-06-30`;
    case '4 weeks, no later than October 31': {
      const four = plusDays(28);
      return four < `${y}-10-31` ? four : `${y}-10-31`;
    }
    case '2 hours from observation':  return iso(d);
    case '48 hours from observation': return plusDays(2);
    case '10 working days':           return plusDays(14);   // 10 working days ≈ 2 calendar weeks
    case 'Immediate - report to Operations Centre':
    case 'Immediate - safety per OMM 005':
      return iso(d);
    default:
      // Emergency basis, owner agreement, no deadline stated - no computable date.
      return null;
  }
}

// ── Airtable ─────────────────────────────────────────────────────────────────
async function airtable(path) {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(json.error?.message || json.error?.type || `Airtable ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return json;
}

async function airtableWrite(path, method, body) {
  const r = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    // NOTE: returnFieldsByFieldId belongs in the BODY on writes, never the query
    // string, where Airtable silently ignores it. That cost the Road Patrol report
    // email an afternoon (working-agreement.md §2b).
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(json.error?.message || json.error?.type || `Airtable ${r.status}`);
    e.status = r.status;
    e.airtable = json.error || null;
    throw e;
  }
  return json;
}

async function allRows(table, fields) {
  const rows = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (Array.isArray(fields)) for (const f of fields) qs.append('fields[]', f);
    if (offset) qs.set('offset', offset);
    const page = await airtable(`${encodeURIComponent(table)}?${qs}`);
    for (const rec of page.records || []) rows.push({ recId: rec.id, ...(rec.fields || {}) });
    offset = page.offset;
  } while (offset);
  return rows;
}

const str = v => (v == null ? '' : String(v).trim());
const num = v => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const int = v => { const n = num(v); return n == null ? null : Math.trunc(n); };
const yearOf = d => { const m = /^(\d{4})-\d{2}-\d{2}/.exec(str(d)); return m ? Number(m[1]) : null; };

// ── Cache ────────────────────────────────────────────────────────────────────
// Per-lambda, and therefore NOT authoritative across instances: `handlePost` clears
// it in the instance that served the write, while the next GET can land on a
// different warm instance holding a stale copy. That is why every write response
// carries the new row rather than telling the client to re-fetch, and why ?fresh=1
// exists. Same trap assets.js hit on 2026-08-27.
const TTL_MS = 5 * 60 * 1000;
let CACHE = { at: 0, assets: null, details: {}, inspections: null, criteria: null };
const fresh = () => { CACHE = { at: 0, assets: null, details: {}, inspections: null, criteria: null }; };

async function loadAssets(force) {
  if (!force && CACHE.assets && Date.now() - CACHE.at < TTL_MS) return CACHE.assets;
  const rows = await allRows(T_ASSETS, ['asset_id', 'name', 'asset_type', 'route', 'km_start',
    'direction', 'side', 'lat', 'lng', 'status', 'roadway_element', 'asset_ref']);
  CACHE.assets = rows.map(r => ({
    recId: r.recId,
    asset_id: str(r.asset_id),
    name: str(r.name),
    type: str(r.asset_type),
    route: str(r.route),
    km: num(r.km_start),
    direction: str(r.direction),
    side: str(r.side),
    lat: num(r.lat), lng: num(r.lng),
    status: str(r.status),
    roadway_element: str(r.roadway_element),
    asset_ref: str(r.asset_ref),
  }));
  CACHE.at = Date.now();
  return CACHE.assets;
}

async function loadDetails(type, force) {
  const table = DETAIL_TABLE[type];
  if (!table) return {};
  if (!force && CACHE.details[type]) return CACHE.details[type];
  const rows = await allRows(table, ['asset_id', 'maintenance_responsibility']);
  const by = {};
  for (const r of rows) { const k = str(r.asset_id); if (k) by[k] = r; }
  CACHE.details[type] = by;
  return by;
}

async function loadInspections(force) {
  if (!force && CACHE.inspections) return CACHE.inspections;
  const rows = await allRows(T_INSPECTION, ['inspection_id', 'asset_id', 'asset_no', 'programme',
    'standard', 'date', 'year', 'next_due', 'next_due_date', 'result', 'inspector',
    'checks_total', 'checks_failed', 'description', 'source', 'scope']);
  CACHE.inspections = rows.map(r => ({
    recId: r.recId,
    inspection_id: str(r.inspection_id),
    asset_id: str(r.asset_id),
    asset_no: str(r.asset_no),
    programme: str(r.programme),
    standard: str(r.standard),
    date: str(r.date) || null,
    year: int(r.year),
    next_due: int(r.next_due),
    next_due_date: str(r.next_due_date) || null,
    result: str(r.result),
    inspector: str(r.inspector),
    checks_total: int(r.checks_total),
    checks_failed: int(r.checks_failed),
    description: str(r.description),
    source: str(r.source),
    scope: str(r.scope) || 'Asset',
  }));
  return CACHE.inspections;
}

async function loadCriteria(force) {
  if (!force && CACHE.criteria) return CACHE.criteria;
  const rows = await allRows(T_CRITERIA, ['criterion_id', 'standard', 'standard_title', 'check_ref',
    'clause', 'defect', 'description', 'threshold', 'deadline_text', 'deadline_rule', 'scope',
    'applies_to', 'sort_order', 'active', 'verified']);
  CACHE.criteria = rows
    .filter(r => r.active !== false)
    .map(r => ({
      criterion_id: str(r.criterion_id),
      standard: str(r.standard),
      standard_title: str(r.standard_title),
      check_ref: str(r.check_ref),
      clause: str(r.clause),
      defect: str(r.defect),
      description: str(r.description),
      threshold: str(r.threshold),
      deadline_text: str(r.deadline_text),
      deadline_rule: str(r.deadline_rule),
      scope: str(r.scope),
      applies_to: Array.isArray(r.applies_to) ? r.applies_to : [],
      sort_order: int(r.sort_order) || 0,
      verified: str(r.verified),
    }))
    .sort((a, b) => a.standard.localeCompare(b.standard) || a.sort_order - b.sort_order);
  return CACHE.criteria;
}

// ── Due state ────────────────────────────────────────────────────────────────
// `never` is the strongest signal on the list and is deliberately its own state
// rather than being folded into `overdue`: an asset nobody has ever looked at is a
// different problem from one that is late.
function stateFor(nextDue, year) {
  if (nextDue == null) return 'never';
  if (nextDue < year) return 'overdue';
  if (nextDue === year) return 'due';
  return 'ok';
}

function latestFor(rows) {
  let best = null;
  for (const r of rows) {
    if (!r.date) continue;
    if (!best || r.date > best.date) best = r;
  }
  return best;
}

// ── Worklist ─────────────────────────────────────────────────────────────────
async function buildWorklist(programmeName, year, force) {
  const prog = PROGRAMME[programmeName];
  const assets = await loadAssets(force);
  const details = await loadDetails(prog.type, force);
  const inspections = await loadInspections(force);

  const byAsset = new Map();
  for (const i of inspections) {
    if (i.programme && i.programme !== programmeName) continue;
    if (!i.asset_id) continue;
    if (!byAsset.has(i.asset_id)) byAsset.set(i.asset_id, []);
    byAsset.get(i.asset_id).push(i);
  }

  const rows = [];
  const excluded = { notOurs: 0, unassessed: 0, retired: 0 };
  for (const a of assets) {
    if (a.type !== prog.type) continue;
    if (/^retired$/i.test(a.status)) { excluded.retired++; continue; }

    const resp = responsibilityOf(details[a.asset_id]);
    if (!resp.assessed) { excluded.unassessed++; continue; }
    if (!resp.ours)     { excluded.notOurs++; continue; }

    const mine = byAsset.get(a.asset_id) || [];
    const last = latestFor(mine);
    const nextDue = last ? (last.next_due != null ? last.next_due : (yearOf(last.date) + prog.years)) : null;

    rows.push({
      recId: a.recId,
      asset_id: a.asset_id,
      asset_no: a.name || a.asset_ref || a.asset_id,
      route: a.route, km: a.km, direction: a.direction, side: a.side,
      lat: a.lat, lng: a.lng,
      division: divisionFor(a),
      last_date: last ? last.date : null,
      last_year: last ? (last.year != null ? last.year : yearOf(last.date)) : null,
      last_result: last ? last.result : '',
      next_due: nextDue,
      next_due_date: last ? last.next_due_date : null,
      state: stateFor(nextDue, year),
      count: mine.length,
      locatable: a.lat != null && a.lng != null,
    });
  }

  // Ordered the way a crew works it: what needs doing first, then along the road.
  const RANK = { never: 0, overdue: 1, due: 2, ok: 3 };
  rows.sort((x, y) =>
    RANK[x.state] - RANK[y.state] ||
    (x.route || '').localeCompare(y.route || '') ||
    ((x.km == null) - (y.km == null)) ||
    (x.km || 0) - (y.km || 0) ||
    x.asset_no.localeCompare(y.asset_no, undefined, { numeric: true }));

  const counts = { never: 0, overdue: 0, due: 0, ok: 0 };
  for (const r of rows) counts[r.state]++;
  const outstanding = counts.never + counts.overdue + counts.due;

  return {
    programme: programmeName, standard: prog.standard, cycle: prog.cycle, type: prog.type,
    year, total: rows.length, outstanding, counts, excluded,
    noCoordinates: rows.filter(r => !r.locatable).length,
    noDivision: rows.filter(r => !r.division).length,
    rows,
  };
}

// ── Who may do what ──────────────────────────────────────────────────────────
// Reading a worklist and FILING an inspection are both part of doing the job, so any
// signed-in person with Assets access may do either — the record is attested from
// the validated session, so it always names who really filed it. Changing an
// inspection after the fact is the privileged action.
// ⚠️ Assets Role offers Admin · Manager · User only (no Patroller/Supervisor), so a
// field inspector IS a 'User'. Gating filing on Admin/Manager would lock out exactly
// the people who do the work. Flagged in the feature doc for Troy to confirm.
const EDIT_ROLES = ['Admin', 'Owner', 'Manager'];
const canEdit = caller => EDIT_ROLES.includes(str(caller.role));

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Guard BEFORE the try, so a 401/403 is never swallowed by the catch and reported
  // as a 500 (working-agreement.md §2b).
  if (!PAT) return res.status(500).json({ error: 'Inspections API is not configured (no PAT).' });
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const caller = await getCaller(req);
  if (!caller || !caller.allowed) return res.status(401).json({ error: 'Not signed in.' });

  const q = req.query || {};
  const has = k => Object.prototype.hasOwnProperty.call(q, k);
  const force = has('fresh');
  const thisYear = new Date().getUTCFullYear();

  try {
    if (req.method === 'POST') return await handlePost(req, res, caller);

    // ── criteria ────────────────────────────────────────────────────────────
    if (has('criteria')) {
      const want = str(q.criteria);
      if (!want) return res.status(400).json({ error: 'criteria= was supplied but empty. Name a standard, e.g. criteria=OMM 303.' });
      const all = await loadCriteria(force);
      const rows = all.filter(c => c.standard.toLowerCase() === want.toLowerCase());
      if (!rows.length) {
        return res.status(404).json({ error: `No criteria on file for "${want}".`,
          standards: [...new Set(all.map(c => c.standard))].sort() });
      }
      res.setHeader('Cache-Control', force ? 'no-store' : 'public, max-age=300');
      return res.status(200).json({ standard: want, standard_title: rows[0].standard_title, count: rows.length, criteria: rows });
    }

    // ── worklist ────────────────────────────────────────────────────────────
    if (has('worklist')) {
      const want = str(q.worklist);
      if (!want) return res.status(400).json({ error: 'worklist= was supplied but empty. Name a programme or an asset type.' });
      const programmeName = PROGRAMME[want] ? want : TYPE_PROGRAMME[want];
      if (!programmeName) {
        return res.status(400).json({ error: `"${want}" is not a known programme or asset type.`,
          programmes: Object.keys(PROGRAMME), types: Object.keys(TYPE_PROGRAMME) });
      }
      const year = int(q.year) || thisYear;
      const out = await buildWorklist(programmeName, year, force);
      res.setHeader('Cache-Control', force ? 'no-store' : 'public, max-age=60');
      return res.status(200).json(out);
    }

    // ── one asset's history ─────────────────────────────────────────────────
    if (has('asset') || has('rec')) {
      const wantId = str(q.asset), wantRec = str(q.rec);
      if (has('asset') && !wantId) return res.status(400).json({ error: 'asset= was supplied but empty. Refusing to return every inspection.' });
      if (has('rec') && !wantRec)  return res.status(400).json({ error: 'rec= was supplied but empty.' });

      const assets = await loadAssets(force);
      // Address by RECORD id when given one: 101 asset_id values are shared by more
      // than one record, so the business key is a join, not an address
      // (claude/assets-record-id-addressing.md).
      const asset = wantRec ? assets.find(a => a.recId === wantRec) : null;
      const key = asset ? asset.asset_id : wantId;
      if (wantRec && !asset) return res.status(404).json({ error: 'Asset not found.' });

      const shared = assets.filter(a => a.asset_id === key);
      const rows = (await loadInspections(force))
        .filter(i => i.asset_id === key)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

      const prog = asset ? PROGRAMME[TYPE_PROGRAMME[asset.type]] : null;
      const last = latestFor(rows);
      const nextDue = last ? (last.next_due != null ? last.next_due : (yearOf(last.date) + (prog ? prog.years : 2))) : null;

      res.setHeader('Cache-Control', force ? 'no-store' : 'public, max-age=60');
      return res.status(200).json({
        asset_id: key,
        asset: asset || null,
        sharedIds: shared.length > 1 ? shared.map(a => ({ recId: a.recId, name: a.name })) : undefined,
        thisYear,
        count: rows.length,
        lastDate: last ? last.date : null,
        nextDue,
        state: stateFor(nextDue, thisYear),
        inspections: rows,
      });
    }

    // ── summary ─────────────────────────────────────────────────────────────
    if (has('summary')) {
      const programmeName = str(q.programme);
      const rows = (await loadInspections(force))
        .filter(i => !programmeName || i.programme === programmeName);
      const byAsset = {};
      for (const r of rows) {
        if (!r.asset_id) continue;
        const e = byAsset[r.asset_id] || (byAsset[r.asset_id] = { count: 0, lastYear: null, nextDue: null });
        e.count++;
        if (r.year != null && (e.lastYear == null || r.year > e.lastYear)) { e.lastYear = r.year; e.nextDue = r.next_due; }
      }
      for (const e of Object.values(byAsset)) e.state = stateFor(e.nextDue, thisYear);
      res.setHeader('Cache-Control', force ? 'no-store' : 'public, max-age=60');
      return res.status(200).json({ total: rows.length, assets: Object.keys(byAsset).length, thisYear, byAsset });
    }

    return res.status(400).json({
      error: 'Say what you want: ?worklist=<programme|type>, ?asset=<asset_id>, ?rec=<recId>, ?criteria=<standard>, or ?summary=1.',
      programmes: Object.keys(PROGRAMME),
    });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Inspections lookup failed.' });
  }
};

// ── Filing an inspection ─────────────────────────────────────────────────────
async function handlePost(req, res, caller) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  const programmeName = str(body.programme);
  const prog = PROGRAMME[programmeName];
  if (!prog) {
    return res.status(400).json({ error: `"${programmeName}" is not a known programme.`, programmes: Object.keys(PROGRAMME) });
  }

  const scope = str(body.scope) || 'Asset';
  if (scope !== 'Asset' && scope !== 'Segment') {
    return res.status(400).json({ error: 'scope must be "Asset" or "Segment".' });
  }

  const date = str(body.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date is required, as YYYY-MM-DD.' });
  const year = yearOf(date);

  // Resolve the asset FRESH, never from the cache: a worklist five minutes old must
  // not decide what a write attaches to.
  let asset = null;
  if (scope === 'Asset') {
    const wantRec = str(body.rec), wantId = str(body.asset_id);
    if (!wantRec && !wantId) return res.status(400).json({ error: 'An asset inspection needs rec or asset_id.' });
    const assets = await loadAssets(true);
    if (wantRec) {
      asset = assets.find(a => a.recId === wantRec) || null;
      if (!asset) return res.status(404).json({ error: 'Asset not found.' });
    } else {
      const hits = assets.filter(a => a.asset_id === wantId);
      if (!hits.length) return res.status(404).json({ error: 'Asset not found.' });
      // Refuse an ambiguous save rather than writing to "probably the right one" —
      // the mistake that put edits on the wrong barrier wall for weeks.
      if (hits.length > 1) {
        return res.status(409).json({
          error: `asset_id "${wantId}" is shared by ${hits.length} records. Send rec to say which.`,
          records: hits.map(a => ({ recId: a.recId, name: a.name })),
        });
      }
      asset = hits[0];
    }
    if (asset.type !== prog.type) {
      return res.status(400).json({ error: `The ${programmeName} programme inspects ${prog.type}, but that asset is a ${asset.type || 'no type'}.` });
    }
  }

  // Grade the checks against the criteria library, not against whatever the client
  // sent: a client that invents a check_ref, or a threshold, must not be able to
  // write it into the record.
  const criteria = await loadCriteria(true);
  const forStandard = criteria.filter(c => c.standard === prog.standard);
  const byRef = new Map(forStandard.map(c => [c.check_ref, c]));

  const submitted = Array.isArray(body.checks) ? body.checks : [];
  const unknown = submitted.map(c => str(c.check_ref)).filter(r => r && !byRef.has(r));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown check(s) for ${prog.standard}: ${unknown.join(', ')}`,
      expected: forStandard.map(c => c.check_ref) });
  }

  const failures = submitted.filter(c => /^fail$/i.test(str(c.state)));
  const nas      = submitted.filter(c => /^n\/?a$|^not applicable$/i.test(str(c.state)));
  const graded   = submitted.filter(c => str(c.state)).length;

  const noAccess = /^not inspected/i.test(str(body.result));
  let result = str(body.result);
  if (!result) result = failures.length ? 'Deficiency' : 'Pass';

  // A Pass that graded nothing is an assertion, not an inspection. checks_total is
  // what makes the difference visible, so refuse the empty-form pass outright.
  if (!noAccess && result === 'Pass' && graded === 0) {
    return res.status(400).json({ error: 'A Pass needs the checks to have been graded. Nothing was submitted.',
      expected: forStandard.map(c => ({ check_ref: c.check_ref, defect: c.defect })) });
  }

  // "Not inspected - no access" must NOT clear the due date: the obligation stands.
  const nextDue = noAccess ? (int(body.next_due) || year) : year + prog.years;
  const nextDueDate = (() => {
    if (noAccess) return null;
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCFullYear(d.getUTCFullYear() + prog.years);
    return d.toISOString().slice(0, 10);
  })();

  const seq = Date.now().toString(36).slice(-5).toUpperCase();
  const code = (prog.type || 'AS').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
  const inspectionId = `AI-${year}-${code}-${seq}`;

  const fields = {
    inspection_id: inspectionId,
    programme: programmeName,
    standard: prog.standard,
    cycle: prog.cycle,
    scope,
    date, year,
    next_due: nextDue,
    result,
    deficiencies_found: failures.length ? 'Yes' : 'No',
    checks_total: graded,
    checks_failed: failures.length,
    description: str(body.description),
    // Attested from the validated session, never from the body — a client politely
    // sending its own name is a client that can send anyone's.
    inspector: str(caller.user && caller.user.name),
    inspector_email: str(caller.user && caller.user.email),
    source: 'Inspections app',
    added_by: str(caller.user && caller.user.name),
    added_at: new Date().toISOString(),
  };
  if (nextDueDate) fields.next_due_date = nextDueDate;
  if (str(body.photo_url)) fields.photo_url = str(body.photo_url);
  if (num(body.gps_lat) != null) fields.gps_lat = num(body.gps_lat);
  if (num(body.gps_lng) != null) fields.gps_lng = num(body.gps_lng);

  if (asset) {
    fields.asset = [asset.recId];
    fields.asset_id = asset.asset_id;
    fields.asset_no = asset.name || asset.asset_ref || asset.asset_id;
    fields.asset_type = asset.type;
    if (asset.route) fields.route = asset.route;
    if (asset.km != null) fields.km = asset.km;
    if (asset.direction) fields.direction = asset.direction;
    const div = divisionFor(asset);
    if (div) fields.division = div;
  } else {
    if (str(body.route)) fields.route = str(body.route);
    if (num(body.km) != null) fields.km = num(body.km);
    if (num(body.km_end) != null) fields.km_end = num(body.km_end);
    if (str(body.direction)) fields.direction = str(body.direction);
    if (str(body.asset_no)) fields.asset_no = str(body.asset_no);
  }

  const created = await airtableWrite(encodeURIComponent(T_INSPECTION), 'POST',
    { records: [{ fields }], returnFieldsByFieldId: false });
  const insp = created.records && created.records[0];
  if (!insp) return res.status(502).json({ error: 'Airtable accepted the inspection but returned no record.' });

  // Findings are a SECOND write, so a failure here must not lose the inspection —
  // it is reported as findingsError, the same shape assets.js uses for detailError,
  // and the client surfaces it rather than redirecting as if all were well.
  let findings = [];
  let findingsError = null;
  const toFile = [...failures, ...nas];
  if (toFile.length) {
    const records = toFile.map(c => {
      const crit = byRef.get(str(c.check_ref));
      const isFail = /^fail$/i.test(str(c.state));
      const f = {
        finding_id: `${inspectionId}-${crit.check_ref}`,
        inspection: [insp.id],
        asset_id: fields.asset_id || '',
        standard: prog.standard,
        check_ref: crit.check_ref,
        clause: crit.clause,
        defect: crit.defect,
        // Copied from the criterion at write time so a later revision of the library
        // cannot rewrite what this inspection actually recorded.
        threshold: crit.threshold,
        state: isFail ? 'Fail' : 'Not applicable',
        notes: str(c.notes),
        status: isFail ? 'Open' : 'Cancelled',
        added_by: str(caller.user && caller.user.name),
        added_at: new Date().toISOString(),
      };
      if (asset) f.asset = [asset.recId];
      if (str(c.photo_url)) f.photo_url = str(c.photo_url);
      if (isFail) {
        f.severity = /^non-?conformance$/i.test(str(c.severity)) ? 'Non-conformance' : 'Deficiency';
        const by = correctBy(crit.deadline_rule, date);
        if (by) f.correct_by = by;
      }
      return { fields: f };
    });
    try {
      const out = [];
      for (let i = 0; i < records.length; i += 10) {
        const chunk = await airtableWrite(encodeURIComponent(T_FINDING), 'POST',
          { records: records.slice(i, i + 10), returnFieldsByFieldId: false });
        out.push(...(chunk.records || []));
      }
      findings = out.map(r => ({ recId: r.id, finding_id: r.fields && r.fields.finding_id }));
    } catch (e) {
      findingsError = e.message || 'The findings could not be saved.';
    }
  }

  fresh();
  return res.status(201).json({
    ok: true,
    inspection: { recId: insp.id, inspection_id: inspectionId, result, next_due: nextDue,
                  next_due_date: nextDueDate, checks_total: graded, checks_failed: failures.length },
    findings,
    findingsError,
  });
}

module.exports.__test = {
  stateFor, latestFor, divisionFor, correctBy, responsibilityOf, yearOf,
  PROGRAMME, TYPE_PROGRAMME, DETAIL_TABLE, buildWorklist, canEdit,
};
