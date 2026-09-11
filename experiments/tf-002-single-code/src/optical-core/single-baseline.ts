/**
 * TF-012 r4 — Minimum physical SINGLE-CODE file-transfer baseline (单码基线).
 *
 * Sender: STATELESS CYCLIC BROADCASTER. One OptiGrid per chunk, chunk 0 → N-1,
 * then chunk 0 again, forever. No ACK, no retransmission request, no receiver
 * feedback, no network payload, no sender knowledge of receiver state.
 *
 * Receiver: may join at ANY point in the cycle. Every chunk is self-describing,
 * so a mid-cycle join can reconstruct the transfer without ever seeing chunk 0
 * first. It stores only unique chunks, counts duplicates, and stops as soon as
 * ALL UNIQUE CHUNKS ARE PRESENT — the completion condition is NOT "the last
 * index arrived"; the last missing chunk may be any index.
 *
 * Deliberately simple: no Fountain, no Manifest frame, no Preamble dependency,
 * no 3-tile composition, no throughput optimisation. One chunk = one OptiGrid.
 *
 * Platform-neutral: browser sender, Node tests and the WeChat Mini Program
 * receiver all share this single implementation. No TextEncoder/TextDecoder,
 * no DOM, no wx.*, no Node globals.
 */
import {decodeFrameCellsV1, encodeFrameCellsV1, payloadCapacityForMatrixV1, reservedCellValueV1, type OptiGridV1DecodedFrame} from '../optigrid-v1.ts';
import {homographyFromUnitSquare, mapHomography, type Homography, type Point, type Quad} from '../optigrid-geometry.ts';
import {sha256, sha256Hex} from './sha256.ts';
import type {PixelFrame} from './pixel-frame.ts';

// ---------------------------------------------------------------------------
// 1. Protocol constants (G2 / G3)
// ---------------------------------------------------------------------------

export const SINGLE_BASELINE_MAGIC_0 = 0x53; // 'S'
export const SINGLE_BASELINE_MAGIC_1 = 0x42; // 'B'
export const SINGLE_BASELINE_VERSION = 1;
export const SINGLE_BASELINE_PROTOCOL = 'SB';
export const SINGLE_BASELINE_MATRIX = 96;
export const SINGLE_BASELINE_FILE_NAME = 'baseline-10k.txt';
export const SINGLE_BASELINE_FILE_BYTES = 10240;
export const SINGLE_BASELINE_CHUNK_DATA_BYTES = 640;
export const SINGLE_BASELINE_TOTAL_CHUNKS = 16;
export const SINGLE_BASELINE_RECONSTRUCTION_METHOD = 'CONCAT_BY_INDEX';
export const SINGLE_BASELINE_RECONSTRUCTION_METHOD_ID = 0;
export const SINGLE_BASELINE_LINE_BYTES = 64;

/** Metadata bytes excluding the variable-length file name (see layout below). */
export const SINGLE_BASELINE_META_FIXED_BYTES = 50;
export const SINGLE_BASELINE_META_BYTES = SINGLE_BASELINE_META_FIXED_BYTES + SINGLE_BASELINE_FILE_NAME.length;
/** Packed chunk payload = metadata + file data (G3). */
export const SINGLE_BASELINE_PAYLOAD_BYTES = SINGLE_BASELINE_META_BYTES + SINGLE_BASELINE_CHUNK_DATA_BYTES;
/** Real OptiGrid v1 payload capacity for matrix 96: 722 - 10 header - 4 CRC = 708. */
export const SINGLE_BASELINE_OPTIGRID_CAPACITY_BYTES = payloadCapacityForMatrixV1(SINGLE_BASELINE_MATRIX);
/** Slack left inside the OptiGrid payload for this baseline. */
export const SINGLE_BASELINE_CAPACITY_SLACK_BYTES = SINGLE_BASELINE_OPTIGRID_CAPACITY_BYTES - SINGLE_BASELINE_PAYLOAD_BYTES;

export const SINGLE_BASELINE_META_LAYOUT = [
  '0..1    magic "SB"',
  '2       version (1)',
  '3       reconstructionMethodId (0 = CONCAT_BY_INDEX)',
  '4..5    totalChunks (u16)',
  '6..7    chunkDataBytes (u16)',
  '8..11   totalFileBytes (u32)',
  '12..15  fileId (u32, FNV-1a of the source bytes)',
  '16      chunkIndex (u8)',
  '17      fileNameBytes (u8)',
  '18..    fileName (UTF-8)',
  '   ..   fileSha256 (32 raw bytes)',
];

// ---------------------------------------------------------------------------
// 2. UTF-8 helpers (no TextEncoder / TextDecoder)
// ---------------------------------------------------------------------------

export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(out);
}

export function utf8String(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let code: number;
    let size: number;
    if (b0 < 0x80) { code = b0; size = 1; }
    else if ((b0 & 0xe0) === 0xc0) { code = b0 & 0x1f; size = 2; }
    else if ((b0 & 0xf0) === 0xe0) { code = b0 & 0x0f; size = 3; }
    else if ((b0 & 0xf8) === 0xf0) { code = b0 & 0x07; size = 4; }
    else { code = 0xfffd; size = 1; }
    if (i + size > bytes.length) { code = 0xfffd; size = bytes.length - i; }
    else {
      for (let k = 1; k < size; k += 1) code = (code << 6) | (bytes[i + k] & 0x3f);
    }
    i += size;
    if (code > 0xffff) {
      const value = code - 0x10000;
      out += String.fromCharCode(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. G1 — deterministic 10 KiB file source
// ---------------------------------------------------------------------------

const FILL_TEXT = 'OptiLink optical file transfer baseline payload line ';

/** One deterministic ASCII content line (63 bytes, the 64th is '\n'). */
export function singleBaselineLine(index: number): string {
  if (index === 0) return 'OptiLink Physical Transfer Baseline';
  if (index === 1) return 'Single-Code Cyclic Optical Broadcast Baseline';
  if (index === 2) return 'file baseline-10k.txt bytes 10240 chunks 16 data 640';
  return 'line ' + String(index - 2).padStart(6, '0') + ' ' + FILL_TEXT;
}

/** Exactly SINGLE_BASELINE_FILE_BYTES bytes of deterministic, readable UTF-8. */
export function singleBaselineFileBytes(): Uint8Array {
  const lineCount = Math.floor(SINGLE_BASELINE_FILE_BYTES / SINGLE_BASELINE_LINE_BYTES);
  const out = new Uint8Array(SINGLE_BASELINE_FILE_BYTES);
  let offset = 0;
  for (let index = 0; index < lineCount; index += 1) {
    let text = singleBaselineLine(index);
    while (text.length < SINGLE_BASELINE_LINE_BYTES - 1) text += FILL_TEXT;
    text = text.slice(0, SINGLE_BASELINE_LINE_BYTES - 1);
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i) & 0xff;
    out[offset + SINGLE_BASELINE_LINE_BYTES - 1] = 0x0a;
    offset += SINGLE_BASELINE_LINE_BYTES;
  }
  return out;
}

/** Stable 32-bit transfer identity derived from the source bytes (FNV-1a). */
export function singleBaselineFileId(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// 4. G3 — self-describing chunk packaging
// ---------------------------------------------------------------------------

export type SingleBaselineChunkMeta = {
  protocol: string;
  version: number;
  reconstructionMethod: string;
  reconstructionMethodId: number;
  fileId: number;
  fileName: string;
  totalFileBytes: number;
  totalChunks: number;
  chunkIndex: number;
  chunkDataBytes: number;
  fileSha256: string;
};

export type SingleBaselineParsedChunk = {
  meta: SingleBaselineChunkMeta;
  data: Uint8Array;
};

export type SingleBaselineParseResult =
  | {ok: true; chunk: SingleBaselineParsedChunk}
  | {ok: false; reason: string};

export type SingleBaselinePackInput = {
  fileName: string;
  fileId: number;
  fileSha256Bytes: Uint8Array;
  totalFileBytes: number;
  totalChunks: number;
  chunkIndex: number;
  chunkDataBytes: number;
  data: Uint8Array;
};

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  const v = value >>> 0;
  bytes[offset] = (v >>> 24) & 0xff;
  bytes[offset + 1] = (v >>> 16) & 0xff;
  bytes[offset + 2] = (v >>> 8) & 0xff;
  bytes[offset + 3] = v & 0xff;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function packSingleBaselineChunk(input: SingleBaselinePackInput): Uint8Array {
  const nameBytes = utf8Bytes(input.fileName);
  if (!nameBytes.length || nameBytes.length > 48) throw new Error('single-baseline file name must be 1..48 UTF-8 bytes');
  if (input.fileSha256Bytes.length !== 32) throw new Error('single-baseline fileSha256 must be 32 bytes');
  if (input.data.length !== input.chunkDataBytes) throw new Error('single-baseline chunk data length mismatch');
  if (input.totalChunks < 1 || input.totalChunks > 255) throw new Error('single-baseline totalChunks out of range');
  if (input.chunkIndex < 0 || input.chunkIndex >= input.totalChunks) throw new Error('single-baseline chunkIndex out of range');
  const payload = new Uint8Array(SINGLE_BASELINE_META_FIXED_BYTES + nameBytes.length + input.chunkDataBytes);
  payload[0] = SINGLE_BASELINE_MAGIC_0;
  payload[1] = SINGLE_BASELINE_MAGIC_1;
  payload[2] = SINGLE_BASELINE_VERSION;
  payload[3] = SINGLE_BASELINE_RECONSTRUCTION_METHOD_ID;
  writeU16(payload, 4, input.totalChunks);
  writeU16(payload, 6, input.chunkDataBytes);
  writeU32(payload, 8, input.totalFileBytes);
  writeU32(payload, 12, input.fileId);
  payload[16] = input.chunkIndex;
  payload[17] = nameBytes.length;
  payload.set(nameBytes, 18);
  payload.set(input.fileSha256Bytes, 18 + nameBytes.length);
  payload.set(input.data, SINGLE_BASELINE_META_FIXED_BYTES + nameBytes.length);
  return payload;
}

export function parseSingleBaselineChunk(payload: Uint8Array): SingleBaselineParseResult {
  if (payload.length < SINGLE_BASELINE_META_FIXED_BYTES + 1) return {ok: false, reason: 'payload-too-short'};
  if (payload[0] !== SINGLE_BASELINE_MAGIC_0 || payload[1] !== SINGLE_BASELINE_MAGIC_1) return {ok: false, reason: 'bad-magic'};
  if (payload[2] !== SINGLE_BASELINE_VERSION) return {ok: false, reason: 'bad-version'};
  if (payload[3] !== SINGLE_BASELINE_RECONSTRUCTION_METHOD_ID) return {ok: false, reason: 'bad-reconstruction-method'};
  const totalChunks = readU16(payload, 4);
  const chunkDataBytes = readU16(payload, 6);
  const totalFileBytes = readU32(payload, 8);
  const fileId = readU32(payload, 12);
  const chunkIndex = payload[16];
  const nameBytes = payload[17];
  if (totalChunks < 1 || totalChunks > 255) return {ok: false, reason: 'total-chunks-out-of-range'};
  if (chunkDataBytes < 1 || chunkDataBytes > 4096) return {ok: false, reason: 'chunk-data-bytes-out-of-range'};
  if (fileId === 0) return {ok: false, reason: 'zero-file-id'};
  if (nameBytes < 1 || nameBytes > 48) return {ok: false, reason: 'file-name-length-out-of-range'};
  if (chunkIndex >= totalChunks) return {ok: false, reason: 'chunk-index-out-of-range'};
  const metaBytes = SINGLE_BASELINE_META_FIXED_BYTES + nameBytes;
  const expected = metaBytes + chunkDataBytes;
  if (payload.length !== expected) return {ok: false, reason: 'payload-length-mismatch'};
  if (expected > SINGLE_BASELINE_OPTIGRID_CAPACITY_BYTES) return {ok: false, reason: 'payload-exceeds-optigrid-capacity'};
  if (totalFileBytes < 1 || totalFileBytes > totalChunks * chunkDataBytes) return {ok: false, reason: 'total-file-bytes-out-of-range'};
  const digestBytes = payload.subarray(18 + nameBytes, metaBytes);
  let digestNonZero = false;
  for (let i = 0; i < digestBytes.length; i += 1) if (digestBytes[i] !== 0) { digestNonZero = true; break; }
  if (!digestNonZero) return {ok: false, reason: 'zero-file-sha256'};
  return {
    ok: true,
    chunk: {
      meta: {
        protocol: SINGLE_BASELINE_PROTOCOL,
        version: payload[2],
        reconstructionMethod: SINGLE_BASELINE_RECONSTRUCTION_METHOD,
        reconstructionMethodId: payload[3],
        fileId,
        fileName: utf8String(payload.subarray(18, 18 + nameBytes)),
        totalFileBytes,
        totalChunks,
        chunkIndex,
        chunkDataBytes,
        fileSha256: bytesToHex(digestBytes),
      },
      data: payload.subarray(metaBytes),
    },
  };
}

// ---------------------------------------------------------------------------
// 5. G2 / G4 — chunking and one-chunk-one-OptiGrid frames
// ---------------------------------------------------------------------------

export type SingleBaselineChunk = {index: number; data: Uint8Array};

/** Split a file into fixed-size file-data chunks (no Fountain, no overlap). */
export function splitSingleBaselineChunks(
  fileBytes: Uint8Array,
  chunkDataBytes = SINGLE_BASELINE_CHUNK_DATA_BYTES,
): SingleBaselineChunk[] {
  const totalChunks = Math.ceil(fileBytes.length / chunkDataBytes);
  const chunks: SingleBaselineChunk[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkDataBytes;
    const end = Math.min(fileBytes.length, start + chunkDataBytes);
    const data = new Uint8Array(chunkDataBytes);
    data.set(fileBytes.subarray(start, end));
    chunks.push({index, data});
  }
  return chunks;
}

export function singleBaselineSequence(chunkIndex: number): number {
  return (((SINGLE_BASELINE_MAGIC_0 << 24) | (SINGLE_BASELINE_MAGIC_1 << 16)) | (chunkIndex & 0xffff)) >>> 0;
}

export type SingleBaselineTransfer = {
  fileName: string;
  fileBytes: Uint8Array;
  fileSha256Hex: string;
  fileSha256Bytes: Uint8Array;
  fileId: number;
  totalFileBytes: number;
  totalChunks: number;
  chunkDataBytes: number;
  payloadBytes: number;
  optigridCapacityBytes: number;
  capacitySlackBytes: number;
  matrixSize: number;
  payloads: Uint8Array[];
  frames: Uint8Array[];
};

/** Build the complete deterministic baseline transfer (source → payloads → frames). */
export function buildSingleBaselineTransfer(options?: {fileName?: string; matrixSize?: number}): SingleBaselineTransfer {
  const fileName = options?.fileName ?? SINGLE_BASELINE_FILE_NAME;
  const matrixSize = options?.matrixSize ?? SINGLE_BASELINE_MATRIX;
  const fileBytes = singleBaselineFileBytes();
  const fileSha256Bytes = sha256(fileBytes);
  const fileId = singleBaselineFileId(fileBytes);
  const chunks = splitSingleBaselineChunks(fileBytes);
  const payloads: Uint8Array[] = [];
  const frames: Uint8Array[] = [];
  for (const chunk of chunks) {
    const payload = packSingleBaselineChunk({
      fileName,
      fileId,
      fileSha256Bytes,
      totalFileBytes: fileBytes.length,
      totalChunks: chunks.length,
      chunkIndex: chunk.index,
      chunkDataBytes: chunk.data.length,
      data: chunk.data,
    });
    payloads.push(payload);
    frames.push(encodeFrameCellsV1(matrixSize, singleBaselineSequence(chunk.index), payload));
  }
  return {
    fileName,
    fileBytes,
    fileSha256Hex: bytesToHex(fileSha256Bytes),
    fileSha256Bytes,
    fileId,
    totalFileBytes: fileBytes.length,
    totalChunks: chunks.length,
    chunkDataBytes: chunks[0]?.data.length ?? 0,
    payloadBytes: payloads[0]?.length ?? 0,
    optigridCapacityBytes: payloadCapacityForMatrixV1(matrixSize),
    capacitySlackBytes: payloadCapacityForMatrixV1(matrixSize) - (payloads[0]?.length ?? 0),
    matrixSize,
    payloads,
    frames,
  };
}

// ---------------------------------------------------------------------------
// 6. Single-code locator + decoder (G6 / G7)
//
// One big OptiGrid is displayed on a light background. The locator finds the
// largest dark region (the code's black modules), derives a square quad, and
// refines centre / scale / tilt / phase against the KNOWN OptiGrid v1 reserved
// pattern. The OptiGrid CRCs are the final acceptance oracle, so a wrong
// geometric lock can never produce a false chunk.
// ---------------------------------------------------------------------------

export type SingleCodeLock = {
  quad: Quad;
  center: Point;
  sidePx: number;
  angleRad: number;
  /** Number of 90° image rotations handled by the quad corner order. */
  rotation: number;
  phaseX: number;
  phaseY: number;
  threshold: number;
  contrast: number;
  score: number;
  pixPerCellX: number;
  pixPerCellY: number;
};

type ReservedTable = {coords: Int32Array; expected: Uint8Array};
const reservedTables = new Map<number, ReservedTable>();

function reservedTable(matrixSize: number): ReservedTable {
  const cached = reservedTables.get(matrixSize);
  if (cached) return cached;
  const coords: number[] = [];
  const expected: number[] = [];
  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      const value = reservedCellValueV1(row, column, matrixSize);
      if (value === null) continue;
      const finder = (row < 9 || row >= matrixSize - 9) && (column < 9 || column >= matrixSize - 9);
      if (!finder && ((row * 7 + column * 11) % 5) !== 0) continue;
      coords.push(row, column);
      expected.push(value);
    }
  }
  const table: ReservedTable = {coords: Int32Array.from(coords), expected: Uint8Array.from(expected)};
  reservedTables.set(matrixSize, table);
  return table;
}

function lumaAt(frame: PixelFrame, x: number, y: number): number {
  const width = frame.width;
  const height = frame.height;
  let px = Math.round(x);
  let py = Math.round(y);
  if (px < 0) px = 0; else if (px >= width) px = width - 1;
  if (py < 0) py = 0; else if (py >= height) py = height - 1;
  const offset = (py * width + px) * 4;
  const data = frame.data;
  return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
}

type QuadParams = {cx: number; cy: number; side: number; angle: number; rotation: number; phaseX: number; phaseY: number};

const CORNER_SIGNS: ReadonlyArray<readonly [number, number]> = [
  [-0.5, -0.5], // tl
  [0.5, -0.5], // tr
  [0.5, 0.5], // br
  [-0.5, 0.5], // bl
];

/**
 * Square quad from (centre, side, tilt, 90°-rotation index). The corner order
 * cycles with the rotation index so that a camera frame rotated by a multiple
 * of 90° still decodes: `rotation` 1 means the code content appears rotated
 * 90° clockwise inside the frame buffer.
 */
export function quadFromParams(params: QuadParams): Quad {
  const cos = Math.cos(params.angle);
  const sin = Math.sin(params.angle);
  const points: Point[] = [];
  for (let i = 0; i < 4; i += 1) {
    const sign = CORNER_SIGNS[(i + params.rotation) % 4];
    const dx = sign[0] * params.side;
    const dy = sign[1] * params.side;
    points.push({x: params.cx + dx * cos - dy * sin, y: params.cy + dx * sin + dy * cos});
  }
  return {tl: points[0], tr: points[1], br: points[2], bl: points[3]};
}

type ReservedScore = {score: number; threshold: number; contrast: number};

const scratchValues = new Float64Array(8192);

function scoreQuad(frame: PixelFrame, matrixSize: number, quad: Quad, phaseX: number, phaseY: number): ReservedScore | null {
  const h = homographyFromUnitSquare(quad);
  if (!h) return null;
  const table = reservedTable(matrixSize);
  const count = table.expected.length;
  if (count > scratchValues.length) return null;
  let blackSum = 0;
  let blackCount = 0;
  let whiteSum = 0;
  let whiteCount = 0;
  for (let i = 0; i < count; i += 1) {
    const row = table.coords[i * 2];
    const column = table.coords[i * 2 + 1];
    const point = mapHomography(h, (column + 0.5 + phaseX) / matrixSize, (row + 0.5 + phaseY) / matrixSize);
    const value = lumaAt(frame, point.x, point.y);
    scratchValues[i] = value;
    if (table.expected[i]) { blackSum += value; blackCount += 1; } else { whiteSum += value; whiteCount += 1; }
  }
  if (!blackCount || !whiteCount) return null;
  const black = blackSum / blackCount;
  const white = whiteSum / whiteCount;
  const contrast = white - black;
  if (!(contrast > 0)) return null;
  const threshold = (black + white) / 2;
  let errors = 0;
  for (let i = 0; i < count; i += 1) {
    if ((scratchValues[i] < threshold ? 1 : 0) !== table.expected[i]) errors += 1;
  }
  return {score: (count - errors) / count, threshold, contrast};
}

function evaluateParams(frame: PixelFrame, matrixSize: number, params: QuadParams): ReservedScore | null {
  return scoreQuad(frame, matrixSize, quadFromParams(params), params.phaseX, params.phaseY);
}

type RefineStage = {center: number; side: number; angle: number; phase: number; sweeps: number};

/**
 * Refinement steps are expressed in CELLS, not in fractions of the code width.
 * The reserved pattern repeats every 2 cells, so a step of even a few cells
 * would jump straight past the true alignment into a neighbouring local maximum.
 */
const REFINE_STAGES: ReadonlyArray<RefineStage> = [
  {center: 0.5, side: 0.5, angle: 0.5, phase: 0.25, sweeps: 3},
  {center: 0.15, side: 0.15, angle: 0.15, phase: 0.1, sweeps: 2},
  {center: 0.05, side: 0.05, angle: 0.05, phase: 0.04, sweeps: 2},
];

/** Greedy coordinate descent on (centre, side, tilt, phase) against the reserved pattern. */
function refineParams(frame: PixelFrame, matrixSize: number, seed: QuadParams, stages: ReadonlyArray<RefineStage>): {params: QuadParams; score: ReservedScore} | null {
  let current: QuadParams = {...seed};
  let best = evaluateParams(frame, matrixSize, current);
  if (!best) return null;
  for (const stage of stages) {
    for (let sweep = 0; sweep < stage.sweeps; sweep += 1) {
      const cell = current.side / matrixSize;
      const dCenter = stage.center * cell;
      const dSide = stage.side * cell;
      const dAngle = stage.angle / matrixSize;
      const candidates: QuadParams[] = [];
      for (const sign of [-1, 1]) {
        candidates.push({...current, cx: current.cx + sign * dCenter});
        candidates.push({...current, cy: current.cy + sign * dCenter});
        candidates.push({...current, side: current.side + sign * dSide});
        candidates.push({...current, angle: current.angle + sign * dAngle});
        candidates.push({...current, phaseX: current.phaseX + sign * stage.phase});
        candidates.push({...current, phaseY: current.phaseY + sign * stage.phase});
      }
      for (const candidate of candidates) {
        if (candidate.side <= 8) continue;
        const scored = evaluateParams(frame, matrixSize, candidate);
        if (scored && scored.score > best.score + 1e-9) {
          best = scored;
          current = candidate;
        }
      }
    }
  }
  return {params: current, score: best};
}

export type DarkBounds = {minX: number; minY: number; maxX: number; maxY: number; area: number};

/** Bounding box + area of one connected region in the coarse mask grid space. */
type Component = {area: number; minGX: number; maxGX: number; minGY: number; maxGY: number};

/**
 * G7a minimum luminance contrast for a frame to be analysable at all. Deliberately
 * permissive (24): a low-contrast frame is still analysed and REPORTED instead of
 * being silently rejected, because the reserved-pattern score and the OptiGrid CRC
 * are the real acceptance oracles.
 */
export const SINGLE_BASELINE_MIN_REGION_CONTRAST = 24;
/** A dark component must span at least this many camera pixels to become a candidate. */
export const SINGLE_BASELINE_MIN_CANDIDATE_SPAN_PX = 96;
/** How many ranked candidate regions are geometrically searched per frame. */
export const SINGLE_BASELINE_MAX_REGION_CANDIDATES = 3;

/** One candidate code region derived from the coarse dark-component mask (G7a). */
export type SingleBaselineRegionCandidate = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Mask cells in this connected component. */
  area: number;
  /** Dark mask cells inside this bbox divided by the bbox area (≈0.5 for a checkerboard code, ≈1.0 for a solid dark region). */
  fillRatio: number;
  /** bbox width / bbox height. */
  aspect: number;
  /** Longest bbox edge in camera pixels. */
  spanPx: number;
  /** spanPx / min(frameWidth, frameHeight). */
  frameFraction: number;
  /** Code-likeness rank (higher is tried first). */
  rank: number;
  /** Which detector produced this candidate. */
  source: 'dark-component' | 'bright-subregion';
};

/**
 * Per-frame G7a/G7b diagnostics. Every field is measured on the real camera
 * frame; nothing here is derived from a sender-side oracle.
 */
export type SingleBaselineRegionDiagnostics = {
  frameWidth: number;
  frameHeight: number;
  sampleStride: number;
  sampledPixels: number;
  lumaMin: number;
  lumaMax: number;
  lumaMean: number;
  channelMeanR: number;
  channelMeanG: number;
  channelMeanB: number;
  channelMeanA: number;
  /** Fraction of neighbouring sampled pairs whose luma differs by more than 24 (structure detector). */
  localVariationRatio: number;
  threshold: number;
  contrast: number;
  darkPixelCount: number;
  darkPixelRatio: number;
  maskWidth: number;
  maskHeight: number;
  maskStep: number;
  maskArea: number;
  maskDarkCells: number;
  componentCount: number;
  largestArea: number;
  largestFractionOfMask: number;
  /** Bounding box of the LARGEST dark component, in camera pixels. */
  largestX: number;
  largestY: number;
  largestWidth: number;
  largestHeight: number;
  largestAspect: number;
  largestFillRatio: number;
  candidateCount: number;
  candidates: SingleBaselineRegionCandidate[];
  /** Bounding box of the dominant bright region (page/screen), in camera pixels. */
  brightRegionX: number;
  brightRegionY: number;
  brightRegionWidth: number;
  brightRegionHeight: number;
  /** True when a dark re-segmentation inside the dominant bright region was run. */
  brightSubregionUsed: boolean;
  /** Empty when G7a produced candidates; otherwise the exact reason it did not. */
  rejection: string;
  g7aPass: boolean;
};

export type DarkRegionAnalysis = {
  bounds: DarkBounds | null;
  candidates: SingleBaselineRegionCandidate[];
  diagnostics: SingleBaselineRegionDiagnostics;
};

function emptyRegionDiagnostics(width: number, height: number): SingleBaselineRegionDiagnostics {
  return {
    frameWidth: width,
    frameHeight: height,
    sampleStride: 1,
    sampledPixels: 0,
    lumaMin: 255,
    lumaMax: 0,
    lumaMean: 0,
    channelMeanR: 0,
    channelMeanG: 0,
    channelMeanB: 0,
    channelMeanA: 0,
    localVariationRatio: 0,
    threshold: 0,
    contrast: 0,
    darkPixelCount: 0,
    darkPixelRatio: 0,
    maskWidth: 0,
    maskHeight: 0,
    maskStep: 0,
    maskArea: 0,
    maskDarkCells: 0,
    componentCount: 0,
    largestArea: 0,
    largestFractionOfMask: 0,
    largestX: 0,
    largestY: 0,
    largestWidth: 0,
    largestHeight: 0,
    largestAspect: 0,
    largestFillRatio: 0,
    candidateCount: 0,
    candidates: [],
    brightRegionX: 0,
    brightRegionY: 0,
    brightRegionWidth: 0,
    brightRegionHeight: 0,
    brightSubregionUsed: false,
    rejection: '',
    g7aPass: false,
  };
}

/**
 * G7a Candidate Detection / 候选区域检测 + G7b Code Bounding Box / 码边界定位.
 *
 * A coarse max-pooled dark mask keeps a checkerboard border connected under
 * 8-connectivity. ALL dark components are measured and the most code-like ones
 * (square-ish bbox, ~half-dark interior fill, enough pixels) are ranked as
 * candidates, because in a real monitor photo the largest connected dark region
 * is not necessarily the code (dark bezel, dark room, dark UI or a dark desk can
 * each be larger). The reason for every rejection is recorded.
 */
export function analyzeDarkRegions(frame: PixelFrame): DarkRegionAnalysis {
  const width = frame.width;
  const height = frame.height;
  const diagnostics = emptyRegionDiagnostics(width, height);
  if (width < 32 || height < 32) {
    diagnostics.rejection = 'frame-too-small:' + width + 'x' + height;
    return {bounds: null, candidates: [], diagnostics};
  }

  // ---- pass 1: global luma statistics (min/max/mean, channels, structure) ----
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 256));
  const data = frame.data;
  let minLuma = 255;
  let maxLuma = 0;
  let sum = 0;
  let count = 0;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let aSum = 0;
  let varied = 0;
  let pairs = 0;
  for (let y = 0; y < height; y += stride) {
    let previous = -1;
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const a = offset + 3 < data.length ? data[offset + 3] : 0;
      const value = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (value < minLuma) minLuma = value;
      if (value > maxLuma) maxLuma = value;
      sum += value;
      count += 1;
      rSum += r;
      gSum += g;
      bSum += b;
      aSum += a;
      if (previous >= 0) {
        pairs += 1;
        if (Math.abs(value - previous) > 24) varied += 1;
      }
      previous = value;
    }
  }
  diagnostics.sampleStride = stride;
  diagnostics.sampledPixels = count;
  diagnostics.lumaMin = minLuma;
  diagnostics.lumaMax = maxLuma;
  diagnostics.lumaMean = count ? sum / count : 0;
  diagnostics.channelMeanR = count ? rSum / count : 0;
  diagnostics.channelMeanG = count ? gSum / count : 0;
  diagnostics.channelMeanB = count ? bSum / count : 0;
  diagnostics.channelMeanA = count ? aSum / count : 0;
  diagnostics.localVariationRatio = pairs ? varied / pairs : 0;
  diagnostics.contrast = maxLuma - minLuma;
  if (!(diagnostics.contrast >= SINGLE_BASELINE_MIN_REGION_CONTRAST)) {
    diagnostics.rejection = 'low-contrast:' + diagnostics.contrast.toFixed(1);
    return {bounds: null, candidates: [], diagnostics};
  }
  const threshold = (minLuma + maxLuma) / 2;
  diagnostics.threshold = threshold;

  // ---- pass 2: dark sample statistics at that threshold ----
  let darkPixels = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (lumaAt(frame, x, y) < threshold) darkPixels += 1;
    }
  }
  diagnostics.darkPixelCount = darkPixels;
  diagnostics.darkPixelRatio = count ? darkPixels / count : 0;

  // ---- pass 3: coarse max-pooled dark mask ----
  const step = Math.max(1, Math.floor(Math.min(width, height) / 160));
  const maskWidth = Math.max(1, Math.floor(width / step));
  const maskHeight = Math.max(1, Math.floor(height / step));
  const maskArea = maskWidth * maskHeight;
  const mask = new Uint8Array(maskArea);
  const offsets = [-step / 4, 0, step / 4];
  let maskDarkCells = 0;
  for (let gy = 0; gy < maskHeight; gy += 1) {
    for (let gx = 0; gx < maskWidth; gx += 1) {
      const cx = gx * step + step / 2;
      const cy = gy * step + step / 2;
      let darkest = 255;
      for (const oy of offsets) {
        for (const ox of offsets) {
          const value = lumaAt(frame, cx + ox, cy + oy);
          if (value < darkest) darkest = value;
        }
      }
      const dark = darkest < threshold ? 1 : 0;
      mask[gy * maskWidth + gx] = dark;
      if (dark) maskDarkCells += 1;
    }
  }
  diagnostics.maskWidth = maskWidth;
  diagnostics.maskHeight = maskHeight;
  diagnostics.maskStep = step;
  diagnostics.maskArea = maskArea;
  diagnostics.maskDarkCells = maskDarkCells;
  if (!maskDarkCells) {
    diagnostics.rejection = 'no-dark-pixels:' + diagnostics.darkPixelRatio.toFixed(4);
    return {bounds: null, candidates: [], diagnostics};
  }

  // ---- pass 4: connected components (8-connectivity) ----
  const label = new Int32Array(maskArea).fill(-1);
  const stack = new Int32Array(maskArea);
  const components: Component[] = [];
  let largest: Component | null = null;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || label[start] >= 0) continue;
    let top = 0;
    stack[top++] = start;
    label[start] = start;
    let area = 0;
    let minGX = maskWidth;
    let maxGX = -1;
    let minGY = maskHeight;
    let maxGY = -1;
    while (top > 0) {
      const cell = stack[--top];
      const gx = cell % maskWidth;
      const gy = (cell - gx) / maskWidth;
      area += 1;
      if (gx < minGX) minGX = gx;
      if (gx > maxGX) maxGX = gx;
      if (gy < minGY) minGY = gy;
      if (gy > maxGY) maxGY = gy;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= maskWidth || ny >= maskHeight) continue;
          const next = ny * maskWidth + nx;
          if (!mask[next] || label[next] >= 0) continue;
          label[next] = start;
          stack[top++] = next;
        }
      }
    }
    const component: Component = {area, minGX, maxGX, minGY, maxGY};
    components.push(component);
    if (!largest || area > largest.area) largest = component;
  }
  diagnostics.componentCount = components.length;
  if (!largest) {
    diagnostics.rejection = 'no-dark-component';
    return {bounds: null, candidates: [], diagnostics};
  }
  const spanOf = (component: Component): number => Math.max(component.maxGX - component.minGX + 1, component.maxGY - component.minGY + 1) * step;
  const fillOf = (component: Component, source: Uint8Array): number => {
    let dark = 0;
    let total = 0;
    for (let gy = component.minGY; gy <= component.maxGY; gy += 1) {
      for (let gx = component.minGX; gx <= component.maxGX; gx += 1) {
        total += 1;
        if (source[gy * maskWidth + gx]) dark += 1;
      }
    }
    return total ? dark / total : 0;
  };
  const bounds: DarkBounds = {
    minX: largest.minGX * step,
    minY: largest.minGY * step,
    maxX: (largest.maxGX + 1) * step - 1,
    maxY: (largest.maxGY + 1) * step - 1,
    area: largest.area,
  };
  diagnostics.largestArea = largest.area;
  diagnostics.largestFractionOfMask = maskArea ? largest.area / maskArea : 0;
  diagnostics.largestX = bounds.minX;
  diagnostics.largestY = bounds.minY;
  diagnostics.largestWidth = bounds.maxX - bounds.minX + 1;
  diagnostics.largestHeight = bounds.maxY - bounds.minY + 1;
  diagnostics.largestAspect = diagnostics.largestHeight ? diagnostics.largestWidth / diagnostics.largestHeight : 0;
  diagnostics.largestFillRatio = fillOf(largest, mask);

  // ---- rank the code-like candidates (G7b) ----
  const minSpan = Math.min(width, height);
  const candidates: SingleBaselineRegionCandidate[] = [];
  const pushCandidate = (component: Component, source: Uint8Array, sourceKind: 'dark-component' | 'bright-subregion'): void => {
    const spanPx = spanOf(component);
    if (spanPx < SINGLE_BASELINE_MIN_CANDIDATE_SPAN_PX) return;
    const componentWidth = (component.maxGX - component.minGX + 1) * step;
    const componentHeight = (component.maxGY - component.minGY + 1) * step;
    const aspect = componentHeight ? componentWidth / componentHeight : 0;
    const fillRatio = fillOf(component, source);
    let rank = 0;
    if (aspect >= 0.6 && aspect <= 1.7) rank += 3;
    if (fillRatio >= 0.15 && fillRatio <= 0.85) rank += 3;
    if (spanPx >= SINGLE_BASELINE_MATRIX * 2) rank += 2;
    // A dark structure bounded by the bright page/screen is the expected code
    // location, so it outranks a raw dark blob of the same shape.
    if (sourceKind === 'bright-subregion') rank += 1;
    candidates.push({
      minX: component.minGX * step,
      minY: component.minGY * step,
      maxX: (component.maxGX + 1) * step - 1,
      maxY: (component.maxGY + 1) * step - 1,
      area: component.area,
      fillRatio,
      aspect,
      spanPx,
      frameFraction: minSpan ? spanPx / minSpan : 0,
      rank,
      source: sourceKind,
    });
  };
  for (const component of components) pushCandidate(component, mask, 'dark-component');

  // ---- extra candidates: dark structures INSIDE the dominant bright region ----
  // A real monitor photo puts the code on a bright page/screen. The dark modules
  // can (a) merge with the dark room/bezel across the screen edge, or (b) fragment
  // because of a screen cast or a strong illumination gradient. Re-segmenting the
  // dark cells INSIDE the largest bright component, with a LOCAL threshold,
  // recovers a clean code bounding box in both cases.
  diagnostics.brightSubregionUsed = false;
  const brightComponent = largestComponentOf(invertMask(mask), maskWidth, maskHeight, maskArea * 0.02);
  if (brightComponent) {
    const brightBounds = {
      minX: brightComponent.minGX * step,
      minY: brightComponent.minGY * step,
      maxX: (brightComponent.maxGX + 1) * step - 1,
      maxY: (brightComponent.maxGY + 1) * step - 1,
      area: brightComponent.area,
    };
    diagnostics.brightRegionX = brightBounds.minX;
    diagnostics.brightRegionY = brightBounds.minY;
    diagnostics.brightRegionWidth = brightBounds.maxX - brightBounds.minX + 1;
    diagnostics.brightRegionHeight = brightBounds.maxY - brightBounds.minY + 1;
    const subregion = segmentDarkWithinBrightRegion(frame, brightBounds, step);
    diagnostics.brightSubregionUsed = true;
    if (subregion) pushCandidate(subregion, subregion.mask, 'bright-subregion');
  }

  candidates.sort((a, b) => (b.rank - a.rank) || (b.area - a.area));
  // Drop near-duplicate boxes (the dark-component and bright-subregion detectors
  // usually find the same code) so refinement budget is not wasted twice.
  const deduped: SingleBaselineRegionCandidate[] = [];
  for (const candidate of candidates) {
    const duplicate = deduped.some((kept) => {
      const centreX = (kept.minX + kept.maxX) / 2;
      const centreY = (kept.minY + kept.maxY) / 2;
      const otherX = (candidate.minX + candidate.maxX) / 2;
      const otherY = (candidate.minY + candidate.maxY) / 2;
      const tolerance = Math.max(kept.spanPx, candidate.spanPx) * 0.12;
      const spanRatio = Math.max(kept.spanPx, candidate.spanPx) / Math.max(1, Math.min(kept.spanPx, candidate.spanPx));
      return Math.abs(centreX - otherX) <= tolerance
        && Math.abs(centreY - otherY) <= tolerance
        && spanRatio <= 1.18;
    });
    if (!duplicate) deduped.push(candidate);
  }
  diagnostics.candidates = deduped.slice(0, SINGLE_BASELINE_MAX_REGION_CANDIDATES);
  diagnostics.candidateCount = diagnostics.candidates.length;
  if (!candidates.length) {
    diagnostics.rejection = 'no-candidate-region:components=' + components.length
      + ' largestArea=' + largest.area
      + ' largestSpanPx=' + spanOf(largest).toFixed(0)
      + ' minCandidateSpanPx=' + SINGLE_BASELINE_MIN_CANDIDATE_SPAN_PX;
    return {bounds, candidates: [], diagnostics};
  }
  diagnostics.g7aPass = true;
  return {bounds, candidates: diagnostics.candidates, diagnostics};
}

/** Invert a binary mask (1 ↔ 0). Used to derive the bright (page/screen) mask. */
function invertMask(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) out[i] = mask[i] ? 0 : 1;
  return out;
}

/** Largest 8-connected component of a binary mask (area floor in mask cells). */
function largestComponentOf(binary: Uint8Array, maskWidth: number, maskHeight: number, minArea: number): Component | null {
  const label = new Int32Array(binary.length).fill(-1);
  const stack = new Int32Array(binary.length);
  let best: Component | null = null;
  for (let start = 0; start < binary.length; start += 1) {
    if (!binary[start] || label[start] >= 0) continue;
    let top = 0;
    stack[top++] = start;
    label[start] = start;
    let area = 0;
    let minGX = maskWidth;
    let maxGX = -1;
    let minGY = maskHeight;
    let maxGY = -1;
    while (top > 0) {
      const cell = stack[--top];
      const gx = cell % maskWidth;
      const gy = (cell - gx) / maskWidth;
      area += 1;
      if (gx < minGX) minGX = gx;
      if (gx > maxGX) maxGX = gx;
      if (gy < minGY) minGY = gy;
      if (gy > maxGY) maxGY = gy;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= maskWidth || ny >= maskHeight) continue;
          const next = ny * maskWidth + nx;
          if (!binary[next] || label[next] >= 0) continue;
          label[next] = start;
          stack[top++] = next;
        }
      }
    }
    if (area >= minArea && (!best || area > best.area)) best = {area, minGX, maxGX, minGY, maxGY};
  }
  return best;
}

/**
 * Re-segment the dark cells inside one bright region (the page/screen) with a
 * LOCAL threshold, and return the largest dark component found there together
 * with the mask it was derived from.
 */
function segmentDarkWithinBrightRegion(
  frame: PixelFrame,
  brightBounds: DarkBounds,
  step: number,
): (Component & {mask: Uint8Array}) | null {
  const width = frame.width;
  const height = frame.height;
  const margin = step * 2;
  const minX = Math.max(0, brightBounds.minX - margin);
  const minY = Math.max(0, brightBounds.minY - margin);
  const maxX = Math.min(width - 1, brightBounds.maxX + margin);
  const maxY = Math.min(height - 1, brightBounds.maxY + margin);
  const stride = Math.max(1, Math.floor(Math.min(maxX - minX, maxY - minY) / 256) || 1);
  let localMin = 255;
  let localMax = 0;
  for (let y = minY; y <= maxY; y += stride) {
    for (let x = minX; x <= maxX; x += stride) {
      const value = lumaAt(frame, x, y);
      if (value < localMin) localMin = value;
      if (value > localMax) localMax = value;
    }
  }
  if (localMax - localMin < SINGLE_BASELINE_MIN_REGION_CONTRAST) return null;
  const localThreshold = (localMin + localMax) / 2;
  const spanX = Math.max(1, Math.floor((maxX - minX + 1) / step));
  const spanY = Math.max(1, Math.floor((maxY - minY + 1) / step));
  const mask = new Uint8Array(spanX * spanY);
  const offsets = [-step / 4, 0, step / 4];
  for (let gy = 0; gy < spanY; gy += 1) {
    for (let gx = 0; gx < spanX; gx += 1) {
      const cx = minX + gx * step + step / 2;
      const cy = minY + gy * step + step / 2;
      let darkest = 255;
      for (const oy of offsets) {
        for (const ox of offsets) {
          const value = lumaAt(frame, cx + ox, cy + oy);
          if (value < darkest) darkest = value;
        }
      }
      mask[gy * spanX + gx] = darkest < localThreshold ? 1 : 0;
    }
  }
  const component = largestComponentOf(mask, spanX, spanY, 8);
  if (!component) return null;
  const shifted: Component = {
    area: component.area,
    minGX: Math.floor(minX / step) + component.minGX,
    maxGX: Math.floor(minX / step) + component.maxGX,
    minGY: Math.floor(minY / step) + component.minGY,
    maxGY: Math.floor(minY / step) + component.maxGY,
  };
  // Re-index the sub-mask into the parent grid so the shared helpers can be used.
  const parent = new Uint8Array((Math.floor(width / step) + 1) * (Math.floor(height / step) + 1));
  const baseGX = Math.floor(minX / step);
  const baseGY = Math.floor(minY / step);
  for (let gy = 0; gy < spanY; gy += 1) {
    for (let gx = 0; gx < spanX; gx += 1) {
      if (!mask[gy * spanX + gx]) continue;
      const parentGX = baseGX + gx;
      const parentGY = baseGY + gy;
      if (parentGX < 0 || parentGY < 0 || parentGX >= Math.floor(width / step) || parentGY >= Math.floor(height / step)) continue;
      parent[parentGY * Math.floor(width / step) + parentGX] = 1;
    }
  }
  return {...shifted, mask: parent};
}

/**
 * Backwards-compatible wrapper: bounding box of the LARGEST connected dark region.
 * Kept for tests and diagnostics; the locator itself uses `analyzeDarkRegions`,
 * which also ranks smaller code-like regions.
 */
export function locateDarkRegionBounds(frame: PixelFrame): DarkBounds | null {
  return analyzeDarkRegions(frame).bounds;
}

/**
 * Coarse acquisition grid. Tilt and side are searched INDEPENDENTLY: a tilt of
 * θ inflates the axis-aligned bounding-box span by cos θ + sin θ, but the
 * coupled guess is only exact for a pure in-plane rotation, so the grid is
 * decoupled and both axes are scanned (each step ≈ 1 cell at matrix 96).
 */
const COARSE_ANGLES = [-0.07, -0.05, -0.03, -0.012, 0, 0.012, 0.03, 0.05, 0.07];
const COARSE_SCALES = [1, 0.98, 0.96, 0.94];

export type SingleBaselineLocateOptions = {previous?: SingleCodeLock | null};

export type SingleBaselineGeometricSeed = {params: QuadParams; score: number};

const TRACK_STAGES: ReadonlyArray<RefineStage> = [REFINE_STAGES[1], REFINE_STAGES[2]];

/**
 * Ordered geometric seeds for one candidate bounding box. All four 90° frame
 * rotations are seeded because the correct one cannot be told apart by the
 * reserved pattern alone (that pattern is symmetric under transpose) — the
 * OptiGrid CRC decides, so the receiver simply tries them in score order.
 */
export function seedsForBounds(frame: PixelFrame, matrixSize: number, bounds: DarkBounds): SingleBaselineGeometricSeed[] {
  const cx = (bounds.minX + bounds.maxX + 1) / 2;
  const cy = (bounds.minY + bounds.maxY + 1) / 2;
  const span = Math.max(bounds.maxX - bounds.minX + 1, bounds.maxY - bounds.minY + 1);
  const seeds: SingleBaselineGeometricSeed[] = [];
  for (let rotation = 0; rotation < 4; rotation += 1) {
    let best: SingleBaselineGeometricSeed | null = null;
    for (const angle of COARSE_ANGLES) {
      for (const scale of COARSE_SCALES) {
        const params: QuadParams = {cx, cy, side: span * scale, angle, rotation, phaseX: 0, phaseY: 0};
        const scored = evaluateParams(frame, matrixSize, params);
        if (!scored) continue;
        if (!best || scored.score > best.score) best = {params, score: scored.score};
      }
    }
    if (best) seeds.push(best);
  }
  seeds.sort((a, b) => b.score - a.score);
  return seeds;
}

/** Seeds for the largest dark region (kept for diagnostics and tests). */
export function locateSingleBaselineCodeSeeds(frame: PixelFrame, matrixSize = SINGLE_BASELINE_MATRIX): SingleBaselineGeometricSeed[] {
  const bounds = locateDarkRegionBounds(frame);
  if (!bounds) return [];
  return seedsForBounds(frame, matrixSize, bounds);
}

/** Per-frame G7b/G7c/G7d diagnostics (G7a comes from `analyzeDarkRegions`). */
export type SingleBaselineCaptureDiagnostics = {
  /** Null when the frame was served by the tracking fast path (no region analysis needed). */
  region: SingleBaselineRegionDiagnostics | null;
  seedCount: number;
  seedBestScore: number;
  seedBestRotation: number;
  seedBestSidePx: number;
  seedBestAngleDeg: number;
  refinementCount: number;
  refinementBestScore: number;
  refinementBestRotation: number;
  refinementBestSidePx: number;
  refinementBestPixPerCell: number;
  refinementBestPhaseX: number;
  refinementBestPhaseY: number;
  refinementBestThreshold: number;
  refinementBestContrast: number;
  g7bPass: boolean;
  g7bReason: string;
  g7cPass: boolean;
  g7cReason: string;
  crcAttempts: number;
  crcSuccess: number;
  crcFailure: number;
  decodedSequence: number;
  decodedChunkIndex: number;
  g7dPass: boolean;
  /** Deepest G7 sub-stage this frame reached. */
  stage: 'G7a' | 'G7b' | 'G7c' | 'G7d';
  stageReason: string;
};

export type SingleBaselineCapture = {
  decoded: OptiGridV1DecodedFrame | null;
  /** Best refined geometric lock (present even when the CRC decode fails). */
  lock: SingleCodeLock | null;
  /** Geometric attempts considered (1 tracking + up to MAX candidates × 4 rotations). */
  candidates: number;
  /** Attempts that passed the refinement stage. */
  refined: number;
  diagnostics: SingleBaselineCaptureDiagnostics;
};

/**
 * Refinement attempts are capped so one frame stays bounded no matter how many
 * candidate regions were found. The highest-scoring seeds are tried first.
 */
export const SINGLE_BASELINE_MAX_REFINEMENT_ATTEMPTS = 6;

function emptyCaptureDiagnostics(): SingleBaselineCaptureDiagnostics {
  return {
    region: null,
    seedCount: 0,
    seedBestScore: 0,
    seedBestRotation: 0,
    seedBestSidePx: 0,
    seedBestAngleDeg: 0,
    refinementCount: 0,
    refinementBestScore: 0,
    refinementBestRotation: 0,
    refinementBestSidePx: 0,
    refinementBestPixPerCell: 0,
    refinementBestPhaseX: 0,
    refinementBestPhaseY: 0,
    refinementBestThreshold: 0,
    refinementBestContrast: 0,
    g7bPass: false,
    g7bReason: '',
    g7cPass: false,
    g7cReason: '',
    crcAttempts: 0,
    crcSuccess: 0,
    crcFailure: 0,
    decodedSequence: -1,
    decodedChunkIndex: -1,
    g7dPass: false,
    stage: 'G7a',
    stageReason: '',
  };
}

/**
 * Full single-code capture with G7a→G7d diagnostics:
 *
 *   G7a candidate detection  → analyzeDarkRegions (luma stats, dark ratio, components, ranked candidates)
 *   G7b bounding box         → the top candidate must be square-ish and ≥2 px/cell
 *   G7c geometry lock        → coarse seeds + cell-unit refinement per candidate
 *   G7d CRC decode           → OptiGrid v1 CRC is the acceptance oracle
 *
 * The tracking seed (previous lock) is tried first, so a steady stream of held
 * frames stays cheap. Every sub-stage records its own best value and the exact
 * reason it did not advance, so a failed frame is fully explainable.
 */
export function captureSingleBaselineCode(
  frame: PixelFrame,
  matrixSize = SINGLE_BASELINE_MATRIX,
  options?: SingleBaselineLocateOptions,
): SingleBaselineCapture {
  const previous = options?.previous ?? null;
  const diagnostics = emptyCaptureDiagnostics();

  // Fast path: a static display keeps the same geometry, so try the previous
  // lock directly before spending anything on refinement. The OptiGrid CRC
  // verifies the result, so this can never accept a stale geometry.
  if (previous) {
    diagnostics.crcAttempts += 1;
    const direct = decodeSingleBaselineLock(frame, matrixSize, previous);
    if (direct) {
      diagnostics.g7bPass = true;
      diagnostics.g7cPass = true;
      diagnostics.g7dPass = true;
      diagnostics.crcSuccess = 1;
      diagnostics.decodedSequence = direct.sequence;
      diagnostics.decodedChunkIndex = direct.sequence & 0xffff;
      diagnostics.stage = 'G7d';
      diagnostics.stageReason = 'tracked-lock';
      return {decoded: direct, lock: previous, candidates: 1, refined: 0, diagnostics};
    }
    diagnostics.crcFailure = 1;
  }

  // ---- G7a: candidate detection ----
  const region = analyzeDarkRegions(frame);
  diagnostics.region = region.diagnostics;
  if (!region.diagnostics.g7aPass) {
    diagnostics.stage = 'G7a';
    diagnostics.stageReason = region.diagnostics.rejection || 'no-candidate-region';
    return {decoded: null, lock: null, candidates: 0, refined: 0, diagnostics};
  }

  // ---- G7b: code-plausible bounding box (reported opinion, never a silent stop) ----
  // G7b is deliberately REPORT-ONLY for gating: a candidate that is not square-ish
  // is a strong hint that the code's dark modules merged with the background or
  // fragmented, but the OptiGrid CRC — not a shape heuristic — is the acceptance
  // oracle. Aborting here is what turned every r4 physical frame into an
  // unexplained "locate-failed"; now G7c/G7d are always attempted and measured.
  const primary = region.candidates[0];
  const minSidePx = matrixSize * 2;
  diagnostics.g7bPass = primary.spanPx >= minSidePx && primary.aspect >= 0.5 && primary.aspect <= 2;
  if (!diagnostics.g7bPass) {
    diagnostics.g7bReason = 'candidate-not-code-like:spanPx=' + primary.spanPx.toFixed(0)
      + ' aspect=' + primary.aspect.toFixed(2)
      + ' fill=' + primary.fillRatio.toFixed(2)
      + ' source=' + primary.source
      + ' minSidePx=' + minSidePx;
  }

  // ---- G7c inputs: seeds from every ranked candidate, best score first ----
  const seeds: Array<SingleBaselineGeometricSeed & {candidate: number}> = [];
  region.candidates.forEach((candidate, index) => {
    for (const seed of seedsForBounds(frame, matrixSize, candidate)) seeds.push({...seed, candidate: index});
  });
  seeds.sort((a, b) => b.score - a.score);
  diagnostics.seedCount = seeds.length;
  if (seeds.length) {
    diagnostics.seedBestScore = seeds[0].score;
    diagnostics.seedBestRotation = seeds[0].params.rotation;
    diagnostics.seedBestSidePx = seeds[0].params.side;
    diagnostics.seedBestAngleDeg = seeds[0].params.angle * 180 / Math.PI;
  }

  const attempts: Array<{params: QuadParams; stages: ReadonlyArray<RefineStage>}> = [];
  if (previous) {
    attempts.push({
      params: {
        cx: previous.center.x,
        cy: previous.center.y,
        side: previous.sidePx,
        angle: previous.angleRad,
        rotation: previous.rotation,
        phaseX: previous.phaseX,
        phaseY: previous.phaseY,
      },
      stages: TRACK_STAGES,
    });
  }
  for (const seed of seeds.slice(0, SINGLE_BASELINE_MAX_REFINEMENT_ATTEMPTS)) {
    attempts.push({params: seed.params, stages: REFINE_STAGES});
  }

  // ---- G7c + G7d: refine, then let the OptiGrid CRC decide ----
  let bestLock: SingleCodeLock | null = null;
  let decoded: OptiGridV1DecodedFrame | null = null;
  let refined = 0;
  for (const attempt of attempts) {
    const candidate = refineParams(frame, matrixSize, attempt.params, attempt.stages);
    if (!candidate) continue;
    refined += 1;
    const lock = lockFromParams(candidate.params, candidate.score, matrixSize);
    if (!bestLock || lock.score > bestLock.score) bestLock = lock;
    if (lock.score > diagnostics.refinementBestScore) {
      diagnostics.refinementBestScore = lock.score;
      diagnostics.refinementBestRotation = lock.rotation;
      diagnostics.refinementBestSidePx = lock.sidePx;
      diagnostics.refinementBestPixPerCell = lock.pixPerCellX;
      diagnostics.refinementBestPhaseX = lock.phaseX;
      diagnostics.refinementBestPhaseY = lock.phaseY;
      diagnostics.refinementBestThreshold = lock.threshold;
      diagnostics.refinementBestContrast = lock.contrast;
    }
    diagnostics.crcAttempts += 1;
    const frameDecoded = decodeSingleBaselineLock(frame, matrixSize, lock);
    if (frameDecoded) {
      decoded = frameDecoded;
      bestLock = lock;
      diagnostics.crcSuccess = 1;
      diagnostics.decodedSequence = frameDecoded.sequence;
      diagnostics.decodedChunkIndex = frameDecoded.sequence & 0xffff;
      break;
    }
    diagnostics.crcFailure = 1;
  }
  diagnostics.refinementCount = refined;
  diagnostics.g7cPass = refined > 0;
  if (!diagnostics.g7cPass) {
    diagnostics.g7cReason = 'no-refined-lock:candidates=' + region.candidates.length
      + ' seeds=' + seeds.length
      + ' bestSeedScore=' + diagnostics.seedBestScore.toFixed(4);
    diagnostics.stage = 'G7c';
    diagnostics.stageReason = diagnostics.g7cReason;
    return {decoded: null, lock: null, candidates: attempts.length, refined, diagnostics};
  }
  diagnostics.g7dPass = decoded !== null;
  diagnostics.stage = decoded ? 'G7d' : 'G7c';
  diagnostics.stageReason = decoded
    ? 'crc-pass'
    : 'crc-fail:bestScore=' + diagnostics.refinementBestScore.toFixed(4)
      + ' bestRotation=' + diagnostics.refinementBestRotation
      + ' pixPerCell=' + diagnostics.refinementBestPixPerCell.toFixed(2)
      + ' contrast=' + diagnostics.refinementBestContrast.toFixed(1);
  return {decoded, lock: bestLock, candidates: attempts.length, refined, diagnostics};
}

function lockFromParams(params: QuadParams, score: ReservedScore, matrixSize: number): SingleCodeLock {
  const quad = quadFromParams(params);
  const horizontal = Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y);
  const vertical = Math.hypot(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y);
  return {
    quad,
    center: {x: params.cx, y: params.cy},
    sidePx: params.side,
    angleRad: params.angle,
    rotation: params.rotation,
    phaseX: params.phaseX,
    phaseY: params.phaseY,
    threshold: score.threshold,
    contrast: score.contrast,
    score: score.score,
    pixPerCellX: horizontal / matrixSize,
    pixPerCellY: vertical / matrixSize,
  };
}

const PHASE_RETRIES: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.25, 0],
  [-0.25, 0],
  [0, 0.25],
  [0, -0.25],
  [0.2, 0.2],
  [-0.2, 0.2],
  [0.2, -0.2],
  [-0.2, -0.2],
];

function sampleInnerCells(frame: PixelFrame, matrixSize: number, quad: Quad, phaseX: number, phaseY: number, threshold: number): Uint8Array | null {
  const h = homographyFromUnitSquare(quad);
  if (!h) return null;
  const cells = new Uint8Array(matrixSize * matrixSize);
  const border = 10;
  for (let row = border; row < matrixSize - border; row += 1) {
    for (let column = border; column < matrixSize - border; column += 1) {
      const point = mapHomography(h, (column + 0.5 + phaseX) / matrixSize, (row + 0.5 + phaseY) / matrixSize);
      cells[row * matrixSize + column] = lumaAt(frame, point.x, point.y) < threshold ? 1 : 0;
    }
  }
  return cells;
}

/**
 * Decode one OptiGrid from a camera frame using a located lock. CRC-verified:
 * a geometric lock that is off by even one cell cannot produce a chunk.
 */
export function decodeSingleBaselineLock(frame: PixelFrame, matrixSize: number, lock: SingleCodeLock): OptiGridV1DecodedFrame | null {
  for (const [dx, dy] of PHASE_RETRIES) {
    const cells = sampleInnerCells(frame, matrixSize, lock.quad, lock.phaseX + dx, lock.phaseY + dy, lock.threshold);
    if (!cells) return null;
    const decoded = decodeFrameCellsV1(cells, matrixSize);
    if (decoded) return decoded;
  }
  return null;
}

/**
 * Inverse of `homographyFromUnitSquare` — used by the deterministic test
 * renderer to rasterise a code through an arbitrary quad.
 */
export function invertHomography(h: Homography): Homography | null {
  const [a, b, c, d, e, f, g, k] = h;
  const c00 = e - f * k;
  const c01 = -(d - f * g);
  const c02 = d * k - e * g;
  const det = a * c00 + b * c01 + c * c02;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const m00 = c00 / det;
  const m01 = -(b - c * k) / det;
  const m02 = (b * f - c * e) / det;
  const m10 = c01 / det;
  const m11 = (a - c * g) / det;
  const m12 = -(a * f - c * d) / det;
  const m20 = c02 / det;
  const m21 = -(a * k - b * g) / det;
  const m22 = (a * e - b * d) / det;
  if (!Number.isFinite(m22) || Math.abs(m22) < 1e-12) return null;
  return [m00 / m22, m01 / m22, m02 / m22, m10 / m22, m11 / m22, m12 / m22, m20 / m22, m21 / m22];
}

export type SingleBaselineRenderOptions = {
  width?: number;
  height?: number;
  /** Code side as a fraction of min(width, height). */
  fill?: number;
  centerX?: number;
  centerY?: number;
  tiltDeg?: number;
  /** Number of 90° clockwise rotations applied to the code content. */
  rotation?: number;
  background?: number;
};

/**
 * Deterministic single-code camera-frame renderer (test fixture + browser sim).
 * Renders hard-edged black/white cells so sampling is pixel-exact.
 */
export function renderSingleBaselineFrame(
  cells: Uint8Array,
  matrixSize: number,
  options?: SingleBaselineRenderOptions,
): {width: number; height: number; data: Uint8ClampedArray} {
  const width = options?.width ?? 720;
  const height = options?.height ?? 1280;
  const fill = options?.fill ?? 0.7;
  const background = options?.background ?? 248;
  const rotation = options?.rotation ?? 0;
  const tilt = (options?.tiltDeg ?? 0) * Math.PI / 180;
  const side = Math.min(width, height) * fill;
  const cx = options?.centerX ?? width / 2;
  const cy = options?.centerY ?? height / 2;
  const quad = quadFromParams({cx, cy, side, angle: tilt, rotation, phaseX: 0, phaseY: 0});
  const forward = homographyFromUnitSquare(quad);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = background; data[i + 1] = background; data[i + 2] = background; data[i + 3] = 255;
  }
  if (!forward) return {width, height, data};
  const inverse = invertHomography(forward);
  if (!inverse) return {width, height, data};
  const reach = Math.ceil((side * Math.abs(Math.cos(tilt)) + side * Math.abs(Math.sin(tilt))) / 2) + 2;
  const minX = Math.max(0, Math.floor(cx - reach));
  const maxX = Math.min(width - 1, Math.ceil(cx + reach));
  const minY = Math.max(0, Math.floor(cy - reach));
  const maxY = Math.min(height - 1, Math.ceil(cy + reach));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const unit = mapHomography(inverse, x + 0.5, y + 0.5);
      if (unit.x < 0 || unit.y < 0 || unit.x >= 1 || unit.y >= 1) continue;
      const column = Math.min(matrixSize - 1, Math.floor(unit.x * matrixSize));
      const row = Math.min(matrixSize - 1, Math.floor(unit.y * matrixSize));
      const value = cells[row * matrixSize + column] ? 16 : 240;
      const offset = (y * width + x) * 4;
      data[offset] = value; data[offset + 1] = value; data[offset + 2] = value;
    }
  }
  return {width, height, data};
}

// ---------------------------------------------------------------------------
// 7. G8 / G9 / G10 / G11 / G12 — receiver baseline state
// ---------------------------------------------------------------------------

export type SingleBaselineStage = 'waiting' | 'receiving' | 'reconstructing' | 'verifying' | 'complete' | 'error';

export type SingleBaselineIngestResult = 'stored' | 'duplicate' | 'invalid' | 'foreign' | 'ignored-complete';

export type SingleBaselineFrameResult = {
  located: boolean;
  decoded: boolean;
  result: SingleBaselineIngestResult | 'locate-failed' | 'crc-failed';
  chunkIndex: number;
};

export type SingleBaselineMetrics = {
  cameraFrames: number;
  decodeAttempts: number;
  decodeSuccess: number;
  crcFailures: number;
  locateFailures: number;
  metadataRejects: number;
  foreignChunkRejects: number;
  duplicateChunks: number;
  uniqueChunks: number;
  postCompleteFrames: number;
  lastChunkIndex: number;
  firstChunkMs: number;
  allChunksMs: number;
  reconstructMs: number;
  shaMs: number;
  cameraWidth: number;
  cameraHeight: number;
  codeWidthPx: number;
  codeHeightPx: number;
  pixPerCellX: number;
  pixPerCellY: number;
  reservedScore: number;
  threshold: number;
  contrast: number;
  rotation: number;

  // ---- G7a Candidate Detection / 候选区域检测 (last analysed frame) ----
  regionLumaMin: number;
  regionLumaMax: number;
  regionLumaMean: number;
  regionContrast: number;
  regionThreshold: number;
  regionDarkPixelRatio: number;
  regionLocalVariationRatio: number;
  regionChannelMeanR: number;
  regionChannelMeanG: number;
  regionChannelMeanB: number;
  regionChannelMeanA: number;
  regionComponentCount: number;
  regionCandidateCount: number;
  regionRejection: string;
  regionLargestX: number;
  regionLargestY: number;
  regionLargestWidth: number;
  regionLargestHeight: number;
  regionLargestArea: number;
  regionLargestFillRatio: number;
  regionLargestAspect: number;
  regionCandidateSpansPx: string;

  // ---- G7b Code Bounding Box / 码边界定位 ----
  g7bPass: number;
  g7bReason: string;

  // ---- G7c Geometry Lock / 几何锁定 ----
  seedCount: number;
  seedBestScore: number;
  seedBestRotation: number;
  seedBestSidePx: number;
  refinementCount: number;
  refinementBestScore: number;
  refinementBestRotation: number;
  refinementBestPixPerCell: number;
  refinementBestPhaseX: number;
  refinementBestPhaseY: number;
  g7cPass: number;
  g7cReason: string;

  // ---- G7d CRC Decode / CRC 解码 ----
  crcDecodeAttempts: number;
  crcSuccess: number;
  crcFailure: number;
  decodedSequence: number;
  decodedChunkIndex: number;
  g7dPass: number;

  /** Deepest G7 sub-stage reached on the last analysed frame. */
  locatorStage: string;
  locatorStageReason: string;

  // ---- cumulative G7 sub-stage counters (frames that reached each stage) ----
  g7FramesAnalysed: number;
  g7aPassCount: number;
  g7bPassCount: number;
  g7cPassCount: number;
  g7dPassCount: number;
};

export type SingleBaselineReconstruction = {
  bytes: Uint8Array;
  sha256Hex: string;
  expectedSha256: string;
  match: boolean;
  reconstructMs: number;
  shaMs: number;
  elapsedMs: number;
};

function emptyMetrics(): SingleBaselineMetrics {
  return {
    cameraFrames: 0,
    decodeAttempts: 0,
    decodeSuccess: 0,
    crcFailures: 0,
    locateFailures: 0,
    metadataRejects: 0,
    foreignChunkRejects: 0,
    duplicateChunks: 0,
    uniqueChunks: 0,
    postCompleteFrames: 0,
    lastChunkIndex: -1,
    firstChunkMs: -1,
    allChunksMs: -1,
    reconstructMs: -1,
    shaMs: -1,
    cameraWidth: 0,
    cameraHeight: 0,
    codeWidthPx: 0,
    codeHeightPx: 0,
    pixPerCellX: 0,
    pixPerCellY: 0,
    reservedScore: 0,
    threshold: 0,
    contrast: 0,
    rotation: 0,
    regionLumaMin: 0,
    regionLumaMax: 0,
    regionLumaMean: 0,
    regionContrast: 0,
    regionThreshold: 0,
    regionDarkPixelRatio: 0,
    regionLocalVariationRatio: 0,
    regionChannelMeanR: 0,
    regionChannelMeanG: 0,
    regionChannelMeanB: 0,
    regionChannelMeanA: 0,
    regionComponentCount: 0,
    regionCandidateCount: 0,
    regionRejection: '',
    regionLargestX: 0,
    regionLargestY: 0,
    regionLargestWidth: 0,
    regionLargestHeight: 0,
    regionLargestArea: 0,
    regionLargestFillRatio: 0,
    regionLargestAspect: 0,
    regionCandidateSpansPx: '',
    g7bPass: 0,
    g7bReason: '',
    seedCount: 0,
    seedBestScore: 0,
    seedBestRotation: 0,
    seedBestSidePx: 0,
    refinementCount: 0,
    refinementBestScore: 0,
    refinementBestRotation: 0,
    refinementBestPixPerCell: 0,
    refinementBestPhaseX: 0,
    refinementBestPhaseY: 0,
    g7cPass: 0,
    g7cReason: '',
    crcDecodeAttempts: 0,
    crcSuccess: 0,
    crcFailure: 0,
    decodedSequence: -1,
    decodedChunkIndex: -1,
    g7dPass: 0,
    locatorStage: 'G7a',
    locatorStageReason: '',
    g7FramesAnalysed: 0,
    g7aPassCount: 0,
    g7bPassCount: 0,
    g7cPassCount: 0,
    g7dPassCount: 0,
  };
}

/**
 * Minimal single-code baseline receiver.
 *
 * Completion condition is ALL UNIQUE CHUNKS RECEIVED — never "the last index
 * arrived". Once complete it stops ingest and counts further frames.
 */
export class SingleCodeBaselineReceiver {
  stage: SingleBaselineStage = 'waiting';
  activeFileId: number | null = null;
  totalChunks = 0;
  chunkDataBytes = 0;
  totalFileBytes = 0;
  fileName = '';
  fileSha256 = '';
  reconstructionMethod = '';
  readonly received = new Map<number, Uint8Array>();
  metrics: SingleBaselineMetrics = emptyMetrics();
  lastRejectReason = '';
  reconstruction: SingleBaselineReconstruction | null = null;

  private startedAt = 0;
  private begun = false;
  private lock: SingleCodeLock | null = null;

  /** Reset for a fresh transfer. `now` is injectable so tests stay deterministic. */
  begin(now = Date.now()): void {
    this.stage = 'waiting';
    this.activeFileId = null;
    this.totalChunks = 0;
    this.chunkDataBytes = 0;
    this.totalFileBytes = 0;
    this.fileName = '';
    this.fileSha256 = '';
    this.reconstructionMethod = '';
    this.received.clear();
    this.metrics = emptyMetrics();
    this.lastRejectReason = '';
    this.reconstruction = null;
    this.startedAt = now;
    this.begun = true;
    this.lock = null;
  }

  get receivedUniqueCount(): number {
    return this.received.size;
  }

  get duplicateCount(): number {
    return this.metrics.duplicateChunks;
  }

  get complete(): boolean {
    return this.totalChunks > 0 && this.received.size === this.totalChunks;
  }

  get elapsedMs(): number {
    return this.begun ? Date.now() - this.startedAt : 0;
  }

  /** Missing chunk indices, ascending (empty when complete). */
  missingIndices(): number[] {
    const missing: number[] = [];
    if (!this.totalChunks) return missing;
    for (let index = 0; index < this.totalChunks; index += 1) {
      if (!this.received.has(index)) missing.push(index);
    }
    return missing;
  }

  /**
   * Copy the per-frame G7a→G7d locator diagnostics into the metric surface and
   * bump the cumulative sub-stage counters. This is what turns a bare
   * "locate-failed" into an explainable physical measurement: on the phone the
   * PO can see exactly which sub-stage stopped and why.
   */
  private applyCaptureDiagnostics(diagnostics: SingleBaselineCaptureDiagnostics): void {
    const metrics = this.metrics;
    const region = diagnostics.region;
    if (region) {
      metrics.g7FramesAnalysed += 1;
      metrics.regionLumaMin = region.lumaMin;
      metrics.regionLumaMax = region.lumaMax;
      metrics.regionLumaMean = region.lumaMean;
      metrics.regionContrast = region.contrast;
      metrics.regionThreshold = region.threshold;
      metrics.regionDarkPixelRatio = region.darkPixelRatio;
      metrics.regionLocalVariationRatio = region.localVariationRatio;
      metrics.regionChannelMeanR = region.channelMeanR;
      metrics.regionChannelMeanG = region.channelMeanG;
      metrics.regionChannelMeanB = region.channelMeanB;
      metrics.regionChannelMeanA = region.channelMeanA;
      metrics.regionComponentCount = region.componentCount;
      metrics.regionCandidateCount = region.candidateCount;
      metrics.regionRejection = region.rejection;
      metrics.regionLargestX = region.largestX;
      metrics.regionLargestY = region.largestY;
      metrics.regionLargestWidth = region.largestWidth;
      metrics.regionLargestHeight = region.largestHeight;
      metrics.regionLargestArea = region.largestArea;
      metrics.regionLargestFillRatio = region.largestFillRatio;
      metrics.regionLargestAspect = region.largestAspect;
      metrics.regionCandidateSpansPx = region.candidates
        .map((candidate) => candidate.spanPx.toFixed(0) + '@fill' + candidate.fillRatio.toFixed(2) + '@' + candidate.source)
        .join(' ');
      if (region.g7aPass) metrics.g7aPassCount += 1;
    }
    metrics.g7bPass = diagnostics.g7bPass ? 1 : 0;
    metrics.g7bReason = diagnostics.g7bReason;
    metrics.seedCount = diagnostics.seedCount;
    metrics.seedBestScore = diagnostics.seedBestScore;
    metrics.seedBestRotation = diagnostics.seedBestRotation;
    metrics.seedBestSidePx = diagnostics.seedBestSidePx;
    metrics.refinementCount = diagnostics.refinementCount;
    metrics.refinementBestScore = diagnostics.refinementBestScore;
    metrics.refinementBestRotation = diagnostics.refinementBestRotation;
    metrics.refinementBestPixPerCell = diagnostics.refinementBestPixPerCell;
    metrics.refinementBestPhaseX = diagnostics.refinementBestPhaseX;
    metrics.refinementBestPhaseY = diagnostics.refinementBestPhaseY;
    metrics.g7cPass = diagnostics.g7cPass ? 1 : 0;
    metrics.g7cReason = diagnostics.g7cReason;
    metrics.crcDecodeAttempts = diagnostics.crcAttempts;
    metrics.crcSuccess = diagnostics.crcSuccess;
    metrics.crcFailure = diagnostics.crcFailure;
    metrics.decodedSequence = diagnostics.decodedSequence;
    metrics.decodedChunkIndex = diagnostics.decodedChunkIndex;
    metrics.g7dPass = diagnostics.g7dPass ? 1 : 0;
    metrics.locatorStage = diagnostics.stage;
    metrics.locatorStageReason = diagnostics.stageReason;
    if (diagnostics.g7bPass) metrics.g7bPassCount += 1;
    if (diagnostics.g7cPass) metrics.g7cPassCount += 1;
    if (diagnostics.g7dPass) metrics.g7dPassCount += 1;
  }

  /** G6 → G9: locate, decode and ingest one camera frame. */
  ingestFrame(frame: PixelFrame, matrixSize = SINGLE_BASELINE_MATRIX, now = Date.now()): SingleBaselineFrameResult {    if (this.stage === 'complete' || this.stage === 'reconstructing' || this.stage === 'verifying') {
      this.metrics.postCompleteFrames += 1;
      return {located: false, decoded: false, result: 'ignored-complete', chunkIndex: -1};
    }
    if (!this.begun) { this.startedAt = now; this.begun = true; }
    this.metrics.cameraFrames += 1;
    this.metrics.cameraWidth = frame.width;
    this.metrics.cameraHeight = frame.height;
    this.metrics.decodeAttempts += 1;

    const capture = captureSingleBaselineCode(frame, matrixSize, {previous: this.lock});
    this.applyCaptureDiagnostics(capture.diagnostics);
    const lock = capture.lock;
    if (!lock) {
      this.metrics.locateFailures += 1;
      return {located: false, decoded: false, result: 'locate-failed', chunkIndex: -1};
    }
    this.lock = lock;
    this.metrics.reservedScore = lock.score;
    this.metrics.threshold = lock.threshold;
    this.metrics.contrast = lock.contrast;
    this.metrics.rotation = lock.rotation;
    this.metrics.pixPerCellX = lock.pixPerCellX;
    this.metrics.pixPerCellY = lock.pixPerCellY;
    const horizontal = Math.hypot(lock.quad.tr.x - lock.quad.tl.x, lock.quad.tr.y - lock.quad.tl.y);
    const vertical = Math.hypot(lock.quad.bl.x - lock.quad.tl.x, lock.quad.bl.y - lock.quad.tl.y);
    this.metrics.codeWidthPx = horizontal;
    this.metrics.codeHeightPx = vertical;

    const decoded = capture.decoded;
    if (!decoded) {
      this.metrics.crcFailures += 1;
      return {located: true, decoded: false, result: 'crc-failed', chunkIndex: -1};
    }
    this.metrics.decodeSuccess += 1;
    const result = this.ingestDecoded(decoded, now);
    return {located: true, decoded: true, result, chunkIndex: this.metrics.lastChunkIndex};
  }

  /** G9: validate + deduplicate an already decoded OptiGrid frame. */
  ingestDecoded(decoded: OptiGridV1DecodedFrame, now = Date.now()): SingleBaselineIngestResult {
    if (this.stage === 'complete' || this.stage === 'reconstructing' || this.stage === 'verifying') {
      this.metrics.postCompleteFrames += 1;
      return 'ignored-complete';
    }
    if (!this.begun) { this.startedAt = now; this.begun = true; }
    const parsed = parseSingleBaselineChunk(decoded.payload);
    if (!parsed.ok) {
      this.metrics.metadataRejects += 1;
      this.lastRejectReason = parsed.reason;
      return 'invalid';
    }
    const meta = parsed.chunk.meta;
    if (this.activeFileId === null) {
      this.activeFileId = meta.fileId;
      this.totalChunks = meta.totalChunks;
      this.chunkDataBytes = meta.chunkDataBytes;
      this.totalFileBytes = meta.totalFileBytes;
      this.fileName = meta.fileName;
      this.fileSha256 = meta.fileSha256;
      this.reconstructionMethod = meta.reconstructionMethod;
      this.stage = 'receiving';
    } else if (
      meta.fileId !== this.activeFileId
      || meta.totalChunks !== this.totalChunks
      || meta.chunkDataBytes !== this.chunkDataBytes
      || meta.totalFileBytes !== this.totalFileBytes
      || meta.fileSha256 !== this.fileSha256
      || meta.reconstructionMethod !== this.reconstructionMethod
    ) {
      // Baseline rule: a different transfer identity while a file is active is
      // ignored and counted — the session is NOT switched.
      this.metrics.foreignChunkRejects += 1;
      this.lastRejectReason = 'foreign-file-id';
      return 'foreign';
    }
    if (this.received.has(meta.chunkIndex)) {
      this.metrics.duplicateChunks += 1;
      this.metrics.lastChunkIndex = meta.chunkIndex;
      return 'duplicate';
    }
    this.received.set(meta.chunkIndex, Uint8Array.from(parsed.chunk.data));
    this.metrics.uniqueChunks = this.received.size;
    this.metrics.lastChunkIndex = meta.chunkIndex;
    if (this.metrics.firstChunkMs < 0) this.metrics.firstChunkMs = now - this.startedAt;
    if (this.complete) {
      this.metrics.allChunksMs = now - this.startedAt;
      this.stage = 'reconstructing';
    }
    return 'stored';
  }

  /** G11 + G12: concat by index, truncate, SHA-256 compare with metadata. */
  reconstruct(now = Date.now()): SingleBaselineReconstruction | null {
    if (!this.complete) return null;
    this.stage = 'reconstructing';
    const reconstructStart = Date.now();
    const bytes = new Uint8Array(this.totalFileBytes);
    let offset = 0;
    for (let index = 0; index < this.totalChunks; index += 1) {
      const data = this.received.get(index);
      if (!data) return null;
      const remaining = this.totalFileBytes - offset;
      if (remaining <= 0) break;
      const take = Math.min(data.length, remaining);
      bytes.set(data.subarray(0, take), offset);
      offset += take;
    }
    const reconstructMs = Date.now() - reconstructStart;
    this.stage = 'verifying';
    const shaStart = Date.now();
    const digest = sha256Hex(bytes);
    const shaMs = Date.now() - shaStart;
    this.metrics.reconstructMs = reconstructMs;
    this.metrics.shaMs = shaMs;
    const match = digest === this.fileSha256;
    this.stage = match ? 'complete' : 'error';
    const result: SingleBaselineReconstruction = {
      bytes,
      sha256Hex: digest,
      expectedSha256: this.fileSha256,
      match,
      reconstructMs,
      shaMs,
      elapsedMs: now - this.startedAt,
    };
    this.reconstruction = result;
    if (!match) this.lastRejectReason = 'sha-mismatch';
    return result;
  }
}

/** UTF-8 decode of a reconstructed file for direct display (G13). */
export function singleBaselinePreviewText(bytes: Uint8Array, maxLines = 6): {head: string; tail: string; lines: number} {
  const text = utf8String(bytes);
  const all = text.split('\n');
  const lines = all.length;
  return {
    head: all.slice(0, maxLines).join('\n'),
    tail: all.slice(Math.max(maxLines, lines - maxLines)).join('\n'),
    lines,
  };
}

// ---------------------------------------------------------------------------
// 8. TF-012 r6 — speed ladder: theoretical rates + exploratory net goodput
// ---------------------------------------------------------------------------
//
// THREE NUMBERS THAT MUST NEVER BE CONFLATED / 三个不可混淆的数字:
//
//   1. Theoretical gross file-payload rate 理论文件载荷速率
//        = chunkDataBytes / hold duration
//      A SENDER-SIDE, DECLARED quantity. It is arithmetic on the hold timer, not
//      a measurement, and it says nothing about whether the receiver keeps up.
//      It is NOT Net Goodput and it is NOT optical throughput.
//
//   2. Physical decode metrics 真实物理解码指标
//      What the phone actually did (frames, decode attempts, failures, px/cell).
//
//   3. Exploratory Net Goodput 探索性有效净吞吐
//        = fileBytes / timeToAllChunksSeconds
//      Only defined for a REAL phone run that received all 16 unique chunks AND
//      produced an exact SHA-256 MATCH. Otherwise it is null. This is a 10 KiB
//      exploratory physical benchmark only — it is NOT G0.
//
// CameraFrame RGBA ingress bandwidth is an interface property, never optical
// throughput, and must never be reported as such.

/** The Stage A / Stage B speed ladder, ascending speed (descending hold time). */
export const SINGLE_BASELINE_HOLD_MS_LADDER = [1500, 1000, 750, 500, 333, 250, 200, 150, 100, 75, 50, 33] as const;

/** Fastest supported hold. Below this the sender cannot render meaningfully. */
export const SINGLE_BASELINE_HOLD_MS_MIN = 33;
/** Slowest supported hold (defensive upper bound for the URL parameter). */
export const SINGLE_BASELINE_HOLD_MS_MAX = 60000;

/** Parse/clamp a hold duration. Invalid input falls back to `fallback`. */
export function clampSingleBaselineHoldMs(value: unknown, fallback = 1000): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(SINGLE_BASELINE_HOLD_MS_MAX, Math.max(SINGLE_BASELINE_HOLD_MS_MIN, Math.round(parsed)));
}

export type SingleBaselineBenchmark = {
  /** Declared hold duration of ONE chunk, in milliseconds. */
  holdMs: number;
  /** Theoretical chunk rate = 1000 / holdMs. NOT a measurement. */
  theoreticalChunksPerSecond: number;
  /** Theoretical gross file-payload rate = chunkDataBytes * 1000 / holdMs. */
  theoreticalPayloadBytesPerSecond: number;
  theoreticalPayloadKiBPerSecond: number;
};

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Declared sender-side benchmark numbers for a hold duration. Returns numbers
 * only — never a PASS/FAIL and never a goodput claim. `null` when the hold
 * duration is unusable, so a caller can never accidentally print 0 or Infinity.
 */
export function singleBaselineBenchmark(
  holdMs: number,
  chunkDataBytes = SINGLE_BASELINE_CHUNK_DATA_BYTES,
): SingleBaselineBenchmark | null {
  if (!Number.isFinite(holdMs) || holdMs <= 0) return null;
  if (!Number.isFinite(chunkDataBytes) || chunkDataBytes <= 0) return null;
  const chunksPerSecond = 1000 / holdMs;
  const bytesPerSecond = (chunkDataBytes * 1000) / holdMs;
  return {
    holdMs,
    theoreticalChunksPerSecond: round(chunksPerSecond, 3),
    theoreticalPayloadBytesPerSecond: round(bytesPerSecond, 1),
    theoreticalPayloadKiBPerSecond: round(bytesPerSecond / 1024, 3),
  };
}

export type SingleBaselineNetGoodput = {
  fileBytes: number;
  timeToAllChunksMs: number;
  bytesPerSecond: number;
  kibPerSecond: number;
};

/**
 * Exploratory Net Goodput. Deliberately narrow: `null` unless the caller proves
 * a complete, SHA-256-exact physical run (16/16 unique chunks). A partial or
 * mismatching run has NO goodput — it has a failure, which is not a rate.
 */
export function singleBaselineNetGoodput(
  fileBytes: number,
  timeToAllChunksMs: number,
  uniqueReceived: number,
  totalChunks: number,
  shaMatched: boolean,
): SingleBaselineNetGoodput | null {
  if (!shaMatched) return null;
  if (!Number.isFinite(fileBytes) || fileBytes <= 0) return null;
  if (!Number.isFinite(timeToAllChunksMs) || timeToAllChunksMs <= 0) return null;
  if (totalChunks <= 0 || uniqueReceived !== totalChunks) return null;
  const bytesPerSecond = (fileBytes * 1000) / timeToAllChunksMs;
  return {
    fileBytes,
    timeToAllChunksMs,
    bytesPerSecond: round(bytesPerSecond, 3),
    kibPerSecond: round(bytesPerSecond / 1024, 3),
  };
}
