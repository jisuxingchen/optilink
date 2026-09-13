export type OltpManifestV1 = {
  protocol: 'OLTP';
  version: 1;
  sessionId: string;
  file: {name: string; byteLength: number; sha256: string};
  transport: {
    tileCount: number;
    matrixSize: number;
    payloadBytesPerTile: number;
    opticalSymbolHz: number;
    displayRefreshHz: number;
    holdRefreshes: number;
    fountainSourceBlockBytes: number;
    fountainSeed: number;
  };
  flags: {compressed: boolean; encrypted: boolean; fountain: boolean};
};

// Platform-neutral UTF-8 encode/decode. The Mini Program runtime does NOT
// provide TextEncoder / TextDecoder, and this module is part of the shared
// optical-core bundle lineage (consumed by the browser sim, Node tests, and the
// WeChat Mini Program receiver). No browser or Node globals allowed here.
function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let code: number;
    let len: number;
    if (b0 < 0x80) {
      code = b0;
      len = 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      code = b0 & 0x1f;
      len = 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      code = b0 & 0x0f;
      len = 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      code = b0 & 0x07;
      len = 4;
    } else {
      code = 0xfffd;
      len = 1;
    }
    for (let j = 1; j < len; j += 1) {
      const b = bytes[i + j];
      if (b === undefined || (b & 0xc0) !== 0x80) {
        code = 0xfffd;
        len = j;
        break;
      }
      code = (code << 6) | (b & 0x3f);
    }
    i += len;
    if (code > 0xffff) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}
function canonicalObject(manifest: OltpManifestV1): OltpManifestV1 {
  return {
    protocol: 'OLTP',
    version: 1,
    sessionId: manifest.sessionId,
    file: {
      name: manifest.file.name,
      byteLength: manifest.file.byteLength,
      sha256: manifest.file.sha256.toLowerCase(),
    },
    transport: {
      tileCount: manifest.transport.tileCount,
      matrixSize: manifest.transport.matrixSize,
      payloadBytesPerTile: manifest.transport.payloadBytesPerTile,
      opticalSymbolHz: manifest.transport.opticalSymbolHz,
      displayRefreshHz: manifest.transport.displayRefreshHz,
      holdRefreshes: manifest.transport.holdRefreshes,
      fountainSourceBlockBytes: manifest.transport.fountainSourceBlockBytes,
      fountainSeed: manifest.transport.fountainSeed,
    },
    flags: {
      compressed: manifest.flags.compressed,
      encrypted: manifest.flags.encrypted,
      fountain: manifest.flags.fountain,
    },
  };
}

function assertManifest(value: unknown): asserts value is OltpManifestV1 {
  if (!value || typeof value !== 'object') throw new Error('invalid OLTP manifest');
  const m = value as any;
  if (m.protocol !== 'OLTP' || m.version !== 1) throw new Error('unsupported OLTP manifest version');
  if (typeof m.sessionId !== 'string' || !m.sessionId) throw new Error('missing sessionId');
  if (!m.file || typeof m.file.name !== 'string' || !Number.isSafeInteger(m.file.byteLength) || m.file.byteLength < 0) throw new Error('invalid file metadata');
  if (typeof m.file.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.file.sha256)) throw new Error('invalid file sha256');
  const t = m.transport;
  if (!t || ![t.tileCount, t.matrixSize, t.payloadBytesPerTile, t.opticalSymbolHz, t.displayRefreshHz, t.holdRefreshes, t.fountainSourceBlockBytes, t.fountainSeed].every(Number.isFinite)) throw new Error('invalid transport metadata');
  if (t.tileCount < 1 || t.matrixSize < 1 || t.payloadBytesPerTile < 1 || t.opticalSymbolHz <= 0 || t.displayRefreshHz <= 0 || t.holdRefreshes < 1) throw new Error('invalid transport values');
  if (!m.flags || typeof m.flags.compressed !== 'boolean' || typeof m.flags.encrypted !== 'boolean' || typeof m.flags.fountain !== 'boolean') throw new Error('invalid flags');
}

export function encodeManifest(manifest: OltpManifestV1): Uint8Array {
  assertManifest(manifest);
  return utf8Encode(JSON.stringify(canonicalObject(manifest)));
}

export function decodeManifest(bytes: Uint8Array): OltpManifestV1 {
  const parsed = JSON.parse(utf8Decode(bytes));
  assertManifest(parsed);
  return canonicalObject(parsed);
}

export function manifestRepeatSchedule(input: {dataSymbols: number; repeatEvery: number}): number[] {
  if (!Number.isInteger(input.dataSymbols) || input.dataSymbols < 0) throw new Error('dataSymbols must be a non-negative integer');
  if (!Number.isInteger(input.repeatEvery) || input.repeatEvery < 1) throw new Error('repeatEvery must be a positive integer');
  const result: number[] = [];
  for (let at = 0; at <= input.dataSymbols; at += input.repeatEvery) result.push(at);
  if (result[result.length - 1] !== input.dataSymbols && input.dataSymbols % input.repeatEvery === 0) result.push(input.dataSymbols);
  return result;
}
