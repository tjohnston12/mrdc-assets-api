// api/asset-message.js — mrdc-assets-api
//   https://assets.mrdc-htra.com/api/asset-message
//
// "if someone is editing an asset or has questions about it, can you add a message
// option so an email can be sent to an employee (manager list) with the asset
// attached and a text box?" — Troy, 2026-08-25.
//
//   GET  ?managers=1        the recipient list (active employees, org Role Manager)
//   GET  ?asset=<asset_id>  messages already sent about that asset, newest first
//   POST { assetId, to, message }
//
// Decisions (Troy, 2026-08-25):
//   · Recipients are the ELEVEN org-Role Managers, not the whole directory.
//   · The asset travels as its details in the email body plus a deep link back —
//     no PDF. Readable on a phone, one tap to the record.
//   · Every message is RECORDED on the asset, so the next person can see the
//     question was already asked.
//
// ⚠️ This endpoint sends mail as MRDC, so unlike assets.js/media.js it does NOT
// trust x-user-* headers — see ./_auth.js.
//
// NO external dependencies.

const { requireSession, applyCors } = require('./_auth');

const PAT   = process.env.ASSETS_PAT || process.env.AIRTABLE_PAT;
const BASE  = process.env.ASSETS_BASE  || 'app0sXrUbOBr7a6vV';
const TABLE = process.env.ASSETS_TABLE || 'Assets';
const MSG_TABLE = process.env.ASSET_MESSAGES_TABLE || 'Asset Messages';

const EMP_BASE  = process.env.EMP_BASE  || 'appraSoUXoTbhroG6';
const EMP_TABLE = process.env.EMP_TABLE || 'Employees';

const RESEND_KEY  = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'assets@mrdc-htra.com';
const APP_URL     = process.env.ASSETS_APP_URL || 'https://www.mrdc-htra.com/assets/';

// Who counts as a manager. Deliberately the ORG role, not a job title containing
// "Manager" — job titles are a multi-select people edit freely, the org Role is the
// one field Access & Roles actually governs.
const MANAGER_ROLES = (process.env.ASSET_MSG_ROLES || 'Manager')
  .split(',').map(s => s.trim()).filter(Boolean);

const MAX_MESSAGE = Number(process.env.ASSET_MSG_MAX || 4000);

// ── Airtable ────────────────────────────────────────────────────────────────

async function at(base, path, options = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${base}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAT}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json.error?.message || json.error?.type || `Airtable ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

async function fetchAll(base, table, params = {}) {
  const out = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: '100', ...params });
    if (offset) qs.set('offset', offset);
    const page = await at(base, `${encodeURIComponent(table)}?${qs}`);
    out.push(...(page.records || []));
    offset = page.offset;
  } while (offset);
  return out;
}

const s = v => (v == null ? '' : (typeof v === 'object' && v.name ? String(v.name) : String(v)));

// ── The recipient list ──────────────────────────────────────────────────────
//
// Rebuilt on every call rather than cached: a manager who leaves should stop being
// emailable immediately, and this is a handful of rows a few times a day.

async function managers() {
  const rows = await fetchAll(EMP_BASE, EMP_TABLE);
  const out = [];
  for (const r of rows) {
    const f = r.fields || {};
    const name  = s(f['Name']).trim();
    const email = s(f['Email']).trim();
    const role  = s(f['Role']).trim();
    if (!name || !email) continue;
    if (s(f['Active']).toLowerCase() === 'inactive') continue;
    if (!MANAGER_ROLES.includes(role)) continue;
    out.push({ name, email, jobTitle: (Array.isArray(f['Job Title']) ? f['Job Title'] : [f['Job Title']])
      .filter(Boolean).map(x => s(x)).join(', ') });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ── The asset ───────────────────────────────────────────────────────────────

const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/#-]{0,119}$/;
const validAssetId = v => ASSET_ID_RE.test(String(v || ''));

async function findAsset(assetId) {
  if (!validAssetId(assetId)) return null;
  const esc = String(assetId).replace(/'/g, "\\'");
  const rows = await fetchAll(BASE, TABLE, { filterByFormula: `{asset_id}='${esc}'`, maxRecords: '1' });
  return rows[0] || null;
}

// The fields a person needs to answer "what is this and where is it".
function assetFacts(f) {
  const pairs = [
    ['Asset ID',          s(f['asset_id'])],
    ['Asset number',      s(f['asset_ref']) || s(f['source_ref'])],
    ['Name',              s(f['name'])],
    ['Type',              s(f['asset_type']) || s(f['category'])],
    ['Route',             s(f['Route']) || s(f['route'])],
    ['Intersecting road', s(f['intersecting_roads'])],
    ['KM',                s(f['KM']) || s(f['km'])],
    ['Direction',         s(f['direction'])],
    ['Side',              s(f['side'])],
    ['Status',            s(f['status'])],
  ];
  const lat = f['Latitude'] ?? f['lat'];
  const lng = f['Longitude'] ?? f['lng'];
  if (lat != null && lng != null && lat !== '' && lng !== '') {
    pairs.push(['GPS', `${lat}, ${lng}`]);
  }
  return pairs.filter(([, v]) => v !== '' && v != null);
}

// ── The email ───────────────────────────────────────────────────────────────

const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildEmail({ asset, facts, message, from, to }) {
  const link = `${APP_URL}?id=${encodeURIComponent(asset)}`;
  const gps = facts.find(([k]) => k === 'GPS');
  const rows = facts.map(([k, v]) => `
      <tr><td style="padding:3px 14px 3px 0;color:#667;font-size:11px;text-transform:uppercase;letter-spacing:.4px;font-weight:700;white-space:nowrap;vertical-align:top">${esc(k)}</td>
          <td style="padding:3px 0;font-size:13.5px;color:#16181d">${esc(v)}</td></tr>`).join('');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f3;padding:0;margin:0">
  <div style="max-width:640px;margin:0 auto;background:#fff">
    <div style="background:#1B4F8A;color:#fff;padding:20px 28px">
      <div style="font-size:18px;font-weight:700">A question about an asset</div>
      <div style="font-size:13.5px;color:rgba(255,255,255,.85);margin-top:4px">${esc(from.name)} sent this from the MRDC Assets app</div>
    </div>
    <div style="padding:20px 28px 32px">
      <div style="background:#F4F7FB;border-left:4px solid #1B4F8A;border-radius:6px;padding:14px 16px;font-size:14px;color:#16181d;white-space:pre-wrap;line-height:1.5">${esc(message)}</div>

      <div style="font-size:12px;color:#667;text-transform:uppercase;letter-spacing:.4px;font-weight:700;border-bottom:1px solid #D5DEEA;padding-bottom:4px;margin:22px 0 8px">The asset</div>
      <table style="border-collapse:collapse">${rows}</table>

      <p style="margin:20px 0 0">
        <a href="${esc(link)}" style="display:inline-block;background:#1B4F8A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:13.5px;font-weight:600">Open this asset &rarr;</a>
        ${gps ? `<a href="https://www.google.com/maps?q=${encodeURIComponent(gps[1])}" style="display:inline-block;margin-left:8px;padding:10px 18px;border-radius:8px;font-size:13.5px;font-weight:600;color:#1B4F8A;text-decoration:none;border:1px solid #C8D4E2">View on the map &rarr;</a>` : ''}
      </p>

      <p style="font-size:12.5px;color:#667;margin:22px 0 0;line-height:1.5">
        Reply to this email to answer ${esc(from.name)} directly &mdash; it goes to ${esc(from.email)}, not to a no-reply address.
        This message is also recorded against the asset, so anyone else looking at it can see the question was asked.
      </p>
    </div>
  </div></div>`;

  const text = `${from.name} sent a question about asset ${asset} from the MRDC Assets app.

${message}

THE ASSET
${facts.map(([k, v]) => `  ${k}: ${v}`).join('\n')}

Open it: ${link}

Reply to this email to answer ${from.name} directly (${from.email}).`;

  return {
    from: RESEND_FROM,
    to: [to.email],
    reply_to: from.email || undefined,
    subject: `Assets — question about ${asset}${facts.find(([k]) => k === 'Name') ? ` (${facts.find(([k]) => k === 'Name')[1]})` : ''}`,
    html, text,
  };
}

// Returns the Resend message id, never a bare boolean. Throwing away the id is why
// a suppressed address stayed invisible for weeks — working-agreement.md §2b.
async function send(payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const e = new Error(`The email could not be sent (Resend ${r.status}).`);
    e.status = 502; e.detail = body.slice(0, 300);
    throw e;
  }
  const j = await r.json().catch(() => ({}));
  return String(j.id || '');
}

// ── Messages on an asset ────────────────────────────────────────────────────

async function messagesFor(assetId) {
  if (!validAssetId(assetId)) return [];
  const escd = String(assetId).replace(/'/g, "\\'");
  const rows = await fetchAll(BASE, MSG_TABLE, { filterByFormula: `{asset_id}='${escd}'` });
  return rows
    .map(r => ({
      id:        s(r.fields['message_id']),
      assetId:   s(r.fields['asset_id']),
      toName:    s(r.fields['to_name']),
      fromName:  s(r.fields['from_name']),
      message:   s(r.fields['message']),
      sentAt:    s(r.fields['sent_at']),
    }))
    .sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
}

async function nextMessageId() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `AMSG-${day}-`;
  const rows = await fetchAll(BASE, MSG_TABLE, { filterByFormula: `FIND('${prefix}', {message_id} & '') = 1` });
  return prefix + String(rows.length + 1).padStart(3, '0');
}

// ── Handler ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!PAT) return res.status(500).json({ error: 'ASSETS_PAT / AIRTABLE_PAT is not set on this deployment.' });

  const caller = await requireSession(req, res);
  if (!caller) return;                                  // 401 already sent

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (String(q.managers || '') === '1') {
        return res.status(200).json({ ok: true, managers: await managers() });
      }
      const assetId = String(q.asset || '').trim();
      if (!assetId) return res.status(400).json({ error: 'Give ?managers=1 or ?asset=<asset_id>.' });
      return res.status(200).json({ ok: true, assetId, messages: await messagesFor(assetId) });
    }

    if (req.method === 'POST') {
      if (!RESEND_KEY) {
        return res.status(500).json({ error: 'Email is not configured on this deployment (RESEND_API_KEY).' });
      }

      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
      if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Expected a JSON body.' });

      const message = String(body.message || '').trim();
      if (!message) return res.status(400).json({ error: 'Write a message before sending.' });
      if (message.length > MAX_MESSAGE) {
        return res.status(400).json({ error: `That message is too long (max ${MAX_MESSAGE} characters).` });
      }

      // ⚠️ The recipient is RESOLVED from the manager list, never taken from the
      // body. Otherwise this endpoint would send MRDC-branded mail with arbitrary
      // text to any address a caller cared to name.
      const wanted = String(body.to || '').trim().toLowerCase();
      if (!wanted) return res.status(400).json({ error: 'Choose who to send this to.' });
      const list = await managers();
      const to = list.find(m => m.email.toLowerCase() === wanted);
      if (!to) return res.status(400).json({ error: 'That recipient is not on the manager list.' });

      const assetId = String(body.assetId || '').trim();
      const rec = await findAsset(assetId);
      if (!rec) return res.status(404).json({ error: 'That asset is not in the register.' });

      const f = rec.fields || {};
      const facts = assetFacts(f);
      const assetName = s(f['name']);

      // Attested from the session, not self-declared — same rule as Responded By
      // and Reviewed By in the Safety app.
      const from = {
        name:  String((caller.user && caller.user.name) || '').trim() || 'An MRDC user',
        email: String((caller.user && caller.user.email) || '').trim(),
      };

      const emailId = await send(buildEmail({ asset: assetId, facts, message, from, to }));

      let messageId = '';
      try {
        messageId = await nextMessageId();
        await at(BASE, encodeURIComponent(MSG_TABLE), {
          method: 'POST',
          body: JSON.stringify({ fields: {
            message_id: messageId,
            asset_id:   assetId,
            asset_name: assetName,
            to_name:    to.name,
            to_email:   to.email,
            from_name:  from.name,
            from_email: from.email,
            message,
            sent_at:    new Date().toISOString(),
            email_id:   emailId,
          } }),
        });
      } catch (e) {
        // The mail has already gone. Losing the log is bad but silently reporting
        // failure would be worse — the user would send it again.
        console.error('asset-message: sent but not recorded:', e.message);
        return res.status(200).json({
          ok: true, sent: true, recorded: false, emailId, to: to.name,
          warning: 'The email was sent, but it could not be recorded against the asset.',
        });
      }

      return res.status(200).json({ ok: true, sent: true, recorded: true, messageId, emailId, to: to.name });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('asset-message error:', e);
    return res.status(e.status || 500).json({ error: e.message || 'Request failed.' });
  }
};

module.exports.__test = { managers, assetFacts, buildEmail, validAssetId, messagesFor, nextMessageId };
