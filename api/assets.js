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
};

// cache the register in the warm lambda (assets change rarely)
let CACHE = { at: 0, data: null };
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

function shape(records) {
  const out = [];
  for (const r of records) {
    const f = r.fields || {};
    const lat = num(f[F.lat]);
    const lng = num(f[F.lng]);
    if (lat == null || lng == null) continue;       // must be mappable
    const asset = {
      id: f[F.id] != null && f[F.id] !== '' ? String(f[F.id]) : r.id,
      name: f[F.name] != null ? String(f[F.name]) : '',
      category: f[F.category] != null ? String(f[F.category]) : '',
      lat, lng,
    };
    // route + km for DMT routing — only when present in the register
    if (f[F.route] != null && f[F.route] !== '') asset.route = String(f[F.route]);
    const km = num(f[F.km]);
    if (km != null) asset.km = km;
    out.push(asset);
  }
  return out;
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

    // build (or reuse cached) register
    let register = CACHE.data && Date.now() - CACHE.at < TTL_MS ? CACHE.data : null;
    if (!register) {
      register = shape(await fetchAll());
      CACHE = { at: Date.now(), data: register };
    }

    // single-asset lookup by id — what DMT intake calls to resolve route/km/lat/lng.
    const id = req.query?.id || (req.url.match(/[?&]id=([^&]+)/) || [])[1];
    if (id) {
      const one = register.find(a => a.id === decodeURIComponent(String(id)));
      res.setHeader('Cache-Control', 'public, max-age=300');
      return one ? res.status(200).json(one)
                 : res.status(404).json({ error: 'Asset not found', id: String(id) });
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
