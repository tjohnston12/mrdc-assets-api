// api/_auth.js — server-side identity for the Assets API.
//
// ⚠️ The rest of this project (assets.js, media.js) reads identity from
// `x-user-*` headers, which a caller can set to anything. That is a rollout gate,
// not a security boundary, and `working-agreement.md` §7 has said so for weeks.
//
// It is not good enough for /api/asset-message, which SENDS EMAIL AS MRDC to real
// employees with a free-text body. A spoofable header there is a spam relay. So
// this file ports the pattern the Safety API already uses: forward the shared
// `htra_session` cookie (Domain=.mrdc-htra.com) to the auth service, which
// validates it and re-reads the caller's live role and app access.
//
// Only asset-message.js uses this today. Moving assets.js and media.js onto it is
// the real fix for §7 and is deliberately NOT bundled into this change.

const AUTH_URL = process.env.AUTH_URL || 'https://auth.mrdc-htra.com';
const APP      = process.env.AUTH_APP || 'Assets';

// Credentialed CORS: a specific origin, never '*'. A wildcard is illegal on a
// credentialed request and the browser drops the response, which looks exactly
// like a server error.
const ORIGIN = process.env.WEB_ORIGIN || 'https://www.mrdc-htra.com';

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

async function getCaller(req) {
  const cookie = req.headers.cookie || '';
  if (!/(?:^|;\s*)htra_session=/.test(cookie)) return null;
  let d;
  try {
    const r = await fetch(`${AUTH_URL}/api/session?app=${encodeURIComponent(APP)}`, { headers: { cookie } });
    if (!r.ok) return null;
    d = await r.json();
  } catch (_) {
    return null;
  }
  if (!d || !d.ok || !d.user) return null;

  const role = d.user.source === 'admin'
    ? (d.user.role || 'Contractor')
    : (d.appRole || 'User');

  return { user: d.user, apps: Array.isArray(d.apps) ? d.apps : [], role, allowed: d.allowed !== false };
}

// Any signed-in person WITH Assets access. Asking a question about an asset is not
// a privileged action — but doing it as MRDC, to a real mailbox, does require
// being a known person. `allowed` is the auth service's own App Access check.
async function requireSession(req, res) {
  const caller = await getCaller(req);
  if (!caller || !caller.allowed) {
    res.status(401).json({ error: 'Not signed in.' });
    return null;
  }
  return caller;
}

module.exports = { getCaller, requireSession, applyCors, APP, ORIGIN };
