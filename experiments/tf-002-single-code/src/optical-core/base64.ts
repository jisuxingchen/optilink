/**
 * Minimal platform-neutral Base64 (RFC 4648, standard alphabet + padding).
 * No btoa/atob, no Buffer, no DOM — usable in the browser, Node, and the
 * WeChat Mini Program. Used for checkpoint serialization of solved blocks.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? ALPHABET[b2 & 63] : '=';
  }
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, '').replace(/\s+/g, '');
  if (!clean.length) return new Uint8Array(0);
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) lookup[ALPHABET.charCodeAt(i)] = i;

  const outLength = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(outLength);
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const c0 = lookup[clean.charCodeAt(i)];
    const c1 = lookup[clean.charCodeAt(i + 1)];
    const c2 = i + 2 < clean.length ? lookup[clean.charCodeAt(i + 2)] : -1;
    const c3 = i + 3 < clean.length ? lookup[clean.charCodeAt(i + 3)] : -1;
    if (c0 < 0 || c1 < 0 || (c2 < 0 && i + 2 < clean.length) || (c3 < 0 && i + 3 < clean.length)) {
      throw new Error('invalid base64 input');
    }
    out[o] = (c0 << 2) | (c1 >> 4);
    if (o + 1 < outLength) out[o + 1] = ((c1 & 15) << 4) | (c2 >= 0 ? c2 >> 2 : 0);
    if (o + 2 < outLength) out[o + 2] = c3 >= 0 ? ((c2 & 3) << 6) | c3 : 0;
    o += 3;
  }
  return out;
}
