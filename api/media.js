// api/media.js — mrdc-assets-api (Vercel)  ·  https://assets.mrdc-htra.com/api/media
//
// The catalogue of drone / ground media for the asset registry. The FILES live in
// the "Asset Media" SharePoint library (claude/drone-footage-sharing.md) — this
// endpoint holds the link and the metadata, and joins each item back to the
// registry so an asset can show its own footage.
//
// It lives in this repo rather than a project of its own because the data belongs
// in the registry base app0sXrUbOBr7a6vV, which this project's PAT already reaches.
// That means no new Vercel project, domain, PAT or env var — and the auth gate,
// CORS regex and write helper are the same ones api/assets.js uses.
//
//   GET   /api/media                    list + filters
//   GET   /api/media?id=MED-…           one row
//   GET   /api/media?asset=<asset_id>   that asset's media + corridor runs covering it
//   GET   /api/media?stats=1            the dashboard tiles
//   GET   /api/media?meta=1             select choices + the directory people list
//   POST  /api/media                    create   (Assets Role Admin/Manager)
//   PATCH /api/media                    update   (Assets Role Admin/Manager)
//
// Env vars (all optional — the defaults are correct):
//   ASSETS_PAT / AIRTABLE_PAT   token with read+write on the registry base
//   ASSETS_BASE                 default 'app0sXrUbOBr7a6vV'
//   MEDIA_TABLE                 default 'Media'
//   ASSETS_TABLE                default 'Assets'
//   MEDIA_URL_HOSTS             comma-separated host suffix allowlist for `url`
//                               default 'sharepoint.com'
//   EMP_BASE / EMP_TABLE        Employees directory, for the captured_by picker
//
// NO external dependencies.

const PAT          = process.env.ASSETS_PAT || process.env.AIRTABLE_PAT;
const BASE         = process.env.ASSETS_BASE || 'app0sXrUbOBr7a6vV';
const TABLE        = process.env.MEDIA_TABLE || 'Media';
const ASSETS_TABLE = process.env.ASSETS_TABLE || 'Assets';

// The directory is a different base, so this can legitimately fail if the PAT was
// never widened to it. That is handled as a best-effort miss with an explicit
// message rather than a dead picker — the lesson from the DMT recipient picker,
// which returned a bare 403 until the error said what was actually wrong.
const EMP_BASE  = process.env.EMP_BASE  || 'appraSoUXoTbhroG6';
const EMP_TABLE = process.env.EMP_TABLE || 'tblUfWrGjHTHXszos';
const EMP_F = { name: 'fldtLjh72SJV8Uyfb', active: 'fldcHPqfxScpuUbZ6' };

// Only these hosts may be stored in `url`. Contract evidence should not end up
// behind a personal Drive or Dropbox link where the tenant's sharing controls,
// audit log and revocation do not apply.
const URL_HOSTS = (process.env.MEDIA_URL_HOSTS || 'sharepoint.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ── Airtable ────────────────────────────────────────────────────────────────

async function airtable(path, base) {
  const res = await fetch(`https://api.airtable.com/v0/${base || BASE}/${path}`, {
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

async function airtableWrite(path, method, body) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    // NOTE: returnFieldsByFieldId belongs in the BODY on writes, never the query
    // string — the trap that broke the patrol app for an afternoon. This module
    // maps fields by NAME, so it does not need the flag at all.
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

async function fetchAllRows(table, base) {
  const rows = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const page = await airtable(`${encodeURIComponent(table)}?${qs}`, base);
    rows.push(...(page.records || []));
    offset = page.offset;
  } while (offset);
  return rows;
}

// Escape a value for use inside an Airtable formula string literal.
function lit(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// ── Shaping ─────────────────────────────────────────────────────────────────

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v) {
  if (v == null) return '';
  if (typeof v === 'object' && v.name) return String(v.name);
  return String(v);
}

function shape(r) {
  const f = r.fields || {};
  return {
    media_id:       str(f.media_id),
    recId:          r.id,
    title:          str(f.title),
    media_type:     str(f.media_type),
    capture_method: str(f.capture_method),
    scope:          str(f.scope),
    asset_id:       str(f.asset_id),
    route:          str(f.route),
    km_start:       num(f.km_start),
    km_end:         num(f.km_end),
    direction:      str(f.direction),
    date_captured:  str(f.date_captured),
    captured_by:    str(f.captured_by),
    url:            str(f.url),
    notes:          str(f.notes),
    related_nc:     str(f.related_nc),
    related_wo:     str(f.related_wo),
    status:         str(f.status) || 'Active',
    added_by:       str(f.added_by),
    added_at:       str(f.added_at),
  };
}

// The catalogue is small (hundreds of rows, not thousands) so it is fetched whole
// and filtered in JS. That is deliberate: every filter below would otherwise be a
// hand-built filterByFormula string, which is where quoting and escaping bugs
// live. Refetching is cheap and the result is cached in the warm lambda.
let CACHE = { at: 0, rows: null };
const TTL_MS = 60 * 1000;

async function allMedia(force) {
  if (!force && CACHE.rows && Date.now() - CACHE.at < TTL_MS) return CACHE.rows;
  const rows = (await fetchAllRows(TABLE)).map(shape);
  CACHE = { at: Date.now(), rows };
  return rows;
}

function invalidate() { CACHE = { at: 0, rows: null }; }

// ── The corridor join ───────────────────────────────────────────────────────
// An asset-scoped row belongs to exactly one asset. A corridor row covers a km
// range and may cover many assets or none — which is the whole reason `scope`
// exists rather than everything being crammed into asset_id, where it would
// either be lost or corrupt the foreign key the other apps federate on.
//
// Direction is deliberately NOT part of the match. A run recorded EB still shows
// the same stretch of road as a WB asset, and excluding it would hide relevant
// footage. The row carries its direction so the reader can judge.
function coversAsset(row, asset) {
  if (row.scope !== 'Corridor') return false;
  if (!row.route || !asset.route || row.route !== asset.route) return false;
  if (asset.km == null || row.km_start == null) return false;
  const end = row.km_end == null ? row.km_start : row.km_end;
  const lo = Math.min(row.km_start, end);
  const hi = Math.max(row.km_start, end);
  return asset.km >= lo && asset.km <= hi;
}

async function lookupAsset(assetId) {
  const qs = new URLSearchParams({
    filterByFormula: `{asset_id}=${lit(assetId)}`,
    pageSize: '1',
  });
  const page = await airtable(`${encodeURIComponent(ASSETS_TABLE)}?${qs}`);
  const rec = (page.records || [])[0];
  if (!rec) return null;
  const f = rec.fields || {};
  return {
    asset_id: str(f.asset_id),
    name:     str(f.name),
    type:     str(f.asset_type),
    route:    str(f.route),
    km:       num(f.km_start),
    km_end:   num(f.km_end),
  };
}

// ── Stats ───────────────────────────────────────────────────────────────────

// Merge overlapping km ranges per route before summing, so two passes over the
// same stretch are not counted as twice the coverage.
function coveredKm(rows) {
  const byRoute = new Map();
  for (const r of rows) {
    if (r.scope !== 'Corridor' || !r.route || r.km_start == null) continue;
    const end = r.km_end == null ? r.km_start : r.km_end;
    const lo = Math.min(r.km_start, end);
    const hi = Math.max(r.km_start, end);
    if (hi <= lo) continue;
    if (!byRoute.has(r.route)) byRoute.set(r.route, []);
    byRoute.get(r.route).push([lo, hi]);
  }
  let total = 0;
  for (const spans of byRoute.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let [cs, ce] = spans[0];
    for (let i = 1; i < spans.length; i++) {
      const [s, e] = spans[i];
      if (s <= ce) { ce = Math.max(ce, e); continue; }
      total += ce - cs;
      cs = s; ce = e;
    }
    total += ce - cs;
  }
  return Math.round(total * 1000) / 1000;
}

function buildStats(rows) {
  const live = rows.filter(r => r.status !== 'Archived');
  const year = String(new Date().getFullYear());
  return {
    total:      live.length,
    thisYear:   live.filter(r => (r.date_captured || '').startsWith(year)).length,
    assets:     new Set(live.filter(r => r.asset_id).map(r => r.asset_id)).size,
    coveredKm:  coveredKm(live),
    unlinked:   live.filter(r => !r.asset_id && !r.route).length,
    archived:   rows.length - live.length,
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

// Identity arrives as x-user-* headers set by the page once htra-auth resolves the
// session. Same gate as api/assets.js — this app reuses the Assets Role rather
// than adding a parallel one.
//   !! Those headers are SPOOFABLE (working-agreement.md §7). This is a rollout
//   gate, not a security boundary.
function canEdit(req) {
  const role    = String(req.headers['x-user-role'] || '');
  const appRole = String(req.headers['x-app-role']  || '');
  return role === 'Owner' || role === 'Admin' || appRole === 'Admin' || appRole === 'Manager';
}

const WRITABLE = new Set([
  'title', 'media_type', 'capture_method', 'scope', 'asset_id', 'route',
  'km_start', 'km_end', 'direction', 'date_captured', 'captured_by', 'url',
  'notes', 'related_nc', 'related_wo', 'status',
]);
const NUMERIC = new Set(['km_start', 'km_end']);
// media_id is the key the row is addressed by; added_by/added_at are provenance.
// A submitted change to any of them is dropped AND named back to the caller, the
// way the Assets PATCH reports `rejected` — silently ignoring input is how a user
// comes to believe a field saved when it did not.
const LOCKED = new Set(['media_id', 'added_by', 'added_at', 'recId', 'id']);

function cleanWrite(input) {
  const out = {}, rejected = [];
  for (const [k, v] of Object.entries(input || {})) {
    if (LOCKED.has(k)) { rejected.push(k); continue; }
    if (!WRITABLE.has(k)) { rejected.push(k); continue; }
    if (v === '' || v === null) { out[k] = null; continue; }   // an explicit clear
    if (NUMERIC.has(k)) {
      const n = Number(v);
      if (!Number.isFinite(n)) { rejected.push(k); continue; }
      out[k] = n;
      continue;
    }
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return { fields: out, rejected };
}

function urlProblem(u) {
  let parsed;
  try { parsed = new URL(String(u)); } catch (_) { return 'That is not a valid URL.'; }
  if (parsed.protocol !== 'https:') return 'The link must be https.';
  const host = parsed.hostname.toLowerCase();
  const ok = URL_HOSTS.some(h => host === h || host.endsWith('.' + h));
  if (!ok) {
    return `Only links on ${URL_HOSTS.join(', ')} are accepted, so the footage stays where the sharing controls apply. Upload it to the Asset Media library and share from there.`;
  }
  return null;
}

// MED-YYYYMMDD-NNN, sequential within the capture date. Generated server-side so
// it cannot be forged or typo'd, the same reasoning as the MVA number.
async function nextMediaId(dateStr, rows) {
  const day = (dateStr || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const prefix = `MED-${day}-`;
  let n = 0;
  for (const r of rows) {
    if (!r.media_id || !r.media_id.startsWith(prefix)) continue;
    const seq = parseInt(r.media_id.slice(prefix.length), 10);
    if (Number.isFinite(seq) && seq > n) n = seq;
  }
  return `${prefix}${String(n + 1).padStart(3, '0')}`;
}

function validateForSave(fields, isCreate, existing) {
  const merged = Object.assign({}, existing || {}, fields);
  const problems = [];
  if (isCreate) {
    if (!merged.title)         problems.push('A title is required.');
    if (!merged.url)           problems.push('A SharePoint link is required.');
    if (!merged.date_captured) problems.push('The capture date is required.');
    if (!merged.scope)         problems.push('Choose whether this covers one asset or a corridor.');
  }
  if (merged.scope === 'Asset' && !merged.asset_id) {
    problems.push('An asset-scoped item needs an asset ID.');
  }
  if (merged.scope === 'Corridor') {
    if (!merged.route)            problems.push('A corridor run needs a route.');
    if (merged.km_start == null)  problems.push('A corridor run needs a start km.');
    // Not fatal, but a run with no end km can never match an asset, which is the
    // main reason to file it. Say so rather than letting it sit there inert.
    if (merged.km_end == null)    problems.push('A corridor run needs an end km, or it will never match an asset.');
  }
  if (fields.url) {
    const p = urlProblem(fields.url);
    if (p) problems.push(p);
  }
  return problems;
}

async function handleWrite(req, res, method) {
  if (!canEdit(req)) {
    return res.status(403).json({ error: 'You do not have rights to file media. Ask an Assets Admin or Manager.' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Expected a JSON body.' });

  const actor = String(req.headers['x-user-name'] || '').trim() || 'unknown';
  const { fields, rejected } = cleanWrite(body.fields || body);

  try {
    // An asset_id that matches nothing is a broken federation key that fails
    // SILENTLY — the row saves, and the asset's panel simply never shows it. Same
    // family as the typo'd email that Resend suppressed without an error. Cheap to
    // check, so check it — but only AFTER the cheap local validation, so a payload
    // with two problems reports the one the user can act on first, and an invalid
    // request costs no network call.
    const checkAsset = async () => {
      if (!fields.asset_id) return null;
      const found = await lookupAsset(fields.asset_id);
      if (found) return null;
      return `No asset in the registry has the id "${fields.asset_id}". Check it on the Assets app — a media row pointing at a non-existent asset would never appear on any asset page.`;
    };

    if (method === 'POST') {
      const problems = validateForSave(fields, true, null);
      if (problems.length) return res.status(400).json({ error: problems.join(' '), rejected });
      const assetProblem = await checkAsset();
      if (assetProblem) return res.status(400).json({ error: assetProblem, rejected });

      const rows = await allMedia(true);
      let mediaId = await nextMediaId(fields.date_captured, rows);
      // Two creates in the same second would otherwise collide. Cheap to guard.
      const taken = new Set(rows.map(r => r.media_id));
      let guard = 0;
      while (taken.has(mediaId) && guard++ < 20) {
        const m = mediaId.match(/^(MED-\d{8}-)(\d+)$/);
        mediaId = `${m[1]}${String(parseInt(m[2], 10) + 1).padStart(3, '0')}`;
      }

      fields.media_id = mediaId;
      fields.added_by = actor;
      fields.added_at = new Date().toISOString();
      if (!fields.status) fields.status = 'Active';

      // No typecast: a select value that is not a real choice should be refused,
      // not silently created.
      const created = await airtableWrite(encodeURIComponent(TABLE), 'POST', {
        records: [{ fields }],
      });
      invalidate();
      return res.status(200).json({
        ok: true,
        media: shape(created.records[0]),
        rejected,
      });
    }

    // PATCH — the row is resolved server-side from media_id, never from a
    // client-supplied record id, so a tampered payload cannot address a row the
    // user never opened.
    const mediaId = String(body.media_id || body.id || '').trim();
    if (!mediaId) return res.status(400).json({ error: 'media_id is required.' });

    const rows = await allMedia(true);
    const existing = rows.find(r => r.media_id === mediaId);
    if (!existing) return res.status(404).json({ error: `No media found with id ${mediaId}.`, rejected });

    if (!Object.keys(fields).length) {
      return res.status(400).json({ error: 'Nothing to update.', rejected });
    }
    const problems = validateForSave(fields, false, existing);
    if (problems.length) return res.status(400).json({ error: problems.join(' '), rejected });
    const assetProblem = await checkAsset();
    if (assetProblem) return res.status(400).json({ error: assetProblem, rejected });

    const updated = await airtableWrite(`${encodeURIComponent(TABLE)}/${existing.recId}`, 'PATCH', { fields });
    invalidate();
    return res.status(200).json({ ok: true, media: shape(updated), rejected });

  } catch (e) {
    console.error('media write error:', e);
    const status = e.status || 500;
    let hint = e.message || 'Write failed.';
    if (status === 403) {
      hint = 'Airtable refused the write — the assets PAT needs data.records:write on the registry base app0sXrUbOBr7a6vV.';
    } else if (status === 422) {
      hint = 'Airtable rejected a value — most likely a select option that does not exist.';
    }
    return res.status(status).json({ error: hint, rejected });
  }
}

// ── The directory, for the captured_by picker ───────────────────────────────

async function people() {
  const rows = await fetchAllRows(EMP_TABLE, EMP_BASE);
  const out = [];
  for (const r of rows) {
    const f = r.fields || {};
    const name = str(f[EMP_F.name] ?? f['Name']);
    const active = f[EMP_F.active] ?? f['Active'];
    if (!name) continue;
    if (String(active || '').toLowerCase() === 'inactive') continue;
    out.push(name);
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

// ── CORS ────────────────────────────────────────────────────────────────────
// Same allowlist as api/assets.js — the platform's own origins and Vercel
// previews, not the whole web. POST is added here because this endpoint creates.
const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)*mrdc-htra\.com$|^https:\/\/[a-z0-9-]+\.vercel\.app$/i;
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGIN_OK.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-role, x-app-role, x-user-id, x-user-name');
}

// ── Handler ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'POST')  return handleWrite(req, res, 'POST');
  if (req.method === 'PATCH') return handleWrite(req, res, 'PATCH');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!PAT) return res.status(500).json({ error: 'AIRTABLE_PAT (or ASSETS_PAT) is not set on this deployment.' });

  const qs = req.query || {};

  try {
    // ?meta=1 — everything the add/edit form needs to render.
    if (qs.meta) {
      let list = [], peopleError = null;
      try {
        list = await people();
      } catch (e) {
        // Best-effort. Say what is actually wrong instead of returning an empty
        // picker with no explanation.
        peopleError = e.status === 403
          ? 'Could not load the directory — does the assets PAT have read access to the Employees base appraSoUXoTbhroG6?'
          : `Could not load the directory — ${e.message}`;
      }
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(200).json({
        ok: true,
        choices: {
          media_type:     ['Video', 'Photo set', 'Orthomosaic', 'Other'],
          capture_method: ['Drone', 'Ground', 'Vehicle'],
          scope:          ['Asset', 'Corridor'],
          route:          ['Route 1', 'Route 2', 'Route 7', 'Route 8'],
          direction:      ['EB', 'WB', 'NB', 'SB', 'Both'],
          status:         ['Active', 'Archived'],
        },
        urlHosts: URL_HOSTS,
        people: list,
        peopleError,
      });
    }

    const rows = await allMedia();

    // ?asset= — what the Footage & media panel on the asset page calls.
    if (qs.asset) {
      const asset = await lookupAsset(String(qs.asset));
      if (!asset) return res.status(404).json({ error: `No asset found with id ${qs.asset}.` });
      const live = rows.filter(r => r.status !== 'Archived');
      const direct   = live.filter(r => r.asset_id && r.asset_id === asset.asset_id);
      const corridor = live.filter(r => coversAsset(r, asset));
      return res.status(200).json({
        ok: true,
        asset,
        direct,
        corridor,
        count: direct.length + corridor.length,
      });
    }

    if (qs.id) {
      const row = rows.find(r => r.media_id === String(qs.id));
      if (!row) return res.status(404).json({ error: `No media found with id ${qs.id}.` });
      return res.status(200).json({ ok: true, media: row });
    }

    if (qs.stats) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(200).json({ ok: true, stats: buildStats(rows) });
    }

    // List + filters.
    let out = rows;
    const want = (k) => (qs[k] == null ? '' : String(qs[k]).trim());

    if (want('status')) out = out.filter(r => r.status === want('status'));
    else                out = out.filter(r => r.status !== 'Archived');

    for (const k of ['media_type', 'capture_method', 'scope', 'route', 'direction']) {
      const v = want(k);
      if (v) out = out.filter(r => r[k] === v);
    }
    if (want('from')) out = out.filter(r => r.date_captured && r.date_captured >= want('from'));
    if (want('to'))   out = out.filter(r => r.date_captured && r.date_captured <= want('to'));
    if (want('unlinked')) out = out.filter(r => !r.asset_id && !r.route);
    if (want('q')) {
      const needle = want('q').toLowerCase();
      out = out.filter(r =>
        [r.media_id, r.title, r.asset_id, r.notes, r.captured_by, r.related_nc, r.related_wo]
          .some(v => String(v || '').toLowerCase().includes(needle)));
    }

    out.sort((a, b) => String(b.date_captured).localeCompare(String(a.date_captured))
                    || String(b.media_id).localeCompare(String(a.media_id)));

    const limit = Math.min(parseInt(want('limit'), 10) || 1000, 5000);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ ok: true, media: out.slice(0, limit), count: out.length });

  } catch (e) {
    console.error('media GET error:', e);
    return res.status(e.status || 500).json({ error: e.message || 'Request failed.' });
  }
};

// Exported for the test harness.
// Exported for the test harness. WRITABLE/LOCKED are exposed so the suite can
// prove LOCKED is load-bearing: today the two sets are disjoint, so the LOCKED
// check looks redundant, and a mutation removing it passes. It is the guard that
// still holds if someone later adds an identity field to the whitelist.
module.exports.__test = { coversAsset, coveredKm, cleanWrite, urlProblem, nextMediaId, buildStats, validateForSave, WRITABLE, LOCKED };
