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

export function decodeFrameCellsV1(cells: Uint8Array, matrixSize: number): OptiGridV1DecodedFrame | null {
  validateSize(matrixSize);
  if (cells.length !== matrixSize * matrixSize) return null;
  const byteCapacity = Math.floor(dataCellCountV1(matrixSize) / 8);
  const bytes = new Uint8Array(byteCapacity);
  let bitIndex = 0;
  for (let row = OPTIGRID_V1_BORDER; row < matrixSize - OPTIGRID_V1_BORDER; row += 1) {
    for (let column = OPTIGRID_V1_BORDER; column < matrixSize - OPTIGRID_V1_BORDER; column += 1) {
      if (bitIndex >= byteCapacity * 8) break;
      bytes[bitIndex >>> 3] |= (cells[row * matrixSize + column] ? 1 : 0) << (7 - (bitIndex & 7));
      bitIndex += 1;
    }
  }
  if (bytes.length < OPTIGRID_V1_HEADER_BYTES + OPTIGRID_V1_CRC_BYTES) return null;
  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1 || bytes[2] !== OPTIGRID_V1_VERSION || bytes[3] !== matrixSize) return null;
  const sequence = readU32(bytes, 4);
  const payloadLength = readU16(bytes, 8);
  const totalLength = OPTIGRID_V1_HEADER_BYTES + payloadLength + OPTIGRID_V1_CRC_BYTES;
  if (payloadLength > payloadCapacityForMatrixV1(matrixSize) || totalLength > bytes.length) return null;
  const expected = readU32(bytes, totalLength - OPTIGRID_V1_CRC_BYTES);
  const actual = crc32(bytes.subarray(0, totalLength - OPTIGRID_V1_CRC_BYTES));
  if (actual !== expected) return null;
  return {
    version: OPTIGRID_V1_VERSION,
    matrixSize,
    sequence,
    payload: bytes.slice(OPTIGRID_V1_HEADER_BYTES, OPTIGRID_V1_HEADER_BYTES + payloadLength),
    crc32: expected,
  };
}
