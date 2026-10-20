/* Drive to MEGA: encryption worker.
 * Encrypts one MEGA chunk with hardware-accelerated WebCrypto, reproducing megajs's format exactly:
 *   ciphertext = AES-128-CTR, counter = nonce(8) ‖ blockIndex(8, big-endian)
 *   chunk MAC  = AES-128-CBC-MAC over the zero-padded plaintext, IV = nonce ‖ nonce
 * Several of these run in parallel, so one file can use every CPU core. */
'use strict';
const subtle = self.crypto.subtle;

self.onmessage = async ({ data: { id, key, nonce, offset, buf } }) => {
  try {
    const [ctrKey, cbcKey] = await Promise.all([
      subtle.importKey('raw', key, 'AES-CTR', false, ['encrypt']),
      subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt'])
    ]);
    const plain = new Uint8Array(buf);
    const len = plain.length;

    const counter = new Uint8Array(16);
    counter.set(nonce, 0);
    new DataView(counter.buffer).setBigUint64(8, BigInt(offset / 16));

    // CBC-MAC: CBC-encrypt the zero-padded chunk and keep the last block before WebCrypto's PKCS#7 padding block.
    const padLen = Math.ceil(len / 16) * 16;
    let macInput = plain;
    if (padLen !== len){ macInput = new Uint8Array(padLen); macInput.set(plain); }
    const iv = new Uint8Array(16);
    iv.set(nonce, 0); iv.set(nonce, 8);
    const [cbc, ct] = await Promise.all([
      subtle.encrypt({ name: 'AES-CBC', iv }, cbcKey, macInput),
      subtle.encrypt({ name: 'AES-CTR', counter, length: 64 }, ctrKey, plain)
    ]);
    const mac = new Uint8Array(cbc, padLen - 16, 16).slice();
    self.postMessage({ id, ct, mac }, [ct, mac.buffer]);
  } catch (e){
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
