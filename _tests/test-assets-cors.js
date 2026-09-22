/*
 * test-assets-cors.js — the CORS + caching contract of /api/assets
 * ---------------------------------------------------------------------------
 * Run:  node _tests/test-assets-cors.js        (from mrdc-assets-api)
 * No network, no Airtable, no dependencies. applyCors() is lifted out of
 * api/assets.js and run against a stub req/res; the cache headers are read out
 * of the source.
 *
 * ⚠️ WHY THIS EXISTS. Access-Control-Allow-Origin here is REFLECTED — it names
 * ONE caller, so the same URL has a different correct answer for www. and for
 * dmt. Vary: Origin is what is supposed to keep those apart. A browser honours
 * it; a shared cache in front of this function need not, and Vercel's edge does
 * not.
 *
 * Found in production 2026-09-22: the patrol form on www.mrdc-htra.com could
 * not load the asset register at all. "Failed to fetch", no detail, every
 * deficiency row reading "the asset register has not loaded" — which reads like
 * no signal. The DMT had fetched ?all=1 from dmt.mrdc-htra.com moments before;
 * the edge kept that response, Allow-Origin and all, and served it to www.
 * Fetch ?all=1 from one origin then the other and it swaps over: whichever
 * warmed the cache last works, and the other silently gets nothing.
 *
 * The rule these tests hold: a response carrying a reflected Allow-Origin is
 * never "public". Adding a cacheable branch to assets.js means adding a private
 * one, and this file fails if it does not.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'assets.js'), 'utf8');

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ' — ' + x : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w),
                           `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

/* ══ 1 · applyCors, lifted and run ════════════════════════════════════════ */
const lifted = (SRC.match(/const ORIGIN_OK = [^\n]*\nfunction applyCors\(req, res\) \{[\s\S]*?\n\}/) || [''])[0];
ok('applyCors() and its origin pattern can be lifted', !!lifted);

function headersFor(origin) {
  const h = {};
  const res = { setHeader: (k, v) => { h[k] = v; } };
  const req = { headers: origin === undefined ? {} : { origin } };
  new Function('req', 'res', lifted + '\napplyCors(req, res);')(req, res);
  return h;
}
{
  const www = headersFor('https://www.mrdc-htra.com');
  eq('the platform\'s own web origin is allowed',
     www['Access-Control-Allow-Origin'], 'https://www.mrdc-htra.com');
  const dmt = headersFor('https://dmt.mrdc-htra.com');
  eq('and so is the DMT, which is a different host',
     dmt['Access-Control-Allow-Origin'], 'https://dmt.mrdc-htra.com');
  /* ⚠️ THE WHOLE PROBLEM IN ONE ASSERTION: one URL, two different correct
     answers. Anything that stores the response without keying on the origin is
     serving one of these callers the other one's header. */
  ok('the two answers differ, which is what makes a shared cache unsafe',
     www['Access-Control-Allow-Origin'] !== dmt['Access-Control-Allow-Origin']);

  eq('every response says it varies by origin', www['Vary'], 'Origin');
  eq('including one with no origin at all', headersFor()['Vary'], 'Origin');
}
{
  /* Server-to-server callers (DMT intake) send no Origin. Setting a header for
     a caller that did not ask is how a wrong origin gets cached and reused. */
  const none = headersFor();
  ok('a caller with no Origin gets no Allow-Origin',
     !('Access-Control-Allow-Origin' in none), JSON.stringify(none));
}
{
  const bad = headersFor('https://mrdc-htra.com.evil.example');
  ok('a look-alike domain is not allowed',
     !('Access-Control-Allow-Origin' in bad), JSON.stringify(bad));
  const http = headersFor('http://www.mrdc-htra.com');
  ok('and neither is plain http', !('Access-Control-Allow-Origin' in http), JSON.stringify(http));
  const sub = headersFor('https://audits.mrdc-htra.com');
  eq('any of the platform\'s own subdomains is',
     sub['Access-Control-Allow-Origin'], 'https://audits.mrdc-htra.com');
  const prev = headersFor('https://mrdc-assets-api-abc123.vercel.app');
  eq('as is a Vercel preview',
     prev['Access-Control-Allow-Origin'], 'https://mrdc-assets-api-abc123.vercel.app');
}

/* ══ 2 · the caching rule is by CALLER, not by endpoint ══════════════════
   ⚠️ "private" was the first fix and it was only half of one. It stops the
   edge sharing the response, and then the BROWSER'S own cache does the same
   thing: it keeps one entry per URL and hands the stored one to the next
   origin that asks. Measured in production 2026-09-22, after that deploy — a
   plain fetch of ?all=1 from dmt.mrdc-htra.com still failed while the same
   fetch with cache:'no-store' succeeded. */
const cf = (SRC.match(/function cacheFor\(res, value\) \{[\s\S]*?\n\}/) || [''])[0];
ok('cacheFor() can be lifted', !!cf);
function withCache(origin, value) {
  const h = {};
  const res = { setHeader: (k, v) => { h[k] = v; }, getHeader: k => h[k] };
  const req = { headers: origin === undefined ? {} : { origin } };
  new Function('req', 'res', lifted + '\n' + cf +
    '\napplyCors(req, res); cacheFor(res, ' + JSON.stringify(value) + ');')(req, res);
  return h;
}
{
  const named = withCache('https://www.mrdc-htra.com', 'public, max-age=300');
  eq('a named caller is named in the response',
     named['Access-Control-Allow-Origin'], 'https://www.mrdc-htra.com');
  eq('and its response is stored by nobody', named['Cache-Control'], 'no-store');
  const dmt = withCache('https://dmt.mrdc-htra.com', 'public, max-age=300');
  eq('the same for any other named caller', dmt['Cache-Control'], 'no-store');

  /* A server-to-server caller — DMT intake's ?id= lookups — sends no Origin,
     reflects nothing, and gets a response that is the same for everybody. */
  const anon = withCache(undefined, 'public, max-age=300');
  ok('a caller with no Origin reflects nothing',
     !('Access-Control-Allow-Origin' in anon), JSON.stringify(anon));
  eq('so it keeps the cache the endpoint asked for',
     anon['Cache-Control'], 'public, max-age=300');
  eq('and a no-store endpoint stays no-store for it',
     withCache(undefined, 'no-store')['Cache-Control'], 'no-store');
}
{
  /* ⚠️ The only setHeader('Cache-Control', …) in the file is the one inside
     cacheFor(). Any other is a branch that went round the rule. */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const stray = (CODE.match(/setHeader\('Cache-Control',[\s\S]{0,80}?\)/g) || [])
    .filter(x => !/getHeader\('Access-Control-Allow-Origin'\)/.test(x));
  eq('no Cache-Control is set outside cacheFor()', stray, []);
  ok('every cacheable branch goes through it',
     (SRC.match(/cacheFor\(res,/g) || []).length >= 5,
     String((SRC.match(/cacheFor\(res,/g) || []).length));
  ok('cacheFor decides from the header that was actually set',
     /res\.getHeader\('Access-Control-Allow-Origin'\) \? 'no-store' :/.test(SRC));
  ok('the register is still the endpoint that asks for five minutes',
     /cacheFor\(res, 'public, max-age=300'\);\n    return res\.status\(200\)\.json\(register\);/.test(SRC));
  ok('?fresh=1 still refuses a cache even for a caller that would get one',
     /cacheFor\(res, fresh \? 'no-store' : 'public, max-age=300'\)/.test(SRC));
  ok('the reason is written down beside applyCors, not only here',
     /REFLECTED/.test(SRC) && /ONE entry per URL/.test(SRC));
}
console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('   FAIL  ' + f)); process.exitCode = 1; }
