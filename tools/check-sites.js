/**
 * Verify the site adapters and their manifest wiring.
 *
 * This repo has no other tests, so this is the safety net for the one thing
 * that is easiest to get subtly wrong: adding a site. A missing manifest match
 * means the button never appears, and a missing feature flag silently hides a
 * control (that is how the overlay's Cover tab went missing once).
 *
 * Run from the repo root:
 *
 *   node tools/check-sites.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const ext = path.join(root, 'extension');

const { detect, isMediaPage, SITES, SITE_HOSTS, cookieDomainsFor, siteFor } =
  await import(pathToFileURL(path.join(ext, 'sites.js')).href);

let pass = 0;
const fails = [];

function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
  } else {
    fails.push(
      `${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Detection: every site's URL shapes
// ---------------------------------------------------------------------------

const DETECTION = [
  // YouTube
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ['https://youtu.be/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/shorts/abc123', 'youtube', 'abc123'],
  // X
  ['https://x.com/u/status/1234567890', 'x', '1234567890'],
  ['https://twitter.com/u/status/1234567890', 'x', '1234567890'],
  // Douyin
  ['https://www.douyin.com/video/7300000000000000000', 'douyin', '7300000000000000000'],
  ['https://www.douyin.com/note/7300000000000000000', 'douyin', '7300000000000000000'],
  ['https://www.douyin.com/?modal_id=7300000000000000000', 'douyin', '7300000000000000000'],
  ['https://www.douyin.com/discover?modal_id=7300000000000000000', 'douyin', '7300000000000000000'],
  ['https://www.iesdouyin.com/share/video/7300000000000000000/', 'douyin', '7300000000000000000'],
  ['https://v.douyin.com/iAbCdEf/', 'douyin', 'iAbCdEf'],
];

for (const [url, site, id] of DETECTION) {
  const r = detect(url);
  check(`detect ${url}`, r ? [r.siteId, r.id] : null, [site, id]);
}

// Non-media pages must not look downloadable.
for (const url of [
  'https://www.douyin.com/',
  'https://www.douyin.com/user/MS4wLjABAAAAxyz',
  'https://www.douyin.com/search/cat',
  'https://www.youtube.com/feed/subscriptions',
  'https://x.com/home',
  'https://example.com/video/1',
]) {
  check(`not media: ${url}`, detect(url), null);
  check(`not media page: ${url}`, isMediaPage(url), false);
}

// ---------------------------------------------------------------------------
// Adapter shape
// ---------------------------------------------------------------------------

/** Flags the UI reads. A missing one silently hides its control. */
const FEATURES = [
  'qualityLadder', 'subtitles', 'sponsorblock', 'audioOnly', 'playlist', 'merging', 'thumbnails',
];

for (const site of SITES) {
  for (const f of FEATURES) {
    check(`${site.id}.features.${f} is declared`, typeof site.features[f], 'boolean');
  }
  for (const fn of ['test', 'parse', 'isMediaPage', 'hasMediaInPage']) {
    check(`${site.id}.${fn} is a function`, typeof site[fn], 'function');
  }
  check(`${site.id} has cookieDomains`, Array.isArray(site.cookieDomains), true);
  check(`${site.id} has a cookieProfile`, typeof site.cookieProfile, 'string');
}

check('adapter ids', SITES.map((s) => s.id), ['youtube', 'x', 'douyin']);
check('douyin cookie domains',
  cookieDomainsFor('https://www.douyin.com/video/7300000000000000000'),
  ['.douyin.com', '.iesdouyin.com']);
check('siteFor picks douyin for share links', siteFor('https://v.douyin.com/abc')?.id, 'douyin');

// ---------------------------------------------------------------------------
// Manifest wiring
// ---------------------------------------------------------------------------

const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const contentMatches = manifest.content_scripts.flatMap((c) => c.matches);
const warMatches = manifest.web_accessible_resources.flatMap((w) => w.matches);

for (const host of SITE_HOSTS) {
  check(`content_scripts covers ${host}`, contentMatches.includes(host), true);
}

// Every adapter's main host must be reachable by the content script, or the
// button never appears on that site.
const REQUIRED_HOSTS = {
  youtube: 'https://www.youtube.com/*',
  x: 'https://x.com/*',
  douyin: 'https://www.douyin.com/*',
};
for (const [id, host] of Object.entries(REQUIRED_HOSTS)) {
  check(`${id} is injected on ${host}`, contentMatches.includes(host), true);
}

check('host_permissions covers douyin',
  manifest.host_permissions.some((h) => h.includes('douyin.com')), true);
check('host_permissions covers iesdouyin',
  manifest.host_permissions.some((h) => h.includes('iesdouyin.com')), true);
check('web_accessible_resources covers douyin',
  warMatches.some((m) => m.includes('douyin.com')), true);
check('description lists the supported sites',
  /youtube/i.test(manifest.description) &&
  /x\b/i.test(manifest.description) &&
  /douyin/i.test(manifest.description), true);

// ---------------------------------------------------------------------------
// Server-side error mapping
// ---------------------------------------------------------------------------

const { explainYtDlpError } = await import(pathToFileURL(path.join(root, 'server', 'ytdlp.js')).href);

const douyinError = explainYtDlpError({
  stderr: '[Douyin] 7300000000000000000: Fresh cookies (not necessarily logged in) are needed',
});
check('Douyin cookie failure is explained',
  /cookie/i.test(douyinError) && /douyin/i.test(douyinError), true);

// ---------------------------------------------------------------------------

console.log('');
if (fails.length === 0) {
  console.log(`  OK  ${pass} checks passed\n`);
  process.exit(0);
}
console.log(`  ${pass} passed, ${fails.length} FAILED:\n`);
for (const f of fails) console.log(`    - ${f}`);
console.log('');
process.exit(1);
