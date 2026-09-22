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

/* ══ 2 · nothing cacheable is public ══════════════════════════════════════ */
{
  const set = SRC.match(/Cache-Control',\s*[^)]*\)/g) || [];
  ok('the cache headers can be read out of the source', set.length > 0, String(set.length));
  const pub = set.filter(s => /'public/.test(s));
  eq('no response is cacheable by a shared cache', pub, []);
  /* And they are actually there — a file with none would pass the line above
     while caching nothing at all, or everything by default. */
  ok('the register response is still cacheable by the reader',
     /res\.setHeader\('Cache-Control', 'private, max-age=300'\);\n    return res\.status\(200\)\.json\(register\);/.test(SRC));
  ok('and every one of them is private or no-store',
     set.every(s => /'private|no-store/.test(s)), set.filter(s => !/'private|no-store/.test(s)).join(' | '));
}
{
  /* ?fresh=1 exists because "private" still lets the BROWSER hold a record for
     five minutes, and saving an edit has to show the edit. */
  ok('?fresh=1 still bypasses the reader\'s own cache',
     /fresh \? 'no-store' : 'private, max-age=300'/.test(SRC));
}
{
  /* The reflected header and the caching rule live together; a future reader
     changing one has to meet the other. */
  ok('the reason is written down beside applyCors, not only here',
     /reflected/i.test(SRC) && /Vercel's edge does not/.test(SRC));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('   FAIL  ' + f)); process.exitCode = 1; }
