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
//
// ── 2026-09-23: that move happened. assets.js, media.js and inspections.js now
// use this file too, so what follows was added for them.
//
// ⚠️ orgRole AND appRole ARE BOTH EXPOSED, SEPARATELY. The `role` field below
// collapses them (app role for staff, Admins-table role for contractors), which
// is all asset-message needed. The assets/media gates need both halves:
//     canEdit = orgRole Owner/Admin  OR  appRole Admin/Manager
// and auth does NOT promote an Owner to an app Admin — appRoleForEmployee()
// returns the per-app field if set, otherwise plain 'User'. So an Owner with no
// Assets Role resolves to appRole 'User', and a gate reading only the collapsed
// `role` would LOCK THAT OWNER OUT of a registry they can edit today.
// (working-agreement §6d says an Owner maps to 'Admin' in every app; the auth
// _lib.js does not do that. Verified 2026-09-23.)

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

  const orgRole = d.user.role || '';
  const appRole = d.appRole || '';
  const isStaff = d.user.source === 'employee';

  /* The three gates assets.js has always had, reproduced exactly — from the
     validated session instead of from x-user-* headers. They differ on purpose
     and §2b says to keep the names apart:
       · canEdit   — correct an asset that exists. Assets MANAGER included.
       · canCreate — mint a new federation key. Manager NOT included
                     (Troy, 2026-08-26: "for owner and admin only").
       · canAdmin  — write the provenance fields. Same rule as canCreate.
     ⚠️ Guarded on isStaff: an Admins-table session carries a third vocabulary
     (`Contractor`), and a contractor must never edit the registry. */
  const orgAdmin = isStaff && (orgRole === 'Owner' || orgRole === 'Admin');

  return {
    user: d.user,
    apps: Array.isArray(d.apps) ? d.apps : [],
    role, orgRole, appRole, isStaff,
    isService: false,
    name: d.user.name || '',
    canEdit:   orgAdmin || (isStaff && (appRole === 'Admin' || appRole === 'Manager')),
    canCreate: orgAdmin || (isStaff && appRole === 'Admin'),
    canAdmin:  orgAdmin || (isStaff && appRole === 'Admin'),
    allowed: d.allowed !== false,
  };
}

/* The service key, for the one machine that reads this API: DMT Tool's
   api/intake.js fetches `?id=<assetId>` server-side while raising a work order.
   It has no browser and no cookie.

   ⚠️ Never compared when unset — `!!SERVICE_KEY &&` is what stops an
   unconfigured deployment matching a caller that also sends nothing (§2b, "an
   auth guard conditional on a secret existing is not a guard"). Same header and
   variable name as NC's nc-intake and the DMT's, so there is one spelling. */
const SERVICE_KEY = (process.env.INTAKE_SECRET || '').trim();

const SERVICE_CALLER = Object.freeze({
  isService: true, name: 'DMT intake',
  role: '', orgRole: '', appRole: '', isStaff: false,
  // A machine reads the register. It never edits it.
  canEdit: false, canCreate: false, canAdmin: false,
  allowed: true,
});

function hasServiceKey(req) {
  const supplied = String(req.headers['x-intake-key'] || '');
  return !!SERVICE_KEY && supplied === SERVICE_KEY;
}

/* A signed-in person with Assets access, OR the DMT intake machine.
   ⚠️ Call BEFORE the handler's try/catch, or the 401 is swallowed and
   re-reported as a 500 (§2b). */
async function requireCallerOrService(req, res) {
  const caller = await getCaller(req);
  if (caller && caller.allowed) return caller;
  if (hasServiceKey(req)) return SERVICE_CALLER;
  res.status(401).json({ error: 'Not signed in.' });
  return null;
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

/* READING the register: any signed-in MRDC EMPLOYEE, with or without Assets
   access, or the DMT intake machine. Troy, 2026-10-01: "assets should be
   available to all" — the asset pickers in the DMT, Patrol and Timesheets all
   read this register, and a person without Assets access got "the asset register
   has not loaded" and had to type the id (which is how typos get in).

   ⚠️ READ ONLY. A caller let in here WITHOUT Assets access has canEdit /
   canCreate / canAdmin forced false, whatever their Assets Role says — App
   Access is still what grants a write, and every write path keeps using
   requireCallerOrService. A contractor (Admins-table session) without Assets
   access is still refused: "all" means MRDC staff. */
async function requireReader(req, res) {
  const caller = await getCaller(req);
  if (caller && caller.allowed) return caller;
  if (caller && caller.isStaff) {
    return Object.assign({}, caller, { canEdit: false, canCreate: false, canAdmin: false, readOnly: true });
  }
  if (hasServiceKey(req)) return SERVICE_CALLER;
  res.status(401).json({ error: 'Not signed in.' });
  return null;
}

module.exports = {
  getCaller, requireSession, requireCallerOrService, requireReader, hasServiceKey,
  applyCors, APP, ORIGIN, SERVICE_CALLER,
};
