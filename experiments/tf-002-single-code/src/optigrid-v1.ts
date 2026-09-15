import {crc32} from './protocol.ts';

export const OPTIGRID_V1_VERSION = 1;
export const OPTIGRID_V1_BORDER = 10;
export const OPTIGRID_V1_HEADER_BYTES = 10;
export const OPTIGRID_V1_CRC_BYTES = 4;

export type OptiGridV1DecodedFrame = {
  version: number;
  matrixSize: number;
  sequence: number;
  payload: Uint8Array;
  crc32: number;
};

const MAGIC_0 = 0x4f; // O
const MAGIC_1 = 0x31; // 1

function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 40 || size > 240) throw new Error('OptiGrid v1 matrix size must be an integer from 40 to 240');
}

function finderCell(localRow: number, localColumn: number): number {
  const edge = Math.min(localRow, localColumn, 8 - localRow, 8 - localColumn);
  if (edge === 0) return 1;
  if (edge === 1) return 0;
  if (edge <= 3) return 1;
  return 0;
}

export function reservedCellValueV1(row: number, column: number, size: number): number | null {
  validateSize(size);
  const top = row < 9;
  const bottom = row >= size - 9;
  const left = column < 9;
  const right = column >= size - 9;

  if (top && left) return finderCell(row, column);
  if (top && right) return finderCell(row, column - (size - 9));
  if (bottom && left) return finderCell(row - (size - 9), column);
  if (bottom && right) return finderCell(row - (size - 9), column - (size - 9));

  if (row < OPTIGRID_V1_BORDER || row >= size - OPTIGRID_V1_BORDER || column < OPTIGRID_V1_BORDER || column >= size - OPTIGRID_V1_BORDER) {
    return ((row + column) & 1) as 0 | 1;
  }
  return null;
}

export function dataCellCountV1(size: number): number {
  validateSize(size);
  const inner = size - OPTIGRID_V1_BORDER * 2;
  return inner * inner;
}

export function payloadCapacityForMatrixV1(size: number): number {
  const byteCapacity = Math.floor(dataCellCountV1(size) / 8);
  return Math.max(0, byteCapacity - OPTIGRID_V1_HEADER_BYTES - OPTIGRID_V1_CRC_BYTES);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  const v = value >>> 0;
  bytes[offset] = (v >>> 24) & 0xff;
  bytes[offset + 1] = (v >>> 16) & 0xff;
  bytes[offset + 2] = (v >>> 8) & 0xff;
  bytes[offset + 3] = v & 0xff;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

export function encodeFrameBytesV1(matrixSize: number, sequence: number, payload: Uint8Array): Uint8Array {
  validateSize(matrixSize);
  const capacity = payloadCapacityForMatrixV1(matrixSize);
  if (payload.length > capacity) throw new Error(`payload ${payload.length} exceeds OptiGrid v1 ${matrixSize} capacity ${capacity}`);
  const bytes = new Uint8Array(OPTIGRID_V1_HEADER_BYTES + payload.length + OPTIGRID_V1_CRC_BYTES);
  bytes[0] = MAGIC_0;
  bytes[1] = MAGIC_1;
  bytes[2] = OPTIGRID_V1_VERSION;
  bytes[3] = matrixSize;
  writeU32(bytes, 4, sequence);
  writeU16(bytes, 8, payload.length);
  bytes.set(payload, OPTIGRID_V1_HEADER_BYTES);
  const checksum = crc32(bytes.subarray(0, bytes.length - OPTIGRID_V1_CRC_BYTES));
  writeU32(bytes, bytes.length - OPTIGRID_V1_CRC_BYTES, checksum);
  return bytes;
}

export function encodeFrameCellsV1(matrixSize: number, sequence: number, payload: Uint8Array): Uint8Array {
  const bytes = encodeFrameBytesV1(matrixSize, sequence, payload);
  const cells = new Uint8Array(matrixSize * matrixSize);
  let bitIndex = 0;
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const reserved = reservedCellValueV1(row, column, matrixSize);
      if (reserved !== null) {
        cells[row * matrixSize + column] = reserved;
        continue;
      }
      if (bitIndex < bytes.length * 8) {
        const byte = bytes[bitIndex >>> 3];
        cells[row * matrixSize + column] = (byte >>> (7 - (bitIndex & 7))) & 1;
      } else {
        cells[row * matrixSize + column] = ((row * 3 + column * 5) & 1) as 0 | 1;
      }
      bitIndex += 1;
    }
  }
  return cells;
}

export function reservedScoreV1(cells: Uint8Array, matrixSize: number): number {
  if (cells.length !== matrixSize * matrixSize) return 0;
  let expected = 0;
  let matches = 0;
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const value = reservedCellValueV1(row, column, matrixSize);
      if (value === null) continue;
      expected += 1;
      if (cells[row * matrixSize + column] === value) matches += 1;
    }
  }
  return expected ? matches / expected : 0;
}

/**
 * Where a sampled frame stopped being accepted, and what the raw sampling looked like.
 *
 * TF-012 r19: a physical run reported "locator PASS 111/111, CRC FAIL 111/111" with
 * geometry that looked healthy, and there was no way to tell a stable sampling-phase bias
 * from random noise. This inspection reports the stages the decoder already goes through —
 * magic/version/matrix, payload length, CRC field comparison — plus the raw sampled bits,
 * so repeated failures can be compared WITHOUT any oracle over the network: everything here
 * is computed locally from the camera frame.
 */
export interface OptiGridV1Inspection {
  ok: boolean;
  /** The stage that rejected the frame, or '' when it decoded. */
  failedAt: '' | 'size' | 'magic' | 'version' | 'matrix' | 'payload-length' | 'crc';
  /** Packed data bits exactly as the decoder read them (empty unless requested). */
  rawBytes: Uint8Array;
  byteCapacity: number;
  bitCount: number;
  header: {
    magic0: number;
    magic1: number;
    version: number;
    matrixSize: number;
    sequence: number;
    payloadLength: number;
  };
  /** expected = the CRC field carried by the frame; computed = CRC over the frame bytes. */
  crc: {expected: number | null; computed: number | null};
  decoded: OptiGridV1DecodedFrame | null;
}

/**
 * Inspect one sampled frame. `decodeFrameCellsV1` delegates here, so the accepted/rejected
 * decision has exactly ONE implementation and the diagnostics can never drift from it.
 */
export function inspectFrameCellsV1(
  cells: Uint8Array,
  matrixSize: number,
  options?: {withRawBytes?: boolean},
): OptiGridV1Inspection {
  const header = {magic0: -1, magic1: -1, version: -1, matrixSize: -1, sequence: -1, payloadLength: -1};
  const crc: {expected: number | null; computed: number | null} = {expected: null, computed: null};
  const empty = (failedAt: OptiGridV1Inspection['failedAt']): OptiGridV1Inspection => ({
    ok: false, failedAt, rawBytes: new Uint8Array(0), byteCapacity: 0, bitCount: 0,
    header, crc, decoded: null,
  });
  validateSize(matrixSize);
  if (cells.length !== matrixSize * matrixSize) return empty('size');
  const byteCapacity = Math.floor(dataCellCountV1(matrixSize) / 8);
  if (byteCapacity < OPTIGRID_V1_HEADER_BYTES + OPTIGRID_V1_CRC_BYTES) return empty('size');
  const bytes = new Uint8Array(byteCapacity);
  let bitIndex = 0;
  for (let row = OPTIGRID_V1_BORDER; row < matrixSize - OPTIGRID_V1_BORDER; row += 1) {
    for (let column = OPTIGRID_V1_BORDER; column < matrixSize - OPTIGRID_V1_BORDER; column += 1) {
      if (bitIndex >= byteCapacity * 8) break;
      bytes[bitIndex >>> 3] |= (cells[row * matrixSize + column] ? 1 : 0) << (7 - (bitIndex & 7));
      bitIndex += 1;
    }
  }
  const rawBytes = options?.withRawBytes ? bytes.slice() : new Uint8Array(0);
  const finish = (failedAt: OptiGridV1Inspection['failedAt']): OptiGridV1Inspection => ({
    ok: false, failedAt, rawBytes, byteCapacity, bitCount: bitIndex, header, crc, decoded: null,
  });
  header.magic0 = bytes[0] ?? -1;
  header.magic1 = bytes[1] ?? -1;
  header.version = bytes[2] ?? -1;
  header.matrixSize = bytes[3] ?? -1;
  if (header.magic0 !== MAGIC_0 || header.magic1 !== MAGIC_1) return finish('magic');
  if (header.version !== OPTIGRID_V1_VERSION) return finish('version');
  if (header.matrixSize !== matrixSize) return finish('matrix');
  header.sequence = readU32(bytes, 4);
  header.payloadLength = readU16(bytes, 8);
  const totalLength = OPTIGRID_V1_HEADER_BYTES + header.payloadLength + OPTIGRID_V1_CRC_BYTES;
  if (header.payloadLength > payloadCapacityForMatrixV1(matrixSize) || totalLength > bytes.length) {
    return finish('payload-length');
  }
  crc.expected = readU32(bytes, totalLength - OPTIGRID_V1_CRC_BYTES);
  crc.computed = crc32(bytes.subarray(0, totalLength - OPTIGRID_V1_CRC_BYTES));
  if (crc.computed !== crc.expected) return finish('crc');
  return {
    ok: true,
    failedAt: '',
    rawBytes,
    byteCapacity,
    bitCount: bitIndex,
    header,
    crc,
    decoded: {
      version: OPTIGRID_V1_VERSION,
      matrixSize,
      sequence: header.sequence,
      payload: bytes.slice(OPTIGRID_V1_HEADER_BYTES, OPTIGRID_V1_HEADER_BYTES + header.payloadLength),
      crc32: crc.expected,
    },
  };
}

export function decodeFrameCellsV1(cells: Uint8Array, matrixSize: number): OptiGridV1DecodedFrame | null {
  // ONE implementation: the diagnostics are a view of this exact decision.
  return inspectFrameCellsV1(cells, matrixSize).decoded;
}

/**
 * Short stable fingerprint of a sampled frame (FNV-1a over the packed data bytes).
 *
 * Two frames whose SAMPLING is identical produce the same fingerprint, so a histogram of
 * these values separates "the same wrong sampling repeats" (stable phase/geometry bias)
 * from "every frame differs" (noise). It is a local comparison only — never an oracle.
 */
export function fingerprintBytesV1(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
