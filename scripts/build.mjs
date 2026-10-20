#!/usr/bin/env node
// Builds the deployable site into ./_site:
//  - copies only public files (no README, scripts, workflows),
//  - writes assets/js/config.js from the GOOGLE_CLIENT_ID env var (GitHub secret or variable),
//  - stamps the service-worker cache version with the commit so every deploy updates installed apps,
//  - verifies the vendored MEGA library still matches the SRI hash pinned in app.js.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '_site';
const PAGES = ['index.html', 'privacy.html', 'terms.html', '404.html', 'offline.html', 'how-to-transfer-google-drive-to-mega/index.html'];
const PUBLIC = [...new Set([...PAGES.map(p => p.split('/')[0]), 'sw.js', 'manifest.webmanifest', 'favicon.ico', 'apple-touch-icon.png',
  'browserconfig.xml', 'robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt', '.nojekyll', '.well-known', 'assets',
  // Search-engine ownership files dropped in the repo root (Google "HTML file" method, Bing XML file).
  ...readdirSync('.').filter(f => /^google[0-9a-f]+\.html$/.test(f) || f === 'BingSiteAuth.xml')])];
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

// 1b. Search-engine verification meta tags (Google Search Console "HTML tag" method, Bing Webmaster Tools).
//     Values are the content="…" token only. Public by nature, but kept out of git like the Client ID.
const verify = [['google-site-verification', process.env.GOOGLE_SITE_VERIFICATION], ['msvalidate.01', process.env.BING_SITE_VERIFICATION]]
  .map(([name, v]) => [name, (v || '').trim().replace(/^.*content="([^"]+)".*$/s, '$1')])
  .filter(([, v]) => v);
for (const [name, v] of verify) if (!/^[A-Za-z0-9_-]{10,100}$/.test(v)) fail(`${name} value looks wrong: paste only the content="…" token`);
const indexPath = join(OUT, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('<!--SITE_VERIFICATION-->',
  verify.map(([name, v]) => `<meta name="${name}" content="${v}">`).join('\n')));
console.log(verify.length ? `✔ Site verification tags: ${verify.map(([n]) => n).join(', ')}` : '• No site verification tags set');

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
for (const page of PAGES){
  const html = readFileSync(page, 'utf8');
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)){
    try { JSON.parse(json); } catch (e){ fail(`${page} has invalid JSON-LD: ${e.message}`); }
  }
  if (!/<title>[^<]{10,70}<\/title>/.test(html)) fail(`${page}: <title> missing or not 10–70 characters`);
  if (!html.includes('http-equiv="Content-Security-Policy"')) fail(`${page} has no CSP`);
  if (/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/i.test(html)) fail(`${page} has an inline <script>`);
  if (/\sstyle="/i.test(html)) fail(`${page} has an inline style attribute (blocked by CSP)`);
}
console.log('✔ CSP, title and JSON-LD checks passed');
console.log(`Built ${OUT}/`);
