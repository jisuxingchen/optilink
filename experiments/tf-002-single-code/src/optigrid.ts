import {crc32} from './protocol.ts';

export const OPTIGRID_VERSION = 0;
export const OPTIGRID_BORDER = 4;
export const OPTIGRID_HEADER_BYTES = 10;
export const OPTIGRID_CRC_BYTES = 4;

export type OptiGridDecodedFrame = {
  version: number;
  matrixSize: number;
  sequence: number;
  payload: Uint8Array;
  crc32: number;
};

const MAGIC_0 = 0x4f; // O
const MAGIC_1 = 0x47; // G

const TL = [
  1, 1, 1, 1,
  1, 0, 0, 1,
  1, 0, 1, 1,
  1, 1, 1, 1,
];
const TR = [
  1, 0, 1, 0,
  0, 1, 0, 1,
  1, 0, 1, 0,
  0, 1, 0, 1,
];
const BL = [
  1, 1, 0, 0,
  1, 1, 0, 0,
  1, 1, 0, 0,
  1, 1, 0, 0,
];
const BR = [
  0, 0, 0, 0,
  0, 1, 1, 0,
  0, 1, 1, 0,
  0, 0, 0, 0,
];

function pilotAt(row: number, column: number, size: number): number | null {
  if (row < 4 && column < 4) return TL[row * 4 + column];
  if (row < 4 && column >= size - 4) return TR[row * 4 + (column - (size - 4))];
  if (row >= size - 4 && column < 4) return BL[(row - (size - 4)) * 4 + column];
  if (row >= size - 4 && column >= size - 4) return BR[(row - (size - 4)) * 4 + (column - (size - 4))];
  return null;
}

export function reservedCellValue(row: number, column: number, size: number): number | null {
  const pilot = pilotAt(row, column, size);
  if (pilot !== null) return pilot;
  const edge = Math.min(row, column, size - 1 - row, size - 1 - column);
  if (edge < 2) return 1;
  if (edge < OPTIGRID_BORDER) return 0;
  return null;
}

export function dataCellCount(size: number): number {
  validateSize(size);
  const inner = size - OPTIGRID_BORDER * 2;
  return inner * inner;
}

export function payloadCapacityForMatrix(size: number): number {
  const byteCapacity = Math.floor(dataCellCount(size) / 8);
  return Math.max(0, byteCapacity - OPTIGRID_HEADER_BYTES - OPTIGRID_CRC_BYTES);
}

export function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 24 || size > 240) throw new Error('OptiGrid matrix size must be an integer from 24 to 240');
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

export function calibrationPayload(sequence: number, length: number): Uint8Array {
  const output = new Uint8Array(length);
  let x = (sequence ^ 0x4f475630) >>> 0;
  for (let i = 0; i < output.length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    output[i] = (x + i * 17) & 0xff;
  }
  return output;
}

export function encodeFrameBytes(matrixSize: number, sequence: number, payload: Uint8Array): Uint8Array {
  validateSize(matrixSize);
  const capacity = payloadCapacityForMatrix(matrixSize);
  if (payload.length > capacity) throw new Error(`payload ${payload.length} exceeds OptiGrid ${matrixSize} capacity ${capacity}`);
  const bytes = new Uint8Array(OPTIGRID_HEADER_BYTES + payload.length + OPTIGRID_CRC_BYTES);
  bytes[0] = MAGIC_0;
  bytes[1] = MAGIC_1;
  bytes[2] = OPTIGRID_VERSION;
  bytes[3] = matrixSize;
  writeU32(bytes, 4, sequence);
  writeU16(bytes, 8, payload.length);
  bytes.set(payload, OPTIGRID_HEADER_BYTES);
  const checksum = crc32(bytes.subarray(0, bytes.length - OPTIGRID_CRC_BYTES));
  writeU32(bytes, bytes.length - OPTIGRID_CRC_BYTES, checksum);
  return bytes;
}

export function encodeFrameCells(matrixSize: number, sequence: number, payload: Uint8Array): Uint8Array {
  const bytes = encodeFrameBytes(matrixSize, sequence, payload);
  const cells = new Uint8Array(matrixSize * matrixSize);
  let bitIndex = 0;
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const reserved = reservedCellValue(row, column, matrixSize);
      if (reserved !== null) {
        cells[row * matrixSize + column] = reserved;
        continue;
      }
      if (bitIndex < bytes.length * 8) {
        const byte = bytes[bitIndex >>> 3];
        const shift = 7 - (bitIndex & 7);
        cells[row * matrixSize + column] = (byte >>> shift) & 1;
      } else {
        cells[row * matrixSize + column] = ((row + column) & 1) as 0 | 1;
      }
      bitIndex += 1;
    }
  }
  return cells;
}

export function reservedScore(cells: Uint8Array, matrixSize: number): number {
  if (cells.length !== matrixSize * matrixSize) return 0;
  let expectedCount = 0;
  let matches = 0;
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const expected = reservedCellValue(row, column, matrixSize);
      if (expected === null) continue;
      expectedCount += 1;
      if (cells[row * matrixSize + column] === expected) matches += 1;
    }
  }
  return expectedCount ? matches / expectedCount : 0;
}

export function decodeFrameCells(cells: Uint8Array, matrixSize: number): OptiGridDecodedFrame | null {
  validateSize(matrixSize);
  if (cells.length !== matrixSize * matrixSize) return null;
  const byteCapacity = Math.floor(dataCellCount(matrixSize) / 8);
  const bytes = new Uint8Array(byteCapacity);
  let bitIndex = 0;
  for (let row = OPTIGRID_BORDER; row < matrixSize - OPTIGRID_BORDER; row += 1) {
    for (let column = OPTIGRID_BORDER; column < matrixSize - OPTIGRID_BORDER; column += 1) {
      if (bitIndex >= byteCapacity * 8) break;
      const value = cells[row * matrixSize + column] ? 1 : 0;
      bytes[bitIndex >>> 3] |= value << (7 - (bitIndex & 7));
      bitIndex += 1;
    }
  }
  if (bytes.length < OPTIGRID_HEADER_BYTES + OPTIGRID_CRC_BYTES) return null;
  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1 || bytes[2] !== OPTIGRID_VERSION || bytes[3] !== matrixSize) return null;
  const sequence = readU32(bytes, 4);
  const payloadLength = readU16(bytes, 8);
  const totalLength = OPTIGRID_HEADER_BYTES + payloadLength + OPTIGRID_CRC_BYTES;
  if (payloadLength > payloadCapacityForMatrix(matrixSize) || totalLength > bytes.length) return null;
  const expected = readU32(bytes, totalLength - OPTIGRID_CRC_BYTES);
  const actual = crc32(bytes.subarray(0, totalLength - OPTIGRID_CRC_BYTES));
  if (actual !== expected) return null;
  return {
    version: OPTIGRID_VERSION,
    matrixSize,
    sequence,
    payload: bytes.slice(OPTIGRID_HEADER_BYTES, OPTIGRID_HEADER_BYTES + payloadLength),
    crc32: expected,
  };
}
