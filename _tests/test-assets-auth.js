// test-assets-auth.js — run with an ABSOLUTE path:
//   node <repo>/mrdc-assets-api/_tests/test-assets-auth.js
// Zero dependencies; no browser, no network, no credentials.
//
// Why this exists: until 2026-09-23 assets.js and media.js decided every
// authorization question from `x-user-role` / `x-app-role` — headers the caller
// sets — and inspections.js had no authentication of any kind. api/_auth.js had
// existed since July for asset-message.js and said so in its own header:
// "assets.js, media.js ... That is a rollout gate, not a security boundary, and
// working-agreement.md §7 has said so for weeks."
//
// The registry is the key every other app federates on, which is why it matters
// most here.
//
// What this pins:
//   · no caller -> 401 on all three handlers, before Airtable is touched
//   · a header is not a session and cannot upgrade a role
//   · the THREE gates keep their three different rules
//   · an Owner with no Assets Role still gets in  ← the lockout this nearly caused
//   · the DMT intake service key reads, and edits nothing
//   · a contractor session never edits the registry

const path = require('path');

const API      = path.join(__dirname, '..', 'api');
const authPath = path.join(API, '_auth.js');
const ASSETS   = path.join(API, 'assets.js');
const MEDIA    = path.join(API, 'media.js');
const INSPECT  = path.join(API, 'inspections.js');

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ` — ${x}` : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w),
  `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

process.env.AIRTABLE_PAT  = 'stub-pat';
process.env.ASSETS_BASE   = 'appStub';
process.env.INTAKE_SECRET = 'test-service-key';

let session = null, authCalls = 0, airtableCalls = 0, authFails = false;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('auth.mrdc-htra.com')) {
    authCalls++;
    if (authFails) throw new Error('auth unreachable');
    if (!session) return { ok: false, status: 401, json: async () => ({ ok: false }) };
    return { ok: true, status: 200, json: async () => session };
  }
  // Airtable must never be reached: getting that far means the guard did not stop it.
  airtableCalls++;
  return { ok: true, status: 200, json: async () => ({ records: [], id: 'rec1', fields: {} }) };
};

const assets  = require(ASSETS);
const media   = require(MEDIA);
const inspect = require(INSPECT);
const AUTH    = require(authPath);

const mkRes = () => {
  const r = { code: 0, body: null, headers: {} };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.getHeader = k => r.headers[k];
  return r;
};
const mkReq = (o = {}) => ({
  method: o.method || 'GET', query: o.query || {}, body: o.body, url: o.url || '/api/x',
  headers: Object.assign({},
    o.cookie === false ? {} : { cookie: 'htra_session=abc' },
    o.key ? { 'x-intake-key': o.key } : {},
    o.origin ? { origin: o.origin } : {},
    o.headers || {}),
});
const call = async (h, o) => { const res = mkRes(); await h(mkReq(o), res); return res; };

/* A session as auth would answer it. ⚠️ orgRole and appRole are SEPARATE —
   auth does not promote an Owner to an app Admin. */
const S = (orgRole, appRole, opts = {}) => ({
  ok: true, allowed: opts.allowed !== false,
  user: { name: opts.name || 'Test Person', email: 't@mrdc.ca', role: orgRole,
          source: opts.source || 'employee', employeeId: 'recEmp1' },
  apps: ['Assets'], appRole,
});

(async () => {

/* ── 1. No caller — where inspections.js was permanently, and the others were
       for anyone who did not send the headers ─────────────────────────────── */
{
  session = null;
  const routes = [
    ['assets GET',      assets,  {}],
    ['assets PATCH',    assets,  { method: 'PATCH', body: { rec: 'rec1' } }],
    ['assets POST',     assets,  { method: 'POST',  body: {} }],
    ['media GET',       media,   {}],
    ['media POST',      media,   { method: 'POST',  body: { fields: {} } }],
    ['media PATCH',     media,   { method: 'PATCH', body: { fields: {} } }],
    ['inspections GET', inspect, { query: { asset: 'MRDC-CV-1' } }],
  ];
  for (const [label, h, o] of routes) {
    airtableCalls = 0;
    const res = await call(h, { ...o, cookie: false });
    eq(label + ' with no cookie and no key is 401', res.code, 401);
    eq('  ...and never reached Airtable', airtableCalls, 0);
  }
}

/* ── 2. A header is not a session ──────────────────────────────────────────
   The exact spoof §7 has described for weeks. */
{
  session = null;
  const res = await call(assets, {
    cookie: false, method: 'PATCH', body: { rec: 'rec1' },
    headers: { 'x-user-role': 'Owner', 'x-app-role': 'Admin' },
  });
  eq('x-user-role: Owner with no cookie is still 401', res.code, 401);

  session = S('Employee', 'User');
  const res2 = await call(assets, {
    method: 'PATCH', body: { rec: 'rec1' },
    headers: { 'x-user-role': 'Owner', 'x-app-role': 'Admin' },
  });
  eq('and a User session is not upgraded by them', res2.code, 403);
}

/* ── 3. THE LOCKOUT THIS NEARLY CAUSED ─────────────────────────────────────
   ⚠️ auth's appRoleForEmployee() returns the per-app field if set, otherwise
   plain 'User' — it does NOT promote an Owner to an app Admin. (§6d of the
   working agreement says it does; the auth _lib.js does not. Verified
   2026-09-23.) The pre-existing _auth.getCaller collapsed the two roles into
   one `role`, so a gate reading only that would have refused an Owner who has
   no Assets Role — someone who can edit the registry today. */
{
  session = S('Owner', 'User');
  const c = await AUTH.getCaller(mkReq({}));
  ok('an Owner with NO Assets Role can still edit', c.canEdit === true, JSON.stringify(c));
  ok('  ...and create', c.canCreate === true);
  ok('  ...and write provenance', c.canAdmin === true);
  eq('  while their app role really is only User', c.appRole, 'User');
}

/* ── 4. The three gates keep their three rules ─────────────────────────────
   canEdit admits an Assets MANAGER; canCreate and canAdmin do not
   (Troy, 2026-08-26: "an add asset button ... for owner and admin only").
   Collapsing them is the easy mistake, so every combination is pinned. */
{
  const g = async (orgRole, appRole) => {
    const c = await AUTH.getCaller(mkReq({}), session = S(orgRole, appRole)) ||
              await (async () => { session = S(orgRole, appRole); return AUTH.getCaller(mkReq({})); })();
    session = S(orgRole, appRole);
    const cc = await AUTH.getCaller(mkReq({}));
    return [cc.canEdit, cc.canCreate, cc.canAdmin];
  };
  const cases = [
    ['Owner',      'User',    [true,  true,  true ]],
    ['Admin',      'User',    [true,  true,  true ]],
    ['Employee',   'Admin',   [true,  true,  true ]],
    ['Employee',   'Manager', [true,  false, false]],   // ← the one that differs
    ['Manager',    'User',    [false, false, false]],   // org Manager is nothing here
    ['Supervisor', 'User',    [false, false, false]],
    ['Employee',   'User',    [false, false, false]],
    ['Employee',   '',        [false, false, false]],
  ];
  for (const [org, app, want] of cases)
    eq(`gates — org ${org} / app ${app || '(none)'}`, await g(org, app), want);
}

/* ── 5. A contractor never edits the registry ──────────────────────────────
   An Admins-table session carries a third vocabulary ('Contractor'), and the
   Employees port warns that a contractor must never be one App Access tick away
   from something it should not have. */
{
  session = S('Admin', 'Admin', { source: 'admin' });
  const c = await AUTH.getCaller(mkReq({}));
  eq('a contractor session cannot edit', c.canEdit, false);
  eq('  ...nor create', c.canCreate, false);
  eq('  ...even carrying Admin in both role fields', c.isStaff, false);
}

/* ── 6. The DMT intake service key ─────────────────────────────────────────
   DMT Tool/api/intake.js reads `?id=<assetId>` server-side while raising a work
   order. It has no browser and no cookie. */
{
  session = null;
  const r = await call(assets, { cookie: false, key: 'test-service-key', query: { id: 'MRDC-CV-1' } });
  ok('a machine with the key can read the register', r.code !== 401, String(r.code));

  const bad = await call(assets, { cookie: false, key: 'wrong' });
  eq('a wrong key is still 401', bad.code, 401);

  const edit = await call(assets, { cookie: false, key: 'test-service-key',
    method: 'PATCH', body: { rec: 'rec1' } });
  eq('and the key edits nothing', edit.code, 403);
  eq('_auth: the service caller is not an editor', AUTH.SERVICE_CALLER.canEdit, false);
  eq('_auth: nor a creator', AUTH.SERVICE_CALLER.canCreate, false);
}

/* ── 7. An unset key must never match (§2b, fail-closed) ───────────────────*/
{
  const saved = process.env.INTAKE_SECRET;
  delete process.env.INTAKE_SECRET;
  delete require.cache[authPath];
  const fresh = require(authPath);
  ok('with INTAKE_SECRET unset an empty key does not match',
     !fresh.hasServiceKey({ headers: { 'x-intake-key': '' } }));
  ok('and neither does any other value',
     !fresh.hasServiceKey({ headers: { 'x-intake-key': 'anything' } }));
  process.env.INTAKE_SECRET = saved;
  delete require.cache[authPath];
  require(authPath);
}

/* ── 8. Not signed in, and auth down, are both 401 — never 500, never a pass */
{
  session = S('Owner', 'User', { allowed: false });
  // Until 2026-10-01 this asserted a GET was refused too. Troy changed that rule:
  // "assets should be available to all" — reads are open to any signed-in
  // employee (section 9). A WRITE without Assets access is still refused.
  eq('a signed-in caller without Assets access cannot write (401)', (await call(assets, { method: 'PATCH', body: { rec: 'rec1' } })).code, 401);

  session = S('Owner', 'User'); authFails = true;
  const down = await call(assets, {});
  authFails = false;
  eq('auth unreachable is 401', down.code, 401);
  ok('and not a 500', down.code !== 500, String(down.code));

  session = null; authCalls = 0;
  await call(assets, { cookie: false });
  eq('no cookie does not even call the auth service', authCalls, 0);
}

/* ── 9. Source assertions ──────────────────────────────────────────────────*/
{
  const fs = require('fs');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const [name, p] of [['assets.js', ASSETS], ['media.js', MEDIA], ['inspections.js', INSPECT]]) {
    const src = strip(fs.readFileSync(p, 'utf8'));
    ok(name + ' reads no x-user-* header', !/req\.headers\['x-(user|app)-/.test(src));
    const h = src.indexOf('module.exports = async');
    const guard = src.indexOf('await requireCallerOrService(req, res)', h);
    ok(name + ' resolves a caller in its handler', guard > 0);
    /* ⚠️ Credentialed CORS or the cookie never arrives — every caller of this
       API is cross-origin. Without it, signed-in requests read as anonymous. */
    ok(name + ' allows credentials on an allowed origin',
       /Access-Control-Allow-Credentials/.test(src),
       'the cookie will never be sent cross-origin without this');
  }
  const asrc = strip(fs.readFileSync(authPath, 'utf8'));
  ok('_auth.js builds identity only from the session',
     !/req\.headers\[[^\]]*x-(user|app)-/.test(asrc));
  /* The media provenance stamp — added_by / last_edited_by — must come from the
     session, or anyone can file a row under a colleague's name. */
  ok('media.js stamps the actor from the session',
     /caller\.name/.test(strip(fs.readFileSync(MEDIA, 'utf8'))));
}

/* ── 9. Reading the register is open to every signed-in employee ───────────
   Troy, 2026-10-01: "assets should be available to all". The DMT, Patrol and
   Timesheets asset pickers read ?all=1; without Assets access they fell back to
   typing the id. Writes are unchanged. */
{
  // An employee with NO Assets access (allowed:false), even with a stale Assets Role.
  session = S('Employee', 'Admin', { allowed: false });
  airtableCalls = 0;
  const g = await call(assets, { query: { all: '1' }, url: '/api/assets?all=1' });
  ok('no Assets access: GET the register is allowed', g.code !== 401 && g.code !== 403, String(g.code));
  ok('  ...and gets the register back', !!g.body && (Array.isArray(g.body) || Array.isArray(g.body.assets) || Array.isArray(g.body.data)), JSON.stringify(g.body).slice(0, 120));
  const r = await AUTH.requireReader(mkReq({}), mkRes());
  eq('  ...as read-only, whatever the Assets Role says', [r.readOnly, r.canEdit, r.canCreate, r.canAdmin], [true, false, false, false]);
  for (const [label, o] of [['PATCH', { method: 'PATCH', body: { rec: 'rec1' } }], ['POST (create)', { method: 'POST', body: {} }]]) {
    airtableCalls = 0;
    const w = await call(assets, o);
    eq(`no Assets access: ${label} is still refused`, w.code, 401);
    eq('  ...before Airtable', airtableCalls, 0);
  }
  const dbg = await call(assets, { query: { debug: '1' }, url: '/api/assets?debug=1' });
  eq('no Assets access: schema discovery is not opened', dbg.code, 403);
  // Scope: the register only. Media and inspections keep riding on Assets access.
  eq('no Assets access: media GET unchanged (401)', (await call(media, {})).code, 401);
  eq('no Assets access: inspections GET unchanged (401)', (await call(inspect, { query: { asset: 'MRDC-CV-1' } })).code, 401);

  // A contractor without Assets access is not "all".
  session = S('Contractor', '', { allowed: false, source: 'admin' });
  airtableCalls = 0;
  eq('a contractor without Assets access still cannot read', (await call(assets, { query: { all: '1' } })).code, 401);
  eq('  ...and never reached Airtable', airtableCalls, 0);

  // Someone WITH access keeps their write rights on a read.
  session = S('Employee', 'Manager');
  const m = await AUTH.requireReader(mkReq({}), mkRes());
  eq('with Assets access: a reader keeps canEdit', [!!m.readOnly, m.canEdit], [false, true]);
  // The service key still reads.
  session = null;
  const k = await call(assets, { cookie: false, key: 'test-service-key', query: { id: 'MRDC-CV-1' } });
  ok('the DMT intake key still reads', k.code !== 401, String(k.code));
  const src = require('fs').readFileSync(ASSETS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  ok('only GET uses the reader gate', /req\.method === 'GET' \? await requireReader\(req, res\) : await requireCallerOrService\(req, res\)/.test(src));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('   FAIL  ' + f)); process.exitCode = 1; }

})();
