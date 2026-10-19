// api/asset-documents.js — mrdc-assets-api (Vercel) · https://assets.mrdc-htra.com/api/asset-documents
//
// Documents filed against an asset — work sheets, inspection reports, drawings and so on
// (Troy, 2026-10-19: "add a field to the assets so that documents can be uploaded to each
// asset (structures first) such as work sheets and so on, they will be uploaded by Carlos").
// His choices: stored in AIRTABLE (private, nothing new to set up); uploaded and removed by
// Assets editors (Assets Role Admin / Manager, Owner, org Admin — the same `canEdit` as
// editing an asset); seen by everyone with Assets access.
//
// Table `Asset Documents` tblrPv20XR3B696CB in the registry base. Keyed by the Assets
// RECORD id (`asset_rec`), never by asset_id — 101 asset_ids are shared by more than one
// record, and a document filed against one twin must not show on the other.
//
//   GET    ?asset_rec=recXXX               the asset's documents, newest first (removed ones left out)
//   POST   ?asset_rec=recXXX&doc_type=…&title=…&doc_date=…&notes=…&filename=…
//          body = the file's raw bytes (Content-Type: the file's own type)
//   POST   ?action=remove&id=recDOC        hide it from the app (removed_at / removed_by set;
//                                           the row and the file are KEPT — deletes are Troy's)
//
// ⚠️ SIZE. Vercel refuses a request body over 4.5 MB before this code runs, and Airtable's
// upload endpoint takes at most 5 MB. The file goes up as raw bytes (not base64 in JSON,
// which would cost a third of the room), so the limit is 4 MB, checked here and on the page.
//
// ⚠️ FILE LINKS EXPIRE. Airtable attachment URLs are signed and last a few hours, so the
// list is read fresh each time the asset is opened and never cached.
//
// Env vars: ASSETS_PAT / AIRTABLE_PAT (write on the registry base), ASSETS_BASE,
//           ASSET_DOCS_TABLE (default tblrPv20XR3B696CB), ASSETS_TABLE (default 'Assets').

const { requireSession } = require('./_auth');

const PAT    = process.env.ASSETS_PAT || process.env.AIRTABLE_PAT;
const BASE   = process.env.ASSETS_BASE || 'app0sXrUbOBr7a6vV';
const TABLE  = process.env.ASSET_DOCS_TABLE || 'tblrPv20XR3B696CB';
const ASSETS = process.env.ASSETS_TABLE || 'Assets';

const F = {
  documentId: 'fld1OOySRhRpdUFeU', assetRec: 'fldu0mRG14IU12evD', assetId: 'fldpw4WGancgWxmu2',
  assetType: 'fld7J6ibaG27jg8ho', docType: 'fldEE0KPoRRdUl5Kp', title: 'fldDeclOyuFU7oUSD',
  docDate: 'flduIfNmQrzuwYcNU', notes: 'fldIaKcILXtIIVSLD', file: 'flderlrTTcnDtXYT8',
  fileName: 'fldxEycg4Xo9Hmz7v', fileSize: 'fldd81gz9zpOVvOEu', uploadedBy: 'fldUIz4NQGLtvtz2e',
  uploadedAt: 'fldnfkqLOHsF9Esbx', removedAt: 'fldUsOKv2TR0s8Z4V', removedBy: 'fldtXgiCmejDbQ8qA',
};
const DOC_TYPES = ['Work sheet', 'Inspection report', 'Drawing', 'Repair / maintenance record', 'Photo log', 'Correspondence', 'Other'];
const MAX_BYTES = 4 * 1024 * 1024;
// What a work sheet, report or drawing arrives as. Anything else is refused rather than
// stored — an .exe in the registry is nobody's document.
const TYPES = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', gif: 'image/gif',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', dwg: 'application/acad', msg: 'application/vnd.ms-outlook',
};
const REC = /^rec[A-Za-z0-9]{14}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)*mrdc-htra\.com$|^https:\/\/[a-z0-9-]+\.vercel\.app$/i;
function applyCors(req, res) {
  const origin = req.headers?.origin;
  if (origin && ORIGIN_OK.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function airtable(path, opts = {}, host = 'https://api.airtable.com') {
  const r = await fetch(`${host}/v0/${BASE}/${path}`, {
    ...opts, headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(json.error?.message || json.error?.type || `Airtable ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return json;
}

function todayAtlantic(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Moncton', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function newId() {
  return `AD-${todayAtlantic().replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0')}`;
}
const sel = v => (v && typeof v === 'object' ? v.name : v) || '';
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function docOut(r) {
  const f = r.fields || {};
  const file = (f[F.file] || [])[0] || null;
  return {
    id: r.id, documentId: f[F.documentId] || '', assetRec: f[F.assetRec] || '', assetId: f[F.assetId] || '',
    docType: sel(f[F.docType]), title: f[F.title] || '', docDate: f[F.docDate] || '', notes: f[F.notes] || '',
    fileName: f[F.fileName] || (file && file.filename) || '', fileSize: f[F.fileSize] ?? (file && file.size) ?? null,
    url: file ? file.url : '', contentType: file ? file.type : '',
    uploadedBy: f[F.uploadedBy] || '', uploadedAt: f[F.uploadedAt] || '',
    removed: !!f[F.removedAt],
  };
}

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body instanceof Uint8Array) return Buffer.from(req.body);
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BYTES + 1) break; chunks.push(c); }
  return Buffer.concat(chunks);
}

async function listFor(assetRec) {
  const out = [];
  let offset = '';
  const formula = `AND({asset_rec}='${assetRec}',{removed_at}='')`;
  do {
    const qs = new URLSearchParams({ filterByFormula: formula, returnFieldsByFieldId: 'true', pageSize: '100' });
    if (offset) qs.set('offset', offset);
    const page = await airtable(`${TABLE}?${qs}`);
    out.push(...(page.records || []).map(docOut));
    offset = page.offset || '';
  } while (offset);
  return out.filter(d => !d.removed)
    .sort((a, b) => (b.docDate || b.uploadedAt.slice(0, 10)).localeCompare(a.docDate || a.uploadedAt.slice(0, 10)) || b.uploadedAt.localeCompare(a.uploadedAt));
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  // ⚠️ Identity before any try/catch (a 401 inside one is re-reported as a 500). Anyone
  // with Assets access reads; only an editor writes.
  const caller = await requireSession(req, res);
  if (!caller) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!PAT) return res.status(500).json({ error: 'AIRTABLE_PAT (or ASSETS_PAT) is not set on this deployment.' });
  const Q = req.query || {};

  try {
    if (req.method === 'GET') {
      // ⚠️ An empty or malformed filter is an error, never "everything" (2026-08-26).
      if (!REC.test(String(Q.asset_rec || ''))) return res.status(400).json({ error: 'Which asset? Pass asset_rec=<record id>.' });
      const docs = await listFor(String(Q.asset_rec));
      return res.status(200).json({ ok: true, documents: docs, docTypes: DOC_TYPES, canUpload: caller.canEdit === true, maxBytes: MAX_BYTES });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (caller.canEdit !== true) return res.status(403).json({ error: 'Only Assets editors (Assets Role Admin or Manager) can add or remove documents.' });

    if (Q.action === 'remove') {
      const id = String(Q.id || '');
      if (!REC.test(id)) return res.status(400).json({ error: 'Which document?' });
      const cur = await airtable(`${TABLE}/${id}?returnFieldsByFieldId=true`).catch(e => { if (e.status === 404) return null; throw e; });
      if (!cur) return res.status(404).json({ error: 'That document was not found.' });
      if ((cur.fields || {})[F.removedAt]) return res.status(200).json({ ok: true, already: true });
      await airtable(`${TABLE}/${id}`, { method: 'PATCH', body: JSON.stringify({ fields: {
        [F.removedAt]: new Date().toISOString(), [F.removedBy]: caller.name } }) });
      return res.status(200).json({ ok: true, removed: id });
    }
    if (Q.action) return res.status(400).json({ error: 'Unknown action.' });

    // ── upload ──
    const assetRec = String(Q.asset_rec || '');
    if (!REC.test(assetRec)) return res.status(400).json({ error: 'Which asset? Pass asset_rec=<record id>.' });
    const docType = String(Q.doc_type || '');
    if (!DOC_TYPES.includes(docType)) return res.status(400).json({ error: 'Pick a document type.' });
    const title = clip(Q.title, 200);
    if (!title) return res.status(400).json({ error: 'Give the document a title.' });
    const docDate = String(Q.doc_date || '');
    if (docDate && !ISO.test(docDate)) return res.status(400).json({ error: 'The document date should be YYYY-MM-DD.' });
    if (docDate && docDate > todayAtlantic()) return res.status(400).json({ error: 'The document date is in the future.' });
    const filename = clip(Q.filename, 180).replace(/[\\/]/g, '_');
    const ext = (filename.match(/\.([a-z0-9]+)$/i) || [])[1];
    const type = ext && TYPES[ext.toLowerCase()];
    if (!type) return res.status(400).json({ error: `That kind of file can't be stored here. Allowed: ${Object.keys(TYPES).join(', ')}.` });

    const buf = await readBody(req);
    if (!buf.length) return res.status(400).json({ error: 'The file is empty.' });
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'The file is over 4 MB. Save it smaller (e.g. a lower-resolution scan) and try again.' });

    const asset = await airtable(`${encodeURIComponent(ASSETS)}/${assetRec}`).catch(e => { if (e.status === 404) return null; throw e; });
    if (!asset) return res.status(404).json({ error: 'That asset was not found in the register.' });
    const af = asset.fields || {};

    const created = await airtable(TABLE, { method: 'POST', body: JSON.stringify({ typecast: false, fields: {
      [F.documentId]: newId(), [F.assetRec]: assetRec, [F.assetId]: String(af['Asset ID'] || ''), [F.assetType]: String(af['Category'] || ''),
      [F.docType]: docType, [F.title]: title, ...(docDate ? { [F.docDate]: docDate } : {}), [F.notes]: clip(Q.notes, 2000),
      [F.fileName]: filename, [F.fileSize]: buf.length, [F.uploadedBy]: caller.name, [F.uploadedAt]: new Date().toISOString(),
    } }) });
    try {
      await airtable(`${created.id}/${F.file}/uploadAttachment`, { method: 'POST',
        body: JSON.stringify({ contentType: type, filename, file: buf.toString('base64') }) }, 'https://content.airtable.com');
    } catch (e) {
      // The row without its file is useless and would show as a broken entry: take back
      // our own half-write, then say what happened.
      await airtable(`${TABLE}/${created.id}`, { method: 'DELETE' }).catch(() => {});
      console.error('[asset-documents] upload', e.message);
      return res.status(502).json({ error: 'The file did not upload. Nothing was saved — try again.', detail: e.message });
    }
    const fresh = await airtable(`${TABLE}/${created.id}?returnFieldsByFieldId=true`).catch(() => created);
    return res.status(201).json({ ok: true, document: docOut(fresh) });
  } catch (e) {
    console.error('[asset-documents]', e.message);
    return res.status(500).json({ error: 'Something went wrong with the documents.', detail: e.message });
  }
};
module.exports.lib = { DOC_TYPES, MAX_BYTES, TYPES, docOut, F };
