/* Drive to MEGA: multi-core MEGA encryption.
 * megajs encrypts in pure JavaScript on the main thread (~10–40 MB/s). This module does the same work with
 * hardware AES (WebCrypto) spread across a pool of Web Workers, then hands the ciphertext to megajs's
 * `uploadCiphertext` mode. Output (ciphertext, chunk MACs, meta-MAC, 32-byte file key) is byte-identical to
 * megajs's own `encrypt()` stream; tests/fast-crypto.test.mjs verifies that differentially. */
(() => {
'use strict';
const subtle = globalThis.crypto && globalThis.crypto.subtle;

/** MEGA chunk sizes: 128 KiB, 256 KiB, … growing by 128 KiB up to 1 MiB, then 1 MiB each. */
function* chunkSizes(){
  for (let s = 131072; s < 1048576; s += 131072) yield s;
  for (;;) yield 1048576;
}

class Pool {
  constructor(size, url){
    this.size = size;
    this.seq = 0;
    this.jobs = new Map();
    this.broken = null;
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(url);
      w.pending = 0;
      w.onmessage = ({ data }) => {
        const job = this.jobs.get(data.id);
        if (!job) return;
        this.jobs.delete(data.id); w.pending--;
        data.error ? job.reject(new Error('Encryption worker: ' + data.error)) : job.resolve(data);
      };
      w.onerror = e => { e.preventDefault?.(); this.fail(new Error('Encryption worker crashed: ' + (e.message || 'unknown error'))); };
      return w;
    });
  }
  fail(err){
    this.broken = err;
    for (const job of this.jobs.values()) job.reject(err);
    this.jobs.clear();
    for (const w of this.workers) w.terminate();
  }
  /** Encrypt one chunk. `buf` (an ArrayBuffer) is transferred to the worker and must not be reused. */
  run(key, nonce, offset, buf){
    if (this.broken) return Promise.reject(this.broken);
    const w = this.workers.reduce((a, b) => (b.pending < a.pending ? b : a));
    const id = ++this.seq;
    w.pending++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      w.postMessage({ id, key, nonce, offset, buf }, [buf]);
    });
  }
}

/** One AES-128-ECB block via AES-CBC with a zero IV (WebCrypto has no ECB mode). */
async function ecbBlock(cbcKey, block){
  return new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, cbcKey, block), 0, 16);
}

/** megajs `condense()`: fold chunk MACs through AES-ECB, then XOR down to an 8-byte meta-MAC. */
async function metaMac(key16, macs){
  const cbcKey = await subtle.importKey('raw', key16, 'AES-CBC', false, ['encrypt']);
  let e = new Uint8Array(16);
  for (const m of macs){
    for (let i = 0; i < 16; i++) e[i] ^= m[i];
    e = await ecbBlock(cbcKey, e);
  }
  const v = new DataView(e.buffer, e.byteOffset, 16);
  const out = new Uint8Array(8), o = new DataView(out.buffer);
  o.setInt32(0, v.getInt32(0) ^ v.getInt32(4));
  o.setInt32(4, v.getInt32(8) ^ v.getInt32(12));
  return out;
}

/** megajs `zS()`: 32-byte file key = (aesKey ⊕ (nonce ‖ mac)) ‖ nonce ‖ mac. */
function fileKey(key24, mac8){
  const k = new Uint8Array(32);
  k.set(key24, 0); k.set(mac8, 24);
  for (let i = 0; i < 16; i++) k[i] ^= k[16 + i];
  return k;
}

/**
 * Stream-encrypt `source` (async iterable of Uint8Array, exactly `size` bytes).
 *  write(u8)          → Promise; called with ciphertext in order (apply backpressure inside).
 *  beforeLast(key32)  → called with the final 32-byte file key before the last chunk is written
 *                       (megajs reads the key only once the upload completes, so it can be filled in late).
 * Returns { key32, macs }.
 */
async function encryptStream({ pool, source, size, key24, write, beforeLast, signal, onError }){
  const key16 = key24.slice(0, 16), nonce = key24.slice(16, 24);
  const sizes = chunkSizes();
  const maxInFlight = Math.max(4, pool.size * 2);
  const queue = [];
  const macs = [];
  let offset = 0, received = 0;
  let cur = null, curLen = 0, curSize = 0;

  const finishKey = async () => {
    // megajs pushes one extra (nonce ‖ nonce) MAC when the padded length lands exactly on a chunk boundary,
    // and that same MAC alone for an empty file. Mirror it so keys match megajs byte for byte.
    const padded = Math.ceil(size / 16) * 16;
    let boundary = 0;
    for (const s of chunkSizes()){ if (boundary >= padded) break; boundary += s; }
    if (padded === boundary){ const nn = new Uint8Array(16); nn.set(nonce, 0); nn.set(nonce, 8); macs.push(nn); }
    const key32 = fileKey(key24, await metaMac(key16, macs));
    await beforeLast(key32);
    return key32;
  };
  let key32 = null;
  const flushHead = async () => {
    const { promise, last } = queue.shift();
    const r = await promise;
    macs.push(new Uint8Array(r.mac));
    if (last) key32 = await finishKey();
    await write(new Uint8Array(r.ct));
  };
  const dispatch = async (buf, len) => {
    const at = offset; offset += len;
    const data = len === buf.byteLength ? buf : buf.slice(0, len);
    const promise = pool.run(key16, nonce, at, data);
    promise.catch(() => {}); // surfaced in order by flushHead
    queue.push({ promise, last: offset === size });
    while (queue.length >= maxInFlight) await flushHead();
  };

  try {
    for await (const piece of source){
      if (signal && signal.aborted) throw new Error('Cancelled');
      received += piece.length;
      if (received > size) throw Object.assign(new Error('File is larger than Google reported.'), { retryable: true });
      let p = 0;
      while (p < piece.length){
        if (!cur){ curSize = Math.min(sizes.next().value, size - offset); cur = new ArrayBuffer(curSize); curLen = 0; }
        const n = Math.min(curSize - curLen, piece.length - p);
        new Uint8Array(cur, curLen, n).set(piece.subarray(p, p + n));
        curLen += n; p += n;
        if (curLen === curSize){ const b = cur; cur = null; await dispatch(b, curSize); }
      }
    }
    if (received !== size) throw Object.assign(new Error(`Download ended early (${received} of ${size} bytes).`), { retryable: true });
    while (queue.length) await flushHead();
    if (size === 0) key32 = await finishKey();
    return { key32, macs };
  } catch (e){
    onError && onError(e);
    throw e;
  }
}

let shared = null;
const MegaFastCrypto = {
  /** True when this browser can run the fast path. */
  supported: () => !!(subtle && globalThis.Worker && typeof BigInt === 'function'),
  /** Lazily created worker pool shared by all transfers (one worker per spare CPU core, 2–8). */
  pool(url = '/assets/js/crypto-worker.js'){
    if (!shared || shared.broken){
      const cores = navigator.hardwareConcurrency || 4;
      shared = new Pool(Math.min(8, Math.max(2, cores - 1)), url);
    }
    return shared;
  },
  encryptStream, metaMac, fileKey, chunkSizes, Pool
};
globalThis.MegaFastCrypto = Object.freeze(MegaFastCrypto);
})();
