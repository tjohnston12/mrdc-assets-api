// api/assets.js — mrdc-assets-api (Vercel)  ·  https://assets.mrdc-htra.com/api/assets
// Shared read-only asset register for the whole MRDC HTRA program. Serves the
// register (base app0sXrUbOBr7a6vV — the source the Daily Road Patrol app uses) to
// every consumer: Quality audit forms (GPS/manual matching), DMT intake (asset
// lookup by id → route/km/lat/lng), asset inspections, and other reporting.
// Read-only, no external dependencies. Access is limited by CORS to *.mrdc-htra.com
// and *.vercel.app origins; server-to-server callers (no Origin header) are allowed.
// NO external dependencies.
//
// Returns: [{ id, name, category, lat, lng }, ...]
//
// Env vars:
//   AIRTABLE_PAT          a token with READ access to the asset base below
//                         (the Quality PAT works ONLY if its scope includes this base —
//                          otherwise set ASSETS_PAT to a token that can read it)
//   ASSETS_PAT            (optional) overrides AIRTABLE_PAT just for this endpoint
//   ASSETS_BASE           default 'app0sXrUbOBr7a6vV'   (the asset register base)
//   ASSETS_TABLE          default 'Assets'              (CONFIRM the real table name)
// Optional field-name overrides (set these if the ?debug=1 column names differ):
//   ASSET_F_ID            default 'Asset ID'   (falls back to the Airtable record id)
//   ASSET_F_NAME          default 'Name'
//   ASSET_F_CATEGORY      default 'Category'
//   ASSET_F_LAT           default 'Latitude'
//   ASSET_F_LNG           default 'Longitude'
//
// Discovering the schema (no code changes needed):
//   Deploy, then GET /api/assets?debug=1  → returns the table name and the exact
//   column names of the first record, so the field map above can be set correctly.

const PAT   = process.env.ASSETS_PAT || process.env.AIRTABLE_PAT;
const BASE  = process.env.ASSETS_BASE  || 'app0sXrUbOBr7a6vV';
const TABLE = process.env.ASSETS_TABLE || 'Assets';

const F = {
  id:       process.env.ASSET_F_ID       || 'Asset ID',
  name:     process.env.ASSET_F_NAME     || 'Name',
  category: process.env.ASSET_F_CATEGORY || 'Category',
  lat:      process.env.ASSET_F_LAT      || 'Latitude',
  lng:      process.env.ASSET_F_LNG      || 'Longitude',
  // route + km are what DMT's division routing (routing.js) needs, so the shared
  // service exposes them too. Included in output only when the columns exist.
  route:    process.env.ASSET_F_ROUTE    || 'Route',
  km:       process.env.ASSET_F_KM       || 'KM',
  // asset_ref = the human/legacy asset number (e.g. a culvert's "1-C40b"); the real
  // column is already 'asset_ref', so no env override is normally needed.
  ref:      process.env.ASSET_F_REF      || 'asset_ref',
};

// cache the register in the warm lambda (assets change rarely)
// data = mappable assets only (lat/lng present); all = every asset (for pickers)
let CACHE = { at: 0, data: null, all: null };
const TTL_MS = 5 * 60 * 1000;

async function airtable(path) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json.error?.message || json.error?.type || `Airtable ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

async function fetchAll() {
  const rows = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const page = await airtable(`${encodeURIComponent(TABLE)}?${qs}`);
    rows.push(...(page.records || []));
    offset = page.offset;
  } while (offset);
  return rows;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shape(records, includeUnmapped) {
  const out = [];
  for (const r of records) {
    const f = r.fields || {};
    const lat = num(f[F.lat]);
    const lng = num(f[F.lng]);
    if (!includeUnmapped && (lat == null || lng == null)) continue;   // map consumers need coordinates
    const asset = {
      id: f[F.id] != null && f[F.id] !== '' ? String(f[F.id]) : r.id,
      recId: r.id,                                   // Airtable record id — lets consumers deep-link the record
      name: f[F.name] != null ? String(f[F.name]) : '',
      category: f[F.category] != null ? String(f[F.category]) : '',
      lat, lng,
    };
    // route + km for DMT routing — only when present in the register
    if (f[F.route] != null && f[F.route] !== '') asset.route = String(f[F.route]);
    const km = num(f[F.km]);
    if (km != null) asset.km = km;
    if (f[F.ref] != null && f[F.ref] !== '') asset.asset_ref = String(f[F.ref]);
    out.push(asset);
  }
  return out;
}

// Per-type detail table + photo-URL field(s). The first non-blank wins. Photos live
// in the detail tables (keyed by the same asset_id), not on the Assets row itself.
const PHOTO_MAP = {
  'Sign':               { table: 'tblcRZosz76z6g2vk', fields: ['photo_url', 'photo_back_url'] },
  'Culvert':            { table: 'tblDyYac0QWCQtxQv', fields: ['photo_eb_url', 'photo_wb_url', 'photo_median_url'] },
  'Guiderail':          { table: 'tblUwHs6Im2OY7Arc', fields: ['leading_end_photo_url', 'terminating_end_photo_url'] },
  'Barrier Wall':       { table: 'tblfDzv7MlCqCDncd', fields: ['photo_url'] },
  'Wildlife Fence':     { table: 'tblW7bcJpCiSYKABl', fields: ['photo_url'] },
  'Fencing':            { table: 'tblW7bcJpCiSYKABl', fields: ['photo_url'] },
  'Gate':               { table: 'tbl5sldKignbSszJV', fields: ['photo_url'] },
  'Lighting':           { table: 'tblrEdE23o4BNtlmM', fields: ['photo_url'] },
  'Drainage Structure': { table: 'tblK2La03BWIjxVB3', fields: ['photo_url'] },
  'Structure':          { table: 'tblYM98CKDkmYhB4A', fields: ['attachment_urls'] },
};
// Look up the asset's photo from its type detail table by matching asset_id.
async function resolvePhoto(asset) {
  const map = PHOTO_MAP[asset.category];
  if (!map || !asset.id) return null;
  const formula = `{asset_id}='${String(asset.id).replace(/'/g, "\\'")}'`;
  const qs = new URLSearchParams({ maxRecords: '1', filterByFormula: formula });
  for (const f of map.fields) qs.append('fields[]', f);
  const j = await airtable(`${map.table}?${qs}`);
  const df = (j.records && j.records[0] && j.records[0].fields) || {};
  for (const f of map.fields) {
    const v = String(df[f] || '').split(/\n+/)[0].trim();   // attachment_urls may hold several
    if (v) return v;
  }
  return null;
}

// CORS: allow the platform's own origins (and Vercel previews), not the whole web.
const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)*mrdc-htra\.com$|^https:\/\/[a-z0-9-]+\.vercel\.app$/i;
function applyCors(req, res) {
  const origin = req.headers?.origin;
  // server-to-server calls (e.g. DMT intake) send no Origin — nothing to set.
  if (origin && ORIGIN_OK.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const debug = req.query?.debug === '1' || /[?&]debug=1/.test(req.url || '');

    // Schema discovery — no field map needed, reveals the real column names.
    if (debug) {
      const page = await airtable(`${encodeURIComponent(TABLE)}?pageSize=1`);
      const first = (page.records || [])[0];
      return res.status(200).json({
        base: BASE,
        table: TABLE,
        recordCount_firstPage: (page.records || []).length,
        columnNames: first ? Object.keys(first.fields || {}) : [],
        sampleRecord: first ? first.fields : null,
        currentFieldMap: F,
        note: 'Set ASSET_F_* env vars (or tell the dev) so id/name/category/lat/lng map to these columns.',
      });
    }

    // build (or reuse cached) register — shape once into mappable-only + full sets
    if (!CACHE.data || Date.now() - CACHE.at >= TTL_MS) {
      const raw = await fetchAll();
      CACHE = { at: Date.now(), data: shape(raw, false), all: shape(raw, true) };
    }
    // ?all=1 → include assets that have no lat/lng too (for asset pickers, not maps)
    const includeAll = req.query?.all === '1' || /[?&]all=1/.test(req.url || '');
    let register = includeAll ? CACHE.all : CACHE.data;

    // distinct category (asset_type) values with counts — used to map each OMM
    // standard to the asset type its audit should match against.
    const types = req.query?.types === '1' || /[?&]types=1/.test(req.url || '');
    if (types) {
      const tally = {};
      for (const a of register) {
        const k = a.category || '(blank)';
        tally[k] = (tally[k] || 0) + 1;
      }
      const list = Object.entries(tally).sort((x, y) => y[1] - x[1])
        .map(([category, count]) => ({ category, count }));
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(200).json({ total: register.length, types: list });
    }

    // single-asset lookup by id — what DMT intake calls to resolve route/km/lat/lng,
    // and what the Asset 360 page calls (it also wants a photo).
    const id = req.query?.id || (req.url.match(/[?&]id=([^&]+)/) || [])[1];
    if (id) {
      const one = register.find(a => a.id === decodeURIComponent(String(id)));
      res.setHeader('Cache-Control', 'public, max-age=300');
      if (!one) return res.status(404).json({ error: 'Asset not found', id: String(id) });
      let photo = null;
      try { photo = await resolvePhoto(one); } catch (_) { /* photo is best-effort */ }
      return res.status(200).json({ ...one, photo });
    }

    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(register);
  } catch (e) {
    console.error('assets endpoint error:', e);
    // Guide the caller toward the fix rather than a bare 500.
    const hint = e.status === 403 || e.status === 401
      ? 'The AIRTABLE_PAT (or ASSETS_PAT) does not have read access to this base. Grant it access to ' + BASE + '.'
      : e.status === 404
      ? `Base or table not found. Check ASSETS_BASE (${BASE}) and ASSETS_TABLE (${TABLE}).`
      : undefined;
    return res.status(e.status || 500).json({ error: 'Failed to load assets', detail: e.message, hint });
  }
};
