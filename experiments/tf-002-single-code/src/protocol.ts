export type ManifestFrame = {
  kind: 'manifest';
  sessionId: string;
  totalChunks: number;
  totalBytes: number;
  chunkSize: number;
  sha256: string;
  fileName: string;
};

export type DataFrame = {
  kind: 'data';
  sessionId: string;
  index: number;
  totalChunks: number;
  payload: Uint8Array;
};

export type ParsedFrame = ManifestFrame | DataFrame;

const DATA_PREFIX = 'OL1D';
const MANIFEST_PREFIX = 'OL1M';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeManifest(frame: ManifestFrame): string {
  const fileName = encodeURIComponent(frame.fileName);
  return [
    MANIFEST_PREFIX,
    frame.sessionId,
    frame.totalChunks,
    frame.totalBytes,
    frame.chunkSize,
    frame.sha256,
    fileName,
  ].join('|');
}

export function encodeDataFrame(frame: DataFrame): string {
  const checksum = crc32(frame.payload).toString(16).padStart(8, '0');
  return [
    DATA_PREFIX,
    frame.sessionId,
    frame.index,
    frame.totalChunks,
    checksum,
    bytesToBase64Url(frame.payload),
  ].join('|');
}

export function parseFrame(text: string): ParsedFrame | null {
  const parts = text.split('|');
  if (parts[0] === MANIFEST_PREFIX && parts.length === 7) {
    const totalChunks = Number(parts[2]);
    const totalBytes = Number(parts[3]);
    const chunkSize = Number(parts[4]);
    if (![totalChunks, totalBytes, chunkSize].every(Number.isSafeInteger)) return null;
    if (totalChunks <= 0 || totalBytes < 0 || chunkSize <= 0) return null;
    if (!/^[a-f0-9]{64}$/iu.test(parts[5])) return null;
    return {
      kind: 'manifest',
      sessionId: parts[1],
      totalChunks,
      totalBytes,
      chunkSize,
      sha256: parts[5].toLowerCase(),
      fileName: decodeURIComponent(parts[6]),
    };
  }

  if (parts[0] === DATA_PREFIX && parts.length === 6) {
    const index = Number(parts[2]);
    const totalChunks = Number(parts[3]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(totalChunks)) return null;
    if (index < 0 || totalChunks <= 0 || index >= totalChunks) return null;
    const payload = base64UrlToBytes(parts[5]);
    const expected = Number.parseInt(parts[4], 16) >>> 0;
    if (!/^[a-f0-9]{8}$/iu.test(parts[4]) || crc32(payload) !== expected) return null;
    return {kind: 'data', sessionId: parts[1], index, totalChunks, payload};
  }

  return null;
}

export function chunkBytes(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error('chunkSize must be a positive integer');
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return chunks.length ? chunks : [new Uint8Array()];
}

export function assembleChunks(chunks: ReadonlyMap<number, Uint8Array>, totalChunks: number, totalBytes?: number): Uint8Array {
  const ordered: Uint8Array[] = [];
  let length = 0;
  for (let i = 0; i < totalChunks; i += 1) {
    const chunk = chunks.get(i);
    if (!chunk) throw new Error(`missing chunk ${i}`);
    ordered.push(chunk);
    length += chunk.length;
  }
  const targetLength = totalBytes ?? length;
  const output = new Uint8Array(targetLength);
  let offset = 0;
  for (const chunk of ordered) {
    const writable = Math.min(chunk.length, targetLength - offset);
    output.set(chunk.subarray(0, writable), offset);
    offset += writable;
    if (offset >= targetLength) break;
  }
  if (offset !== targetLength) throw new Error(`reassembled ${offset} bytes; expected ${targetLength}`);
  return output;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export function createSessionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

export function deterministicBytes(size: number, seed = 0x4f505449): Uint8Array {
  const output = new Uint8Array(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    output[i] = x & 0xff;
  }
  return output;
}
