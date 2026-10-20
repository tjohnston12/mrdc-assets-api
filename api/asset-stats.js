// api/asset-stats.js — mrdc-assets-api (Vercel) · https://assets.mrdc-htra.com/api/asset-stats
//
// Troy, 2026-10-20: "can you give me daily stats on dmts closed and by who and also
// uploads or modifications to assets, this will be for the asset and records employees".
// He chose a daily email AND a page, a new email subscription, and a change log from now.
//
//   GET /api/asset-stats?from=YYYY-MM-DD&to=YYYY-MM-DD   the page (default: today, NB time)
//       Assets editors only (Assets Role Admin / Manager, org Owner / Admin).
//   GET /api/asset-stats?digest=1[&day=YYYY-MM-DD][&dry=1]   the morning email
//       Vercel cron, `Authorization: Bearer <CRON_SECRET>`. Default day: yesterday.
//       To: every active employee whose Email Subscriptions include
//       "Asset & Records Daily Stats". Nobody subscribed → nothing sent.
//
// Where the numbers come from:
//   · DMT closures — the DMT's own API (?status=closed&dfield=Date Closed), read
//     server-to-server with the shared intake key (INTAKE_SECRET, the same key the DMT
//     uses to read this API). "By who" is the DMT's Closed By, stamped from the closer's
//     session since 2026-09-24; earlier or service closures read "(not recorded)".
//   · Asset changes — the Asset Changes log (api/_changes.js), written by every write
//     path in this project from 2026-10-20.
//
// Env: ASSETS_PAT / AIRTABLE_PAT (registry + Employees, as asset-message.js),
//      INTAKE_SECRET (DMT read), RESEND_API_KEY, CRON_SECRET, optional DMT_API_URL,
//      RESEND_FROM, STATS_APP_URL.
'use strict';

const { requireSession } = require('./_auth');
const { todayAtlantic, daysAgoAtlantic } = require('./_when');
const { changesBetween, daysBetween } = require('./_changes');

const PAT         = process.env.ASSETS_PAT || process.env.AIRTABLE_PAT;
const EMP_BASE    = process.env.EMP_BASE  || 'appraSoUXoTbhroG6';
const EMP_TABLE   = process.env.EMP_TABLE || 'Employees';
const DMT_API     = process.env.DMT_API_URL || 'https://dmt.mrdc-htra.com/api/work-orders';
const DMT_APP     = 'https://dmt.mrdc-htra.com';
const INTAKE_KEY  = (process.env.INTAKE_SECRET || '').trim();
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();
const RESEND_KEY  = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'assets@mrdc-htra.com';
const PAGE_URL    = process.env.STATS_APP_URL || 'https://www.mrdc-htra.com/assets/stats.html';
const SUBSCRIPTION = 'Asset & Records Daily Stats';
const MAX_DAYS = 31;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const NOT_RECORDED = '(not recorded)';

const s = v => (v == null ? '' : (typeof v === 'object' && v.name ? String(v.name) : String(v)));
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── DMT closures ───────────────────────────────────────────────────────── */
async function dmtClosures(from, to, fetchImpl = fetch) {
  if (!INTAKE_KEY) return { available: false, reason: 'The DMT cannot be read from here (INTAKE_SECRET is not set on the assets API).' };
  const qs = new URLSearchParams({ status: 'closed', dfield: 'Date Closed', from, to, limit: '5000' });
  let j;
  try {
    const r = await fetchImpl(`${DMT_API}?${qs}`, { headers: { 'x-intake-key': INTAKE_KEY }, cache: 'no-store' });
    j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { available: false, reason: `The DMT did not answer (${r.status}${j && j.error ? ': ' + j.error : ''}).` };
  } catch (e) {
    return { available: false, reason: 'The DMT could not be reached.' };
  }
  const rows = (j.records || [])
    .map(w => ({ wo: s(w['Work Order #']), status: s(w.Status), closedBy: s(w['Closed By']).trim() || NOT_RECORDED,
      dateClosed: s(w['Date Closed']).slice(0, 10), standard: s(w.Standard), finding: s(w.Finding), assetId: s(w['Asset ID']),
      division: s(w.Division || w.Assignee), route: s(w.Route), km: w.KM == null ? '' : String(w.KM) }))
    .filter(w => w.dateClosed >= from && w.dateClosed <= to)          // the DMT's filter is not trusted alone
    .sort((a, b) => a.dateClosed.localeCompare(b.dateClosed) || a.closedBy.localeCompare(b.closedBy) || a.wo.localeCompare(b.wo));
  const by = new Map();
  for (const w of rows) {
    const p = by.get(w.closedBy) || { name: w.closedBy, total: 0, statuses: {} };
    p.total++; p.statuses[w.status] = (p.statuses[w.status] || 0) + 1;
    by.set(w.closedBy, p);
  }
  return { available: true, total: rows.length, truncated: !!j.truncated, byPerson: sortPeople([...by.values()]), rows };
}
// Most first; "(not recorded)" always last.
const sortPeople = list => list.sort((a, b) => ((a.name === NOT_RECORDED) - (b.name === NOT_RECORDED)) || (b.total - a.total) || a.name.localeCompare(b.name));

/* ── asset changes ──────────────────────────────────────────────────────── */
function summariseChanges(rows) {
  const by = new Map(), byAction = {};
  for (const c of rows) {
    const p = by.get(c.who) || { name: c.who, total: 0, byAction: {} };
    p.total++; p.byAction[c.action] = (p.byAction[c.action] || 0) + 1;
    byAction[c.action] = (byAction[c.action] || 0) + 1;
    by.set(c.who, p);
  }
  return { available: true, total: rows.length, byAction, byPerson: sortPeople([...by.values()]), rows };
}

async function statsFor(from, to, deps = {}) {
  const [dmt, assets] = await Promise.all([
    (deps.dmt || dmtClosures)(from, to),
    (deps.changes || changesBetween)(from, to).then(summariseChanges)
      .catch(e => ({ available: false, reason: `The asset change log could not be read (${e.message}).` })),
  ]);
  // One line per person across both.
  const people = new Map();
  const add = (name, k, n) => { const p = people.get(name) || { name, dmt: 0, assets: 0, total: 0 }; p[k] += n; p.total += n; people.set(name, p); };
  if (dmt.available) dmt.byPerson.forEach(p => add(p.name, 'dmt', p.total));
  if (assets.available) assets.byPerson.forEach(p => add(p.name, 'assets', p.total));
  return { from, to, days: daysBetween(from, to), dmt, assets, people: sortPeople([...people.values()]) };
}

/* ── the email ──────────────────────────────────────────────────────────── */
const dayLabel = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const actionsText = byAction => Object.entries(byAction).map(([a, n]) => `${n} ${a.toLowerCase()}`).join(', ');

function emailHtml(st) {
  const th = t => `<th align="left" style="padding:6px 8px;color:#888;font-size:10.5px;text-transform:uppercase;border-bottom:1px solid #ddd">${t}</th>`;
  const td = (v, x) => `<td style="padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;${x || ''}">${v}</td>`;
  const h2 = t => `<div style="font-size:14px;font-weight:700;color:#1E2B5E;border-bottom:2px solid #1E2B5E;padding:18px 0 4px">${t}</div>`;
  const none = t => `<div style="padding:10px 0;color:#666;font-size:13px">${t}</div>`;
  const d = st.dmt, a = st.assets;

  const summary = st.people.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:13px">${'<tr>' + th('Person') + th('DMTs closed') + th('Asset changes') + '</tr>'}
       ${st.people.map(p => {
         const ap = a.available ? a.byPerson.find(x => x.name === p.name) : null;
         return '<tr>' + td(esc(p.name), 'font-weight:600') + td(p.dmt || '—') + td(ap ? `${ap.total} <span style="color:#666">(${esc(actionsText(ap.byAction))})</span>` : '—') + '</tr>';
       }).join('')}</table>`
    : none('No DMT closures and no asset changes.');

  const dmtList = !d.available ? none(esc(d.reason)) : !d.rows.length ? none('No work orders closed.') :
    `<table style="width:100%;border-collapse:collapse;font-size:12.5px">${'<tr>' + th('WO #') + th('Closed by') + th('Standard — finding') + th('Asset') + th('Status') + '</tr>'}
     ${d.rows.map(w => '<tr>' + td(`<a href="${DMT_APP}/?wo=${encodeURIComponent(w.wo)}" style="color:#1E2B5E;font-weight:600;text-decoration:none">${esc(w.wo)}</a>`)
       + td(esc(w.closedBy)) + td(esc([w.standard, w.finding].filter(Boolean).join(' — ')) || '—') + td(esc(w.assetId) || '—') + td(esc(w.status)) + '</tr>').join('')}</table>`;

  const assetList = !a.available ? none(esc(a.reason)) : !a.rows.length ? none('No asset changes.') :
    `<table style="width:100%;border-collapse:collapse;font-size:12.5px">${'<tr>' + th('Time') + th('Who') + th('What') + th('Asset') + th('Detail') + '</tr>'}
     ${a.rows.map(c => '<tr>' + td(esc(timeOf(c.at)), 'white-space:nowrap') + td(esc(c.who)) + td(esc(c.action))
       + td(esc([c.assetId, c.assetName && c.assetName !== c.assetId ? c.assetName : ''].filter(Boolean).join(' · ')) || '—') + td(esc(c.detail) || '—', 'color:#555') + '</tr>').join('')}</table>`;

  const one = st.from === st.to;
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:720px;margin:0 auto;background:#f5f5f3;padding:24px">
  <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
    <div style="background:#1E2B5E;padding:20px 24px;border-bottom:3px solid #C9A84C">
      <div style="color:#fff;font-size:18px;font-weight:600">Asset &amp; records — daily stats</div>
      <div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:4px">${esc(one ? dayLabel(st.from) : `${st.from} to ${st.to}`)} ·
        ${d.available ? `${d.total} DMT${d.total === 1 ? '' : 's'} closed` : 'DMT not available'} ·
        ${a.available ? `${a.total} asset change${a.total === 1 ? '' : 's'}` : 'asset log not available'}</div>
    </div>
    <div style="padding:0 24px 20px">
      ${h2('By person')}${summary}
      ${h2('DMT work orders closed')}${dmtList}
      ${h2('Asset uploads and changes')}${assetList}
      <p style="margin-top:18px;font-size:12px;color:#666">Any day or range: <a href="${PAGE_URL}?from=${st.from}&to=${st.to}" style="color:#1E2B5E">${PAGE_URL.replace(/^https:\/\//, '')}</a>.
        Asset changes are counted from 20 October 2026, when the change log started. DMT closures name the person who closed them in the DMT.</p>
    </div>
  </div></div>`;
}
function timeOf(iso) {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Moncton', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }).format(new Date(iso)); }
  catch (_) { return String(iso).slice(11, 16); }
}

async function fetchAll(base, table, params = {}) {
  const out = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100', ...params });
    if (offset) qs.set('offset', offset);
    const r = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?${qs}`, { headers: { Authorization: `Bearer ${PAT}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && (j.error.message || j.error.type)) || `Airtable ${r.status}`); e.status = r.status; throw e; }
    out.push(...(j.records || []));
    offset = j.offset;
  } while (offset);
  return out;
}
/* Active employees with an email whose Email Subscriptions include ours. */
function subscribersFrom(rows) {
  const out = [];
  for (const r of rows) {
    const f = r.fields || {};
    const subs = (Array.isArray(f['Email Subscriptions']) ? f['Email Subscriptions'] : []).map(s);
    const email = s(f['Email']).trim();
    if (!subs.includes(SUBSCRIPTION) || !email) continue;
    if (s(f['Active']).toLowerCase() === 'inactive') continue;
    out.push({ name: s(f['Name']).trim(), email });
  }
  return out;
}
/* Shared mailboxes and extra addresses (Access & Roles → Distribution Lists) that carry the
   subscription in their Lists, Active only. Read by field id. */
const DIST_TABLE = process.env.DISTRIBUTION_TABLE || 'tblGXm5nDaxGppjVj';
const DF = { name: 'fldc22IrOlNLqIEKo', email: 'flderIfr2j2OpQbc1', lists: 'fldbJ8Qy4QHhBrTzm', status: 'fldshxalFiAb8egad' };
function listSubscribersFrom(rows) {
  return rows.map(r => r.fields || {})
    .filter(f => (Array.isArray(f[DF.lists]) ? f[DF.lists] : []).map(s).includes(SUBSCRIPTION) && s(f[DF.email]).trim() && s(f[DF.status]) !== 'Inactive')
    .map(f => ({ name: s(f[DF.name]).trim(), email: s(f[DF.email]).trim() }));
}
async function subscribers() {
  const people = subscribersFrom(await fetchAll(EMP_BASE, EMP_TABLE, { filterByFormula: `FIND('${SUBSCRIPTION.replace(/'/g, "\\'")}', ARRAYJOIN({Email Subscriptions}, '|'))` }));
  let lists = [];
  try { lists = listSubscribersFrom(await fetchAll(EMP_BASE, DIST_TABLE, { returnFieldsByFieldId: 'true' })); }
  catch (e) { console.error('[asset-stats] distribution lists', e.message); }
  const seen = new Set(), out = [];
  for (const x of [...people, ...lists]) { const k = x.email.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}
async function sendEmail(to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `MRDC Assets <${RESEND_FROM}>`, to, subject, html }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(j && (j.message || j.name)) || ''}`.trim());
  return String(j.id || '');
}

/* ── the handler ────────────────────────────────────────────────────────── */
const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)*mrdc-htra\.com$|^https:\/\/[a-z0-9-]+\.vercel\.app$/i;
function applyCors(req, res) {
  const origin = req.headers && req.headers.origin;
  if (origin && ORIGIN_OK.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function rangeFrom(Q) {
  const today = todayAtlantic();
  const from = String(Q.from || Q.day || today), to = String(Q.to || Q.from || Q.day || today);
  if (!ISO.test(from) || !ISO.test(to)) return { error: 'Dates should be YYYY-MM-DD.' };
  if (to < from) return { error: 'The end date is before the start.' };
  if (from > today) return { error: 'That day has not happened yet.' };
  if (daysBetween(from, to).length > MAX_DAYS) return { error: `Pick ${MAX_DAYS} days or fewer.` };
  return { from, to: to > today ? today : to };
}

async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  const Q = req.query || {};

  /* The morning email. ⚠️ A cron guard that is skipped when its secret is unset is no
     guard (working agreement §2b) — so no secret, no send. */
  if (Q.digest === '1') {
    if (!CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET is not set on the assets API, so the daily email is off.' });
    if (String(req.headers.authorization || '') !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Not authorised.' });
    const day = ISO.test(String(Q.day || '')) ? String(Q.day) : daysAgoAtlantic(1);
    try {
      const st = await statsFor(day, day);
      const to = await subscribers();
      const subject = `Asset & records daily stats — ${day}: ${st.dmt.available ? st.dmt.total : '?'} DMT closed, ${st.assets.available ? st.assets.total : '?'} asset change${st.assets.total === 1 ? '' : 's'}`;
      if (!to.length) return res.status(200).json({ ok: true, sent: 0, skipped: `Nobody is subscribed to "${SUBSCRIPTION}".`, day });
      if (Q.dry === '1') return res.status(200).json({ ok: true, dry: true, day, to: to.map(x => x.name), subject, stats: { dmt: st.dmt.total, assets: st.assets.total } });
      if (!RESEND_KEY) return res.status(503).json({ error: 'RESEND_API_KEY is not set on the assets API.' });
      const id = await sendEmail(to.map(x => x.email), subject, emailHtml(st));
      return res.status(200).json({ ok: true, sent: to.length, id, day });
    } catch (e) {
      console.error('[asset-stats digest]', e.message);
      return res.status(500).json({ error: 'The daily stats email failed.', detail: e.message });
    }
  }

  // ⚠️ Identity before the try/catch (a 401 inside one is re-reported as a 500).
  const caller = await requireSession(req, res);
  if (!caller) return;
  if (caller.canEdit !== true) return res.status(403).json({ error: 'Daily stats are for Assets editors (Assets Role Admin or Manager).' });
  const r = rangeFrom(Q);
  if (r.error) return res.status(400).json({ error: r.error });
  try {
    return res.status(200).json({ ok: true, ...(await statsFor(r.from, r.to)), today: todayAtlantic(), logStarted: '2026-10-20' });
  } catch (e) {
    console.error('[asset-stats]', e.message);
    return res.status(500).json({ error: 'The stats could not be built.', detail: e.message });
  }
}

module.exports = handler;
module.exports.lib = { statsFor, dmtClosures, summariseChanges, emailHtml, subscribersFrom, listSubscribersFrom, rangeFrom, sortPeople, SUBSCRIPTION, NOT_RECORDED, MAX_DAYS };
