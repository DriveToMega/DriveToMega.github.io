#!/usr/bin/env node
// Builds the deployable site into ./_site:
//  - copies only public files (no README, scripts, workflows),
//  - writes assets/js/config.js from the GOOGLE_CLIENT_ID env var (GitHub secret or variable),
//  - stamps the service-worker cache version with the commit so every deploy updates installed apps,
//  - verifies the vendored MEGA library still matches the SRI hash pinned in app.js.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '_site';
const PUBLIC = ['index.html', 'privacy.html', 'terms.html', '404.html', 'offline.html', 'sw.js', 'manifest.webmanifest',
  'favicon.ico', 'robots.txt', 'sitemap.xml', '.nojekyll', '.well-known', 'assets'];
const fail = msg => { console.error('✖ ' + msg); process.exit(1); };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const p of PUBLIC){
  if (!existsSync(p)) fail(`missing ${p}`);
  cpSync(p, join(OUT, p), { recursive: true });
}

// 1. Google OAuth Client ID (public identifier — NOT a secret, but kept out of git so forks configure their own).
const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
if (clientId && !/^[0-9]{6,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com$/.test(clientId))
  fail('GOOGLE_CLIENT_ID is not a valid OAuth Client ID (expected …apps.googleusercontent.com). Never use the client secret.');
const configPath = join(OUT, 'assets/js/config.js');
const config = readFileSync(configPath, 'utf8').replace(/googleClientId:\s*'[^']*'/, `googleClientId: ${JSON.stringify(clientId).replace(/"/g, "'")}`);
writeFileSync(configPath, config);
console.log(clientId ? `✔ Google Client ID injected (${clientId.slice(0, 8)}…)` : '• No GOOGLE_CLIENT_ID set — users will be asked for one in Settings.');

// 2. Service-worker cache version.
const sha = (process.env.GITHUB_SHA || '').slice(0, 7);
if (sha){
  const swPath = join(OUT, 'sw.js');
  writeFileSync(swPath, readFileSync(swPath, 'utf8').replace(/const VERSION = '([^']+)';/, `const VERSION = '$1+${sha}';`));
  console.log(`✔ Service worker version stamped with ${sha}`);
}

// 3. Subresource Integrity check for the vendored MEGA library.
const app = readFileSync('assets/js/app.js', 'utf8');
const src = app.match(/const MEGA_SRC = '\/([^']+)'/)?.[1];
const sri = app.match(/const MEGA_SRI = '([^']+)'/)?.[1];
if (!src || !sri) fail('could not find MEGA_SRC / MEGA_SRI in app.js');
const actual = 'sha384-' + createHash('sha384').update(readFileSync(src)).digest('base64');
if (actual !== sri) fail(`SRI mismatch for ${src}\n  expected ${sri}\n  actual   ${actual}`);
console.log('✔ megajs integrity verified');

// 4. Every page must carry a CSP and must not contain inline scripts or style attributes.
for (const page of ['index.html', 'privacy.html', 'terms.html', '404.html', 'offline.html']){
  const html = readFileSync(page, 'utf8');
  if (!html.includes('http-equiv="Content-Security-Policy"')) fail(`${page} has no CSP`);
  if (/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/i.test(html)) fail(`${page} has an inline <script>`);
  if (/\sstyle="/i.test(html)) fail(`${page} has an inline style attribute (blocked by CSP)`);
}
console.log('✔ CSP checks passed');
console.log(`Built ${OUT}/`);
