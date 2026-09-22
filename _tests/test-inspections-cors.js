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
const cf = (SRC.match(/function cacheFor\(res, value\) \{[\s\S]*?\n\}/) || [''])[0];
ok('cacheFor() can be lifted too', !!cf);

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
  /* ⚠️ The rule is by CALLER. A named caller's response is kept by nobody; a
     caller that reflected nothing gets the cache the endpoint asked for. */
  const named = stub('https://www.mrdc-htra.com', '\ncacheFor(res, "public, max-age=60");');
  eq('a named caller\'s response is stored by nobody', named['Cache-Control'], 'no-store');
  const anon = stub(undefined, '\ncacheFor(res, "public, max-age=60");');
  ok('a caller with no Origin reflects nothing',
     !('Access-Control-Allow-Origin' in anon), JSON.stringify(anon));
  eq('so its response keeps the cache the endpoint asked for',
     anon['Cache-Control'], 'public, max-age=60');
}
{
  /* The only setHeader('Cache-Control', …) in the file is the one INSIDE
     cacheFor(). Any other is a branch that bypassed the rule. */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const set = (CODE.match(/setHeader\('Cache-Control',[\s\S]{0,80}?\)/g) || [])
    .filter(x => !/getHeader\('Access-Control-Allow-Origin'\)/.test(x));
  eq('no Cache-Control is set outside cacheFor()', set, []);
  /* Count the CALLS, not the definition — a branch that quietly stops setting
     a header at all would otherwise slip past a ">=" check. */
  const calls = (CODE.match(/cacheFor\(res,/g) || []).length - 1;
  eq('every cacheable branch goes through it, and none was dropped', calls, 2);
  ok('and cacheFor reads the header rather than re-deciding the origin',
     /res\.getHeader\('Access-Control-Allow-Origin'\) \? 'no-store' :/.test(SRC));
  ok('the reason is written down beside it',
     /ONE entry per URL/.test(SRC));
}
console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('   FAIL  ' + f)); process.exitCode = 1; }
