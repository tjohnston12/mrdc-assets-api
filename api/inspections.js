// api/inspections.js — mrdc-assets-api (Vercel) · https://assets.mrdc-htra.com/api/inspections
//
// The asset INSPECTION record — what the OMM standards actually oblige, as opposed
// to the Quality programme's sampling audits. Reads the `Inspections` table in the
// same registry base as /api/assets, so it needs no new project, domain or PAT.
//
// Today it serves OMM 501 biennial bridge inspections (1,060 rows migrated from the
// QMS `AMEC / HILCON` tab plus the 2026-08-27 SharePoint backfill —
// claude/qms-inspections-migration.md). The table was deliberately built GENERAL,
// keyed by `standard`, so 301/303 drainage, 706/707/708 guiderail, 406 fencing and
// 702/703 lighting land here too with nothing to rebuild.
//
//   GET ?asset=<asset_id>   one asset's inspections, newest year first, grouped by year
//   GET ?summary=1          per-asset rollup: count, last year, next due, state
//   GET ?standard=OMM+501   narrows either of the above
//
// ⚠️ AN EMPTY FILTER IS AN ERROR, NOT "NO FILTER".
// On 2026-08-26 this page sent `?asset=` with nothing after it to the NC and DMT
// APIs, which read it as "unfiltered" and returned 500 non-conformances underneath
// the words "not found in the register". `?asset=` present but empty is rejected
// here with 400 rather than being quietly widened to everything.
//
// Env vars:
//   ASSETS_PAT / AIRTABLE_PAT   token with READ access to the registry base
//   ASSETS_BASE                 default 'app0sXrUbOBr7a6vV'
//   INSPECTIONS_TABLE           default 'tblOQpwrLZtyMng08'

const PAT   = process.env.ASSETS_PAT || process.env.AIRTABLE_PAT;
const BASE  = process.env.ASSETS_BASE || 'app0sXrUbOBr7a6vV';
const TABLE = process.env.INSPECTIONS_TABLE || 'tblOQpwrLZtyMng08';

const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)*mrdc-htra\.com$|^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

function applyCors(req, res) {
  const origin = req.headers?.origin;
  if (origin && ORIGIN_OK.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const TTL_MS = 5 * 60 * 1000;
let CACHE = { at: 0, rows: null };

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

const str = v => (v == null ? '' : String(v).trim());
const int = v => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

// The whole table is ~1,060 rows, so one warm-lambda cache beats a query per asset —
// the summary needs every row anyway, and the per-asset view is then a filter rather
// than a round trip.
async function allRows() {
  if (CACHE.rows && Date.now() - CACHE.at < TTL_MS) return CACHE.rows;
  const rows = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const page = await airtable(`${TABLE}?${qs}`);
    for (const rec of page.records || []) {
      const f = rec.fields || {};
      rows.push({
        recId: rec.id,
        inspection_id: str(f.inspection_id),
        asset_id:      str(f.asset_id),
        asset_name:    str(f.asset_name),
        standard:      str(f.standard),
        inspection_type: str(f.inspection_type),
        year:      int(f.year),
        date:      str(f.date) || null,
        firm:      str(f.inspection_firm),
        result:    str(f.result),
        report_url:  str(f.report_url),
        report_file: str(f.report_file),
        link_basis:  str(f.link_basis),
        next_due:    int(f.next_due),
        notes:       str(f.notes),
        source_ref:  str(f.source_ref),
      });
    }
    offset = page.offset;
  } while (offset);
  CACHE = { at: Date.now(), rows };
  return rows;
}

// ── Due state ───────────────────────────────────────────────────────────────
// `next_due` is a YEAR, because the source recorded a year and nothing finer — the
// QMS tab had no date field at all. So "overdue" is a whole-year judgement and is
// deliberately not dressed up as a date: due IN the current year is `due`, not late.
//   never    no inspection on record at all — the strongest signal on the list
//   overdue  the due year has already passed
//   due      due this calendar year
//   ok       due in a future year
function stateFor(nextDue, thisYear) {
  if (nextDue == null) return 'never';
  if (nextDue < thisYear) return 'overdue';
  if (nextDue === thisYear) return 'due';
  return 'ok';
}

// Newest first, and within a year keep a stable, meaningful order rather than
// Airtable's.
function byYearDesc(a, b) {
  if (a.year !== b.year) return (b.year || 0) - (a.year || 0);
  return String(a.inspection_id).localeCompare(String(b.inspection_id));
}

// ⚠️ next_due follows the LATEST inspection — it is NOT max(next_due) across the
// rows. A single row carrying a wrong next_due would otherwise push a structure's
// obligation years into the future and quietly clear it off the overdue list, which
// is the one number on this page anyone would act on.
function rollup(rows, thisYear) {
  const by = new Map();
  for (const r of rows) {
    if (!r.asset_id) continue;
    let e = by.get(r.asset_id);
    if (!e) by.set(r.asset_id, (e = { count: 0, lastYear: null, nextDue: null, withReport: 0,
                                      standards: new Set(), _latest: null }));
    e.count++;
    if (r.report_url) e.withReport++;
    if (r.standard) e.standards.add(r.standard);
    if (r.year != null && (e.lastYear == null || r.year > e.lastYear)) {
      e.lastYear = r.year;
      e._latest = r;
    } else if (r.year != null && r.year === e.lastYear && e._latest && byYearDesc(r, e._latest) < 0) {
      e._latest = r;                        // same year — keep the same tie-break the list uses
    }
  }
  for (const e of by.values()) {
    e.nextDue = e._latest && e._latest.next_due != null ? e._latest.next_due
              : (e.lastYear != null ? e.lastYear + 2 : null);
    e.state = stateFor(e.nextDue, thisYear);
    e.standards = [...e.standards].sort();
    delete e._latest;
  }
  return by;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!PAT) return res.status(500).json({ error: 'Inspections API is not configured (no PAT).' });

  const q = req.query || {};
  const has = k => Object.prototype.hasOwnProperty.call(q, k);
  const thisYear = new Date().getUTCFullYear();

  try {
    const standard = str(q.standard);

    if (has('summary')) {
      const rows = (await allRows()).filter(r => !standard || r.standard === standard);
      const by = rollup(rows, thisYear);
      const byAsset = {};
      for (const [id, e] of by) {
        byAsset[id] = { count: e.count, lastYear: e.lastYear, nextDue: e.nextDue,
                        state: e.state, withReport: e.withReport, standards: e.standards };
      }
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(200).json({ total: rows.length, assets: Object.keys(byAsset).length, thisYear, byAsset });
    }

    // ⚠️ present-but-empty is a 400, never a silent "everything" — see the header note.
    if (has('asset')) {
      const asset = str(q.asset);
      if (!asset) return res.status(400).json({ error: 'asset= was supplied but empty. Refusing to return every inspection.' });
      const rows = (await allRows())
        .filter(r => r.asset_id === asset && (!standard || r.standard === standard))
        .sort(byYearDesc);
      const by = rollup(rows, thisYear).get(asset) || null;
      // Grouped by year for the panel, newest first, so the client does no bucketing.
      const years = [];
      for (const r of rows) {
        const g = years[years.length - 1];
        if (g && g.year === r.year) g.rows.push(r);
        else years.push({ year: r.year, rows: [r] });
      }
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(200).json({
        asset_id: asset, thisYear,
        count: rows.length,
        lastYear: by ? by.lastYear : null,
        nextDue:  by ? by.nextDue  : null,
        state:    by ? by.state    : 'never',
        years,
      });
    }

    return res.status(400).json({
      error: 'Say what you want: ?asset=<asset_id> for one asset, or ?summary=1 for the per-asset rollup.',
    });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Inspections lookup failed.' });
  }
};

module.exports.__test = { stateFor, rollup, byYearDesc };
