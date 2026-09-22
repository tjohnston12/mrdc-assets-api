/*
 * test-inspections-cors.js — the CORS + caching contract of /api/inspections
 * ---------------------------------------------------------------------------
 * Run:  node _tests/test-inspections-cors.js          (from mrdc-assets-api)
 * No network, no Airtable, no dependencies. applyCors() is
 * lifted out of the shipped source and run against a stub res.
 *
 * ⚠️ WHY THIS EXISTS. Access-Control-Allow-Origin here is REFLECTED — it names
 * ONE caller, so the same URL has a different correct answer for each of them.
 * Vary: Origin is what keeps those apart, and a browser honours it. A shared
 * cache in front of the function need not, and Vercel's edge does not.
 *
 * Found in production 2026-09-22 on the assets API: the patrol form could not
 * load the asset register at all — "Failed to fetch", and every deficiency row
 * reading "the asset register has not loaded", which looks like no signal. The
 * DMT had warmed the edge cache from its own origin moments before.
 * claude/asset-id-picker.md has the reproduction.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', "api/inspections.js"), 'utf8');

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ' — ' + x : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w),
                           `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

const cors = (SRC.match(/const ORIGIN_OK = [^\n]*\n+function applyCors\(req, res\) \{[\s\S]*?\n\}/) || [''])[0];
ok('applyCors() and its origin pattern can be lifted', !!cors);
const cf = '';

function stub(origin, tail) {
  const h = {};
  const res = { setHeader: (k, v) => { h[k] = v; }, getHeader: k => h[k] };
  const req = { headers: origin === undefined ? {} : { origin } };
  new Function('req', 'res', cors + '\n' + cf + '\napplyCors(req, res);' + (tail || ''))(req, res);
  return h;
}
{
  const www = stub('https://www.mrdc-htra.com');
  const dmt = stub('https://dmt.mrdc-htra.com');
  eq('the platform\'s web origin is allowed',
     www['Access-Control-Allow-Origin'], 'https://www.mrdc-htra.com');
  eq('and any other of its subdomains',
     dmt['Access-Control-Allow-Origin'], 'https://dmt.mrdc-htra.com');
  /* ⚠️ THE PROBLEM IN ONE ASSERTION: one URL, two different correct answers. */
  ok('the two answers differ, which is what makes a shared copy unsafe',
     www['Access-Control-Allow-Origin'] !== dmt['Access-Control-Allow-Origin']);
  eq('every response says it varies by origin', www['Vary'], 'Origin');
  eq('including one with no origin at all', stub()['Vary'], 'Origin');
  ok('a caller with no Origin gets no Allow-Origin',
     !('Access-Control-Allow-Origin' in stub()), JSON.stringify(stub()));
  ok('a look-alike domain is not allowed',
     !('Access-Control-Allow-Origin' in stub('https://mrdc-htra.com.evil.example')));
  ok('and neither is plain http',
     !('Access-Control-Allow-Origin' in stub('http://www.mrdc-htra.com')));
  eq('a Vercel preview is',
     stub('https://x-abc123.vercel.app')['Access-Control-Allow-Origin'],
     'https://x-abc123.vercel.app');
}
{
  /* Nothing here may be shared. Both summary responses used to be
     "public, max-age=60"; the reader keeps its minute, nothing else does. */
  const set = SRC.match(/Cache-Control',\s*[^)]*\)/g) || [];
  ok('the cache headers can be read out of the source', set.length > 0, String(set.length));
  eq('no response is cacheable by a shared cache', set.filter(s => /'public/.test(s)), []);
  ok('and every one of them is private or no-store',
     set.every(s => /'private|no-store/.test(s)), set.filter(s => !/'private|no-store/.test(s)).join(' | '));
  ok('the summaries are still cacheable by the reader',
     (SRC.match(/'private, max-age=60'/g) || []).length === 2,
     String((SRC.match(/'private, max-age=60'/g) || []).length));
  ok('the reason is written down beside applyCors',
     /REFLECTED/.test(SRC) && /edge does not/.test(SRC));
}
console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('   FAIL  ' + f)); process.exitCode = 1; }
