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

// NOTE: these defaults are the ORIGINAL guesses and do NOT match the registry,
// whose columns are lowercase snake_case (asset_id, name, asset_type, route,
// km_start...). Production works because every ASSET_F_* is set in Vercel. If one
// is ever removed the field silently reads as empty rather than erroring - check
// with ?debug=1, which prints the live column names beside the current map.
// The review fields added below default to the CORRECT registry names.
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
  // source_ref / source_system link a registry row back to the ORIGINAL Asset Database
  // record (where the real photo attachments live) — used to resolve a fresh photo.
  sourceRef: process.env.ASSET_F_SOURCEREF || 'source_ref',
  // Carried for the review view, which exists to show what is MISSING - so it
  // needs the fields a reviewer would check, not just the mappable ones.
  direction: process.env.ASSET_F_DIRECTION || 'direction',
  side:      process.env.ASSET_F_SIDE      || 'side',
  offset:    process.env.ASSET_F_OFFSET    || 'offset',
  status:    process.env.ASSET_F_STATUS    || 'status',
  intersects:process.env.ASSET_F_INTERSECTS|| 'intersecting_roads',
  editedBy:  process.env.ASSET_F_EDITEDBY  || 'last_edited_by',
  editedAt:  process.env.ASSET_F_EDITEDAT  || 'last_edited_at',
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
    if (f[F.sourceRef] != null && f[F.sourceRef] !== '') asset.source_ref = String(f[F.sourceRef]);
    for (const [key, fld] of [['direction', F.direction], ['side', F.side], ['offset', F.offset],
                              ['status', F.status], ['intersecting_roads', F.intersects]]) {
      const v = f[fld];
      if (v == null || v === '') continue;
      asset[key] = typeof v === 'object' && v.name ? String(v.name) : String(v);
    }
    out.push(asset);
  }
  return out;
}

// Photos live in the ORIGINAL Asset Database base as real attachment fields — reading
// them via the API returns a FRESH signed URL every time (the copies in the registry's
// detail tables are stale text URLs that expire). Each registry row links back via
// source_ref (= the original table's asset-no) or, for culverts, asset_ref (e.g. "1-C40b").
const ORIG_BASE = process.env.ORIG_ASSET_BASE || 'appQ9RjCAgXQt9eR2';
const ORIG_PHOTO = {
  'Sign':               { table: 'tblLAeXhFsC9cCeCo', key: 'asset no.', match: a => a.source_ref || a.id, photos: ['Photo Front', 'Photo Back'] },
  'Culvert':            { table: 'tblgSrCOw50Thp4P0', key: 'Asset No',  match: a => a.asset_ref,           photos: ['Photo - RS - EB', 'Photo - RS - WB', 'Photo - Median'] },
  'Guiderail':          { table: 'tblQeAd8m9sSktNPU', key: 'asset no.', match: a => a.source_ref || a.id, photos: ['Leading End - Photo', 'Terminating End - Photo'] },
  'Barrier Wall':       { table: 'tblrYBQIqsCkhFzWf', key: 'Name',      match: a => a.source_ref || a.id, photos: ['Leading End'] },
  'Wildlife Fence':     { table: 'tblTyJuNPEDND9pZc', key: 'Asset No.', match: a => a.source_ref || a.id, photos: ['Photo'] },
  'Fencing':            { table: 'tblTyJuNPEDND9pZc', key: 'Asset No.', match: a => a.source_ref || a.id, photos: ['Photo'] },
  'Lighting':           { table: 'tblSXhMx5QG2ZNFkB', key: 'Asset No.', match: a => a.source_ref || a.id, photos: ['New Photo', 'Photo - ApiFlash', 'Lighting Photo - Script'] },
  'Structure':          { table: 'tbl89vtRdejggeG9F', key: 'Asset No.', match: a => a.source_ref || a.id, photos: ['Photo'] },
  'Drainage Structure': { table: 'tblI0vQTViJuCADFM', key: 'Asset No.', match: a => a.source_ref || a.id, photos: ['Photo'] },
};
// First attachment's URL — prefer the 'large' thumbnail (fast, still fresh) over full size.
function attUrl(v) {
  if (!Array.isArray(v) || !v[0]) return null;
  const a = v[0];
  return (a.thumbnails && a.thumbnails.large && a.thumbnails.large.url) || a.url || null;
}
async function airtableIn(base, path) {
  const res = await fetch(`https://api.airtable.com/v0/${base}/${path}`, { headers: { Authorization: `Bearer ${PAT}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error?.message || `Airtable ${res.status}`); e.status = res.status; throw e; }
  return json;
}
// Resolve the asset's photo from the original Asset Database (fresh attachment URL).
// ── Photo source 1: the registry's own detail tables (PREFERRED) ────────────
// Each typed detail table in THIS base carries photo URL text fields. Their
// contents are of two different kinds and only one is usable:
//   · Cloudinary  (res.cloudinary.com/...)  — permanent, never expires. 309 culverts.
//   · Airtable    (v5.airtableusercontent.com/...) — a SIGNED url that EXPIRES
//     (the 1,018 Sign rows all hold links that lapsed 2026-07-17). Useless.
// So we take a registry url only when it is NOT an airtableusercontent link, and
// otherwise fall through to reading the attachment from the original base below.
// This path stays inside BASE, which the PAT can always read — no cross-base scope
// needed — so culvert photos work even if the original-base grant is missing.
const REG_PHOTO = {
  'Sign':               { table: 'tblcRZosz76z6g2vk', urls: ['photo_url', 'photo_back_url'] },
  'Culvert':            { table: 'tblDyYac0QWCQtxQv', urls: ['photo_eb_url', 'photo_wb_url', 'photo_median_url'] },
  'Guiderail':          { table: 'tblUwHs6Im2OY7Arc', urls: ['leading_end_photo_url', 'terminating_end_photo_url'] },
  'Barrier Wall':       { table: 'tblfDzv7MlCqCDncd', urls: ['photo_url'] },
  'Wildlife Fence':     { table: 'tblW7bcJpCiSYKABl', urls: ['photo_url'] },
  'Fencing':            { table: 'tblW7bcJpCiSYKABl', urls: ['photo_url'] },
  'Gate':               { table: 'tbl5sldKignbSszJV', urls: ['photo_url'] },
  'Lighting':           { table: 'tblrEdE23o4BNtlmM', urls: ['photo_url'] },
  'Structure':          { table: 'tblYM98CKDkmYhB4A', urls: ['attachment_urls'] },
  'Drainage Structure': { table: 'tblK2La03BWIjxVB3', urls: ['photo_url'] },
};
// An Airtable-signed url expires, so treat it as absent. attachment_urls is a
// multiline field, so take the first usable line.
function usableUrl(v) {
  if (!v) return null;
  for (const line of String(v).split(/[\s,]+/)) {
    const u = line.trim();
    if (/^https?:\/\//i.test(u) && !/airtableusercontent\.com/i.test(u)) return u;
  }
  return null;
}
function formulaEq(field, val) {
  return `{${field}}='${String(val).replace(/'/g, "\\'")}'`;
}
async function photoFromRegistry(asset, diag) {
  const cfg = REG_PHOTO[asset.category];
  if (!cfg) { if (diag) diag.registry = `no detail table mapped for category "${asset.category}"`; return null; }
  const qs = new URLSearchParams({ maxRecords: '1', filterByFormula: formulaEq('asset_id', asset.id) });
  for (const f of cfg.urls) qs.append('fields[]', f);
  const j = await airtable(`${cfg.table}?${qs}`);
  const df = (j.records && j.records[0] && j.records[0].fields) || {};
  if (diag) diag.registry = { table: cfg.table, matched: (j.records || []).length, values: cfg.urls.map(f => df[f] || null) };
  for (const f of cfg.urls) { const u = usableUrl(df[f]); if (u) return u; }
  return null;
}

// ── Photo source 2: a fresh attachment url from the ORIGINAL base (FALLBACK) ──
async function photoFromOriginal(asset, diag) {
  const cfg = ORIG_PHOTO[asset.category];
  if (!cfg) { if (diag) diag.original = `no table mapped for category "${asset.category}"`; return null; }
  const val = cfg.match(asset);
  if (!val) { if (diag) diag.original = 'no source_ref/asset_ref to match on'; return null; }
  const qs = new URLSearchParams({ maxRecords: '1', filterByFormula: formulaEq(cfg.key, val) });
  for (const f of cfg.photos) qs.append('fields[]', f);
  const j = await airtableIn(ORIG_BASE, `${cfg.table}?${qs}`);
  const df = (j.records && j.records[0] && j.records[0].fields) || {};
  if (diag) diag.original = { base: ORIG_BASE, table: cfg.table, key: cfg.key, value: val, matched: (j.records || []).length };
  for (const f of cfg.photos) { const u = attUrl(df[f]); if (u) return u; }
  return null;
}

// Registry first (permanent Cloudinary links, no cross-base scope needed), then
// the original base. Each source is independently best-effort: a failure in one
// must not stop the other from being tried.
async function resolvePhoto(asset, diag) {
  try {
    const u = await photoFromRegistry(asset, diag);
    if (u) { if (diag) diag.source = 'registry'; return u; }
  } catch (e) { if (diag) diag.registryError = `${e.status || ''} ${e.message}`.trim(); }
  try {
    const u = await photoFromOriginal(asset, diag);
    if (u) { if (diag) diag.source = 'original'; return u; }
  } catch (e) { if (diag) diag.originalError = `${e.status || ''} ${e.message}`.trim(); }
  if (diag && !diag.source) diag.source = null;
  return null;
}

// ── The typed detail row ────────────────────────────────────────────────────
// Every asset type has its own detail table holding the fields that only make
// sense for that type - sign_class, pipe_class, leading_end_type, bulb_watts.
// None of it was reaching the page. For a single asset we fetch the whole row and
// hand it over, so the detail view can show everything that is actually recorded.
const DETAIL_TABLE = {
  'Sign':               'tblcRZosz76z6g2vk',
  'Culvert':            'tblDyYac0QWCQtxQv',
  'Guiderail':          'tblUwHs6Im2OY7Arc',
  'Barrier Wall':       'tblfDzv7MlCqCDncd',
  'Wildlife Fence':     'tblW7bcJpCiSYKABl',
  'Fencing':            'tblW7bcJpCiSYKABl',
  'Gate':               'tbl5sldKignbSszJV',
  'Lighting':           'tblrEdE23o4BNtlmM',
  'Structure':          'tblYM98CKDkmYhB4A',
  'Drainage Structure': 'tblK2La03BWIjxVB3',
};
// Not worth showing: the join keys and the link column. Photo urls are pulled out
// separately into `photos` so the page can gallery them instead of listing raw urls.
// asset_ref / source_ref are already in the header - repeating them is noise.
const DETAIL_SKIP = new Set(['asset_id', 'asset', 'asset_ref', 'source_ref',
                             'parent_fence', 'parent_fence_asset_id']);
const isUrlField = k => /_url$|_urls$/.test(k);

// Does a detail record's link-back-to-Assets column point at this core record?
// The link column's NAME differs per detail table and is not configured anywhere,
// so find it by shape: a linked-record cell is an array of record ids (the REST API
// returns bare strings; some clients return {id,name} objects). Both are handled.
function linksToRecord(rec, recId) {
  if (!recId) return false;
  for (const v of Object.values(rec.fields || {})) {
    if (!Array.isArray(v)) continue;
    for (const x of v) {
      const id = typeof x === 'string' ? x : (x && x.id);
      if (id === recId) return true;
    }
  }
  return false;
}

// ⚠️ asset_id is NOT unique - 101 values are shared by more than one record
// (claude/asset-registry-data-audit.md). Matching a detail row on that text alone
// returned an arbitrary one, and it could belong to a DIFFERENT asset than the core
// row being rendered - the page then composited two physical assets into one view.
// The link column back to Assets IS unique, so it decides. When the text matches
// several rows and none of them link here, show NOTHING rather than the wrong asset.
async function detailRow(asset) {
  const table = DETAIL_TABLE[asset.category];
  if (!table) return null;
  const qs = new URLSearchParams({
    pageSize: '25',
    filterByFormula: `{asset_id}='${String(asset.id).replace(/'/g, "\\'")}'`,
  });
  const j = await airtable(`${table}?${qs}`);
  const recs = j.records || [];
  if (!recs.length) return null;
  const linked = recs.find(r => linksToRecord(r, asset.recId));
  // One text match and no link to contradict it is still trustworthy.
  const rec = linked || (recs.length === 1 ? recs[0] : null);
  if (!rec) return null;
  const fields = {}, photos = [];
  for (const [k, v] of Object.entries(rec.fields || {})) {
    if (DETAIL_SKIP.has(k)) continue;
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (isUrlField(k)) {
      // one field can hold several urls (Structure.attachment_urls is multiline)
      for (const part of String(v).split(/[\s,]+/)) {
        const u = usableUrl(part);
        if (u) photos.push({ label: k, url: u });
      }
      continue;
    }
    fields[k] = typeof v === 'object' && v.name ? v.name : v;
  }
  return { recId: rec.id, table, fields, photos };
}

// ── Which assets have a photo, in bulk ──────────────────────────────────────
// resolvePhoto() answers that one asset at a time, which is right for a detail
// view and useless for "show me everything with no photo". This walks the detail
// tables once and caches the set of asset_ids that have a usable photo URL.
// Built ONLY for ?audit=1 - it is ~9 extra table scans, so the normal list stays fast.
let PHOTO_INDEX = { at: 0, ids: null };
async function photoIndex() {
  if (PHOTO_INDEX.ids && Date.now() - PHOTO_INDEX.at < TTL_MS) return PHOTO_INDEX.ids;
  const ids = new Set();
  const done = new Set();
  for (const cfg of Object.values(REG_PHOTO)) {
    const sig = cfg.table + '|' + cfg.urls.join(',');
    if (done.has(sig)) continue;              // Fencing and Wildlife Fence share a table
    done.add(sig);
    let offset;
    do {
      const qs = new URLSearchParams({ pageSize: '100' });
      qs.append('fields[]', 'asset_id');
      for (const u of cfg.urls) qs.append('fields[]', u);
      if (offset) qs.set('offset', offset);
      const page = await airtable(`${cfg.table}?${qs}`);
      for (const r of page.records || []) {
        const f = r.fields || {};
        const id = f.asset_id != null ? String(f.asset_id).trim() : '';
        if (id && cfg.urls.some(u => usableUrl(f[u]))) ids.add(id);
      }
      offset = page.offset;
    } while (offset);
  }
  PHOTO_INDEX = { at: Date.now(), ids };
  return ids;
}

// What counts as "missing" for review. Kept here so the page and any future
// report agree on the definition rather than each inventing their own.
const GAPS = [
  { key: 'noCoords',    label: 'No coordinates',      test: a => a.lat == null || a.lng == null },
  { key: 'noPhoto',     label: 'No photo',            test: a => !a.hasPhoto },
  // ⚠️ Route and intersecting road are ALTERNATIVES, not both-required. An asset is
  // located either by a contract route (Routes 1/2/7/8, with a km) or by the road it
  // crosses — assets off the contract routes only ever have the latter. So a blank
  // route is only a gap when there is no intersecting road either; only BOTH blank
  // means nobody knows where the thing is.
  // Troy, 2026-08-25: "if an asset has an intersecting road listed, then not having
  // a route number is acceptable so do not list as having no route."
  { key: 'noRoute',     label: 'No route',            test: a => !a.route && !a.intersecting_roads },
  { key: 'noKm',        label: 'No km',               test: a => a.km == null },
  { key: 'noDirection', label: 'No direction',        test: a => !a.direction },
  { key: 'noRef',       label: 'No asset number',     test: a => !a.asset_ref && !a.source_ref },
  // ⚠️ Not a missing FIELD — a broken IDENTITY. Several records carry this asset_id,
  // so the register cannot say which physical asset is meant. Every app federates on
  // asset_id, so until these are distinguished, a work order or NC pointing at one of
  // them points at all of them. Troy, 2026-08-25: "set them aside in a new bucket
  // labeled needs review".
  // `dupCount` is stamped on each row by the audit branch — it needs the whole
  // register, which a per-asset test cannot see.
  { key: 'needsReview', label: 'Needs review',        test: a => (a.dupCount || 1) > 1 },
];

// Every field name that exists on a detail table, so the edit form can offer a
// field that is currently EMPTY - Airtable omits empty fields from a record, so a
// single row only tells you what happens to be filled in. Sampled rather than read
// from the schema API, which would need a scope this token may not have.
const DETAIL_FIELDS = new Map();   // table -> { at, names }
async function detailFieldNames(table) {
  const hit = DETAIL_FIELDS.get(table);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
  const names = new Set();
  let offset, seen = 0;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const page = await airtable(`${table}?${qs}`);
    for (const r of page.records || []) {
      for (const k of Object.keys(r.fields || {})) {
        if (!DETAIL_LOCKED.has(k) && !isUrlField(k)) names.add(k);
      }
      seen++;
    }
    offset = page.offset;
  } while (offset && seen < 300);            // 300 rows is plenty to see every column
  const list = [...names];
  DETAIL_FIELDS.set(table, { at: Date.now(), names: list });
  return list;
}

// Distinct values already in use for the select-style core fields. Airtable rejects
// a select value whose choice does not exist, so the edit form offers what is
// actually valid instead of letting someone type something that will 422.
function coreChoices(register) {
  const pick = k => [...new Set(register.map(a => a[k]).filter(Boolean))].sort();
  return { route: pick('route'), direction: pick('direction'), side: pick('side'), status: pick('status') };
}

// ── Writing ─────────────────────────────────────────────────────────────────
// Who may edit. Same shape as the other apps: identity arrives as x-user-* headers
// set by the page after htra-auth resolves the session.
//   !! Those headers are SPOOFABLE (working-agreement.md S7). This is a rollout
//   gate, not a security boundary. It matters more here than elsewhere because the
//   registry is the key every other app federates on - signed tokens are the real
//   fix when there is appetite for it.
function canEdit(req) {
  const role    = String(req.headers['x-user-role'] || '');
  const appRole = String(req.headers['x-app-role']  || '');
  return role === 'Owner' || role === 'Admin' || appRole === 'Admin' || appRole === 'Manager';
}

// Editable core fields. Identity and provenance are deliberately NOT here:
//   asset_id    - the foreign key every NC and work order stores as text. Changing
//                 it silently orphans them. Immutable, by design.
//   asset_ref / source_ref / source_system / unified_key - provenance back to the
//                 original record, and the join the photo fallback still uses.
// Those stay editable in Airtable by someone who understands the consequence.
const CORE_WRITABLE = new Set([
  'name', 'description', 'route', 'km_start', 'km_end', 'direction', 'side',
  'offset', 'lat', 'lng', 'status', 'intersecting_roads', 'division_override',
]);
const CORE_NUMERIC = new Set(['km_start', 'km_end', 'lat', 'lng']);
// On a detail row everything is an attribute of the asset EXCEPT the join key, the
// link column, and the photo urls (managed by the photo flow, not typed by hand).
// asset_ref and source_ref also appear on some detail tables. They are locked on
// the core record, so leaving them editable here would contradict the note the
// header shows the user - and they are provenance either way.
const DETAIL_LOCKED = new Set(['asset_id', 'asset', 'asset_ref', 'source_ref',
                               'parent_fence', 'parent_fence_asset_id']);

function cleanWrite(input, allow, numeric) {
  const out = {}, rejected = [];
  for (const [k, v] of Object.entries(input || {})) {
    if (allow && !allow.has(k)) { rejected.push(k); continue; }
    if (!allow && (DETAIL_LOCKED.has(k) || isUrlField(k))) { rejected.push(k); continue; }
    if (v === '' || v === null) { out[k] = null; continue; }   // an explicit clear
    if (numeric && numeric.has(k)) {
      const n = Number(v);
      if (!Number.isFinite(n)) { rejected.push(k); continue; }
      out[k] = n;
      continue;
    }
    out[k] = v;
  }
  return { fields: out, rejected };
}

async function airtableWrite(path, method, body) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    // NOTE: returnFieldsByFieldId belongs in the BODY on writes, never the query
    // string - the trap that broke the patrol app. Not used here at all.
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json.error?.message || json.error?.type || `Airtable ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

// CORS: allow the platform's own origins (and Vercel previews), not the whole web.
const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)*mrdc-htra\.com$|^https:\/\/[a-z0-9-]+\.vercel\.app$/i;
function applyCors(req, res) {
  const origin = req.headers?.origin;
  // server-to-server calls (e.g. DMT intake) send no Origin — nothing to set.
  if (origin && ORIGIN_OK.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-role, x-app-role, x-user-id, x-user-name');
}

async function handlePatch(req, res) {
  if (!canEdit(req)) return res.status(403).json({ error: 'You do not have edit rights for Assets.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || (!body.rec && !body.id)) return res.status(400).json({ error: 'rec (or id) is required' });

  const actor = String(req.headers['x-user-name'] || '').trim() || 'unknown';
  const stamp = new Date().toISOString();

  try {
    // Resolve the asset server-side, against the register - never by writing to a
    // record id straight off the wire. A record id that is not in the register is
    // refused, so a tampered payload still cannot address an arbitrary Airtable row.
    //
    // ⚠️ It used to resolve on body.id (an asset_id) on the theory that withholding
    // record ids was safer. It was not - the register is readable, so a record id is
    // no more secret than an asset_id - and because asset_id is NOT unique, every
    // save against a shared id landed on whichever record came first. Troy edited a
    // barrier wall three times and all three edits went to a different wall.
    if (!CACHE.all || Date.now() - CACHE.at >= TTL_MS) {
      const raw = await fetchAll();
      CACHE = { at: Date.now(), data: shape(raw, false), all: shape(raw, true) };
    }
    const asset = body.rec
      ? CACHE.all.find(a => a.recId === String(body.rec))
      : CACHE.all.find(a => a.id === String(body.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found', id: String(body.rec || body.id) });
    // Refuse an ambiguous save outright. Writing to "probably the right one" is how
    // the data got into this state; the caller must name the record.
    if (!body.rec && CACHE.all.filter(a => a.id === asset.id).length > 1) {
      return res.status(409).json({
        error: 'Several records share this asset ID. Re-open the asset and save again so the exact record is named.',
        assetId: asset.id,
        records: CACHE.all.filter(a => a.id === asset.id).map(a => ({ recId: a.recId, name: a.name })),
      });
    }

    const core = cleanWrite(body.core, CORE_WRITABLE, CORE_NUMERIC);
    const det  = cleanWrite(body.detail, null, null);
    const rejected = [...core.rejected, ...det.rejected];
    if (!Object.keys(core.fields).length && !Object.keys(det.fields).length) {
      return res.status(400).json({ error: 'Nothing to update', rejected });
    }

    // Core row. Always stamp who and when - shared master data needs attribution.
    if (Object.keys(core.fields).length) {
      core.fields[F.editedBy] = actor;
      core.fields[F.editedAt] = stamp;
      await airtableWrite(`${encodeURIComponent(TABLE)}/${asset.recId}`, 'PATCH', { fields: core.fields });
    }

    // Detail row, looked up by asset_id rather than trusting a client record id.
    let detailWritten = 0;
    if (Object.keys(det.fields).length) {
      const d = await detailRow(asset);
      if (!d) return res.status(409).json({ error: 'No detail record exists for this asset yet.', rejected });
      await airtableWrite(`${d.table}/${d.recId}`, 'PATCH', { fields: det.fields });
      detailWritten = Object.keys(det.fields).length;
    }

    CACHE = { at: 0, data: null, all: null };   // the list is now stale - force a rebuild
    PHOTO_INDEX = { at: 0, ids: null };
    return res.status(200).json({
      ok: true,
      id: asset.id,
      rec: asset.recId,
      coreWritten: Object.keys(core.fields).filter(k => k !== F.editedBy && k !== F.editedAt).length,
      detailWritten,
      rejected,
      editedBy: actor,
      editedAt: stamp,
    });
  } catch (e) {
    console.error('assets PATCH error:', e);
    const hint = e.status === 403 || e.status === 401
      ? 'The assets PAT needs data.records:write on ' + BASE + '.'
      : e.status === 422
      ? 'Airtable rejected a value - most likely a select option that does not exist yet.'
      : undefined;
    return res.status(e.status || 500).json({ error: 'Save failed', detail: e.message, hint });
  }
}

// Exported for tests: the gap definitions are the one thing the page, this API and
// any future report all have to agree on.
module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'PATCH') return handlePatch(req, res);
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

    // ?audit=1 - the review view. Same register, plus photo presence and a count
    // of what is missing, per gap and per asset type.
    const audit = req.query?.audit === '1' || /[?&]audit=1/.test(req.url || '');
    if (audit) {
      const withPhoto = await photoIndex();
      // How many records share each asset_id. Counted once, over the whole register,
      // then stamped on every row so the gap tests stay per-asset.
      const idCount = new Map();
      for (const a of register) idCount.set(a.id, (idCount.get(a.id) || 0) + 1);
      const rows = register.map(a => ({
        ...a, hasPhoto: withPhoto.has(a.id), dupCount: idCount.get(a.id) || 1,
      }));
      const totals = {}, byType = {};
      for (const g of GAPS) totals[g.key] = 0;
      for (const a of rows) {
        const t = a.category || '(blank)';
        const bt = byType[t] || (byType[t] = { total: 0 });
        bt.total++;
        for (const g of GAPS) {
          if (!g.test(a)) continue;
          totals[g.key]++;
          bt[g.key] = (bt[g.key] || 0) + 1;
        }
      }
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(200).json({
        total: rows.length,
        gaps: GAPS.map(g => ({ key: g.key, label: g.label, count: totals[g.key] })),
        byType,
        assets: rows,
      });
    }

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
    // ?rec=recXXXXXXXXXXXXXX - the ONLY unambiguous way to address an asset.
    // ?id= is kept for links made before this existed and for other apps, but
    // asset_id is not unique, so it can only ever return the first match.
    const rec = req.query?.rec || (req.url.match(/[?&]rec=([^&]+)/) || [])[1];
    const id  = req.query?.id  || (req.url.match(/[?&]id=([^&]+)/)  || [])[1];
    if (rec || id) {
      const wantRec = rec ? decodeURIComponent(String(rec)) : null;
      const wantId  = id  ? decodeURIComponent(String(id))  : null;
      const one = wantRec
        ? register.find(a => a.recId === wantRec)
        : register.find(a => a.id === wantId);
      res.setHeader('Cache-Control', 'public, max-age=300');
      if (!one) return res.status(404).json({ error: 'Asset not found', id: String(rec || id) });
      // Every record sharing this asset_id, so the page can say so out loud instead
      // of silently showing one of several. Always computed from the asset actually
      // resolved - addressing by rec must still reveal that it has siblings.
      const shared = register.filter(a => a.id === one.id);
      const duplicates = shared.length > 1
        ? shared.map(a => ({ recId: a.recId, name: a.name, route: a.route || null }))
        : null;
      // ?photodebug=1 surfaces WHY a photo is missing (403 vs no match vs empty
      // field) instead of swallowing it — the errors here are otherwise invisible.
      const wantPhotoDebug = req.query?.photodebug === '1' || /[?&]photodebug=1/.test(req.url || '');
      const diag = wantPhotoDebug ? {} : null;
      let photo = null;
      // The hero photo is matched in the ORIGINAL base, where there is no link column
      // to disambiguate with - so on a shared asset_id it can only guess. Skip it and
      // let the detail row's own photo_url speak, which IS record-specific.
      if (!duplicates) {
        try { photo = await resolvePhoto(one, diag); } catch (_) { /* photo is best-effort */ }
      }
      // The typed detail row, so the page can show every recorded field rather than
      // just location. Best-effort: a failure here must not lose the asset itself.
      let detail = null;
      try { detail = await detailRow(one); } catch (_) { /* detail is best-effort */ }
      const photos = detail ? detail.photos : [];
      // The hero photo first, then any others, de-duplicated.
      const gallery = [];
      for (const u of [photo, ...photos.map(p => p.url)]) if (u && !gallery.includes(u)) gallery.push(u);
      // `available` lets the edit form show fields that are currently empty.
      let available = [];
      if (detail) { try { available = await detailFieldNames(detail.table); } catch (_) {} }
      return res.status(200).json({
        ...one,
        photo,
        photos: gallery,
        detail: detail ? { recId: detail.recId, table: detail.table, fields: detail.fields, available } : null,
        choices: coreChoices(register),
        ...(duplicates ? { duplicates } : {}),
        ...(diag ? { photoDebug: diag } : {}),
      });
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

module.exports.__test = { GAPS, linksToRecord };
