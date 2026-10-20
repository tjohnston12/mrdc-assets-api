// api/_changes.js — who changed what in the asset register.
//
// Troy, 2026-10-20: "can you give me daily stats on dmts closed and by who and also
// uploads or modifications to assets, this will be for the asset and records employees".
//
// Every write to Airtable from this project goes through one token, so Airtable's own
// "Last Modified By" and revision history name the token, never the person. This table
// is the record of the person: each write path (assets.js edit / add, asset-documents.js
// upload / remove, media.js add / edit, annual-inspections.js record) appends one row,
// named from the VALIDATED session — never from an x-user-* header.
//
// ⚠️ BEST EFFORT, BY DESIGN. logChange() never throws and never fails the write it
// describes: the asset edit has already landed when it is called, and refusing to tell
// the user "saved" because the log row could not be written would be a lie. A failure
// is logged to the console and reported back as `false`.
//
// Table: Asset Changes (tblp4bJuyA3QnkqKk) in the registry base. Starts 2026-10-20 —
// nothing before that is attributable to a person.
'use strict';

const { todayAtlantic } = require('./_when');

const PAT   = process.env.ASSETS_PAT || process.env.AIRTABLE_PAT;
const BASE  = process.env.ASSETS_BASE || 'app0sXrUbOBr7a6vV';
const TABLE = process.env.ASSET_CHANGES_TABLE || 'tblp4bJuyA3QnkqKk';

const F = {
  change:    'fld9xk9QuGEsWbRL0',
  at:        'fldPAqAl793SVtrBj',
  day:       'fldhG4c38sIkWObpR',
  who:       'fldO7tGZpzEsg4nO2',
  whoId:     'fld8b6ITrcDi0Qbv7',
  action:    'fldRv5NG3Wq3gbehu',
  assetId:   'fldBpZm77zvIpWNP3',
  assetRec:  'fldTdTjaPxrvCSMfi',
  assetName: 'fldyhs6o8bXswaTNh',
  assetType: 'fldTPF7Y9KMsj3AmJ',
  detail:    'fldUvowN2WwRaegRA',
};
// The Action choices, exactly as they are in Airtable (no typecast — an unknown one is refused).
const ACTIONS = ['Asset edited', 'Asset added', 'Document uploaded', 'Document removed',
                 'Media added', 'Media edited', 'Inspection recorded'];

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/* One row for one change. `who` comes from the caller the handler already validated.
   c = { action, assetId, assetRec, assetName, assetType, detail } */
function rowFor(caller, c, now = new Date()) {
  const who = clip((caller && caller.name) || '', 120).trim() || ((caller && caller.isService) ? 'DMT intake' : 'unknown');
  const whoId = clip(caller && caller.user && caller.user.employeeId, 40);
  const action = ACTIONS.includes(c && c.action) ? c.action : null;
  if (!action) return null;
  const assetId = clip(c.assetId, 120);
  return {
    [F.change]:    clip(`${action} · ${assetId || c.assetName || '—'} · ${who}`, 250),
    [F.at]:        now.toISOString(),
    [F.day]:       todayAtlantic(now),
    [F.who]:       who,
    ...(whoId ? { [F.whoId]: whoId } : {}),
    [F.action]:    action,
    [F.assetId]:   assetId,
    [F.assetRec]:  clip(c.assetRec, 40),
    [F.assetName]: clip(c.assetName, 200),
    [F.assetType]: clip(c.assetType, 60),
    [F.detail]:    clip(c.detail, 2000),
  };
}

async function logChange(caller, c) {
  try {
    if (!PAT) return false;
    const fields = rowFor(caller, c);
    if (!fields) { console.error('[asset-changes] unknown action', c && c.action); return false; }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), 4000) : null;
    try {
      const r = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields }], typecast: false }),
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      if (!r.ok) { console.error('[asset-changes] write', r.status, (await r.text().catch(() => '')).slice(0, 200)); return false; }
      return true;
    } finally { if (t) clearTimeout(t); }
  } catch (e) {
    console.error('[asset-changes]', e && e.message);
    return false;
  }
}

/* Every day from `from` to `to`, inclusive (both YYYY-MM-DD). */
function daysBetween(from, to) {
  const out = [];
  let d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d <= end && out.length < 400) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
  return out;
}

/* The change rows for a range of days. Day is text, so the filter names each day. */
async function changesBetween(from, to) {
  if (!ISO.test(from) || !ISO.test(to)) throw new Error('bad range');
  const days = daysBetween(from, to);
  const formula = days.length === 1 ? `{Day}='${days[0]}'` : `OR(${days.map(d => `{Day}='${d}'`).join(',')})`;
  const out = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100', filterByFormula: formula, returnFieldsByFieldId: 'true' });
    if (offset) qs.set('offset', offset);
    const r = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}?${qs}`, { headers: { Authorization: `Bearer ${PAT}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && (j.error.message || j.error.type)) || `Airtable ${r.status}`); e.status = r.status; throw e; }
    out.push(...(j.records || []));
    offset = j.offset;
  } while (offset);
  const set = new Set(days);
  return out.map(r => {
    const f = r.fields || {};
    const sel = v => (v && typeof v === 'object' ? v.name : v) || '';
    return { id: r.id, at: f[F.at] || '', day: f[F.day] || '', who: f[F.who] || '', whoId: f[F.whoId] || '',
      action: sel(f[F.action]), assetId: f[F.assetId] || '', assetRec: f[F.assetRec] || '', assetName: f[F.assetName] || '',
      assetType: f[F.assetType] || '', detail: f[F.detail] || '' };
  }).filter(x => set.has(x.day))             // the formula is not trusted alone
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

module.exports = { logChange, changesBetween, daysBetween, rowFor, ACTIONS, F, TABLE };
