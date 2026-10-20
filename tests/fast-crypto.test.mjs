// Differential tests: assets/js/mega-fast-crypto.js must behave exactly like megajs.
//  1. encryptStream() ciphertext + 32-byte file key == megajs encrypt() for every edge-case size.
//  2. A full upload through megajs `uploadCiphertext` sends MEGA the same bytes and the same "p" (create file)
//     command as a normal megajs upload.
// Re-run after upgrading megajs. From the repository root:
//   npm i --no-save playwright@1.56.1 && npx playwright install chromium && node tests/fast-crypto.test.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PAGE = '<!doctype html><script src="/assets/vendor/megajs-1.3.10.min.js"></script><script src="/assets/js/mega-fast-crypto.js"></script>';
const srv = http.createServer((q, s) => {
  const p = q.url.split('?')[0];
  if (p === '/test.html'){ s.writeHead(200, { 'content-type': 'text/html' }); return s.end(PAGE); }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)){ s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': 'text/javascript' }); s.end(fs.readFileSync(f));
}).listen(0);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto(`http://localhost:${srv.address().port}/test.html`);

const result = await page.evaluate(async () => {
  const rnd = n => { const a = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(a.subarray(i, Math.min(n, i + 65536))); return a; };
  const pieces = function* (d){ let i = 0; while (i < d.length){ const n = 1 + Math.floor(Math.random() * 70000); yield d.subarray(i, i + n); i += n; } };
  const eq = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
  const pool = MegaFastCrypto.pool();

  // ---- 1. stream equivalence ----
  const ref = (key24, data) => new Promise(resolve => {
    const enc = mega.encrypt(key24), out = [];
    enc.on('data', c => out.push(new Uint8Array(c)));
    enc.on('end', () => { const ct = new Uint8Array(data.length); let o = 0; for (const c of out){ ct.set(c, o); o += c.length; } resolve({ ct, key: new Uint8Array(enc.key) }); });
    for (const pc of pieces(data)) enc.write(pc);
    enc.end();
  });
  const fast = async (key24, data) => {
    const ct = new Uint8Array(data.length); let o = 0, early = null;
    const r = await MegaFastCrypto.encryptStream({ pool, size: data.length, key24, source: (async function* (){ yield* pieces(data); })(),
      write: async u => { ct.set(u, o); o += u.length; }, beforeLast: k => { early = k; } });
    return { ct, key: r.key32, early };
  };
  const K = 131072;
  const sizes = [0, 1, 15, 16, 17, 100, K - 17, K - 16, K - 15, K - 1, K, K + 1, 3 * K - 1, 3 * K, 3 * K + 1,
    36 * K - 16, 36 * K - 15, 36 * K, 36 * K + 1, 44 * K, 44 * K + 5, 5 * 1048576 + 7, 12345678];
  const streamFailures = [];
  for (const size of sizes){
    const key24 = rnd(24), data = rnd(size);
    const [a, b] = [await ref(key24, data), await fast(key24, data)];
    if (!eq(a.ct, b.ct) || !eq(a.key, b.key) || !eq(a.key, b.early)) streamFailures.push(size);
  }

  // ---- 2. upload equivalence (fake MEGA API through megajs's fetch option) ----
  const upload = async (mode, data, key24) => {
    const got = { chunks: [], p: null }; let total = 0;
    const fetch = async (url, init) => {
      if (url.includes('/cs?')){
        const cmd = JSON.parse(init.body)[0];
        if (cmd.a === 'u') return new Response(JSON.stringify([{ p: 'https://gfs1.userstorage.mega.co.nz/ul/x' }]));
        if (cmd.a === 'p'){ got.p = cmd; return new Response('[-9]'); }
        return new Response('[0]');
      }
      const body = new Uint8Array(init.body);
      got.chunks.push([Number(url.split('/').pop()), body]); total += body.length;
      return new Response(total === data.length ? new Uint8Array(27).fill(9) : new Uint8Array(0));
    };
    const storage = mega.Storage.fromJSON({ options: { fetch, keepalive: false }, key: 'AAECAwQFBgcICQoLDA0ODw', sid: 's', name: 'n', user: 'u' });
    storage.shareKeys = {};
    const root = new mega.MutableFile({ h: 'ROOTROOT', t: 2 }, storage);
    const feed = src => (async function* (){ for (let i = 0; i < src.length; i += 50000) yield src.subarray(i, i + 50000); })();
    if (mode === 'ref'){
      const up = root.upload({ name: 'file.bin', size: data.length, key: key24 });
      up.on('error', () => {});
      for await (const c of feed(data)) up.write(c);
      up.end();
    } else {
      const key32 = storage.key.constructor.alloc(32);
      const up = root.upload({ name: 'file.bin', size: data.length, key: key32, uploadCiphertext: true });
      up.on('error', () => {});
      await MegaFastCrypto.encryptStream({ pool, size: data.length, key24, source: feed(data),
        write: u => up.write(u) ? undefined : new Promise(r => up.once('drain', r)), beforeLast: k => key32.set(k) });
      up.end();
    }
    for (let i = 0; i < 100 && !got.p; i++) await new Promise(r => setTimeout(r, 50));
    const bytes = new Uint8Array(data.length); for (const [o, c] of got.chunks) bytes.set(c, o);
    return { p: got.p && JSON.stringify(got.p), bytes };
  };
  const uploadFailures = [];
  for (const size of [1, K, 3 * K, 3500000]){
    const data = rnd(size), key24 = rnd(24);
    const [a, b] = [await upload('ref', data, key24), await upload('fast', data, key24)];
    if (!a.p || a.p !== b.p || !eq(a.bytes, b.bytes)) uploadFailures.push(size);
  }

  // ---- throughput ----
  const big = rnd(64 * 1048576), key24 = rnd(24);
  let t = performance.now(); await ref(key24, big.subarray(0, 16 * 1048576)); const refMBps = 16 / ((performance.now() - t) / 1000);
  t = performance.now(); await fast(key24, big); const fastMBps = 64 / ((performance.now() - t) / 1000);
  return { cases: sizes.length, streamFailures, uploadFailures, refMBps, fastMBps, workers: pool.size };
});

await browser.close();
srv.close();
console.log(`stream equivalence: ${result.cases - result.streamFailures.length}/${result.cases} sizes identical`, result.streamFailures.length ? result.streamFailures : '');
console.log(`upload equivalence: ${4 - result.uploadFailures.length}/4 uploads identical`, result.uploadFailures.length ? result.uploadFailures : '');
console.log(`throughput: megajs ${result.refMBps.toFixed(1)} MB/s · fast (${result.workers} workers) ${result.fastMBps.toFixed(1)} MB/s`);
process.exit(result.streamFailures.length || result.uploadFailures.length ? 1 : 0);
