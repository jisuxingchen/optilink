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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
  return encoder.encode(JSON.stringify(canonicalObject(manifest)));
}

export function decodeManifest(bytes: Uint8Array): OltpManifestV1 {
  const parsed = JSON.parse(decoder.decode(bytes));
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
