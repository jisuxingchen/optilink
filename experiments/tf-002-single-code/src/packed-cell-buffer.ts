export type PackedCellObservation = {
  bitsPerCell: 2;
  cellCount: number;
  packed: Uint8Array;
};

export function packTwoBitLevels(levels: Uint8Array): PackedCellObservation {
  const packed = new Uint8Array(Math.ceil(levels.length / 4));
  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i];
    if (level > 3) throw new Error('2-bit level must be 0..3');
    packed[i >>> 2] |= level << ((3 - (i & 3)) * 2);
  }
  return {bitsPerCell: 2, cellCount: levels.length, packed};
}

export function unpackTwoBitLevels(observation: PackedCellObservation): Uint8Array {
  const levels = new Uint8Array(observation.cellCount);
  for (let i = 0; i < levels.length; i += 1) levels[i] = (observation.packed[i >>> 2] >>> ((3 - (i & 3)) * 2)) & 3;
  return levels;
}

export function binaryCellsFromPacked(observation: PackedCellObservation, thresholdLevel = 2): Uint8Array {
  if (!Number.isInteger(thresholdLevel) || thresholdLevel < 1 || thresholdLevel > 3) throw new Error('thresholdLevel must be 1..3');
  const levels = unpackTwoBitLevels(observation);
  const cells = new Uint8Array(levels.length);
  for (let i = 0; i < levels.length; i += 1) cells[i] = levels[i] < thresholdLevel ? 1 : 0;
  return cells;
}

export function binaryCellsToTwoBitObservation(cells: Uint8Array): PackedCellObservation {
  const levels = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i += 1) {
    if (cells[i] !== 0 && cells[i] !== 1) throw new Error('binary cell must be 0 or 1');
    levels[i] = cells[i] ? 0 : 3;
  }
  return packTwoBitLevels(levels);
}

export function packedBytesForCells(cellCount: number): number {
  if (!Number.isInteger(cellCount) || cellCount < 0) throw new Error('cellCount must be non-negative');
  return Math.ceil(cellCount / 4);
}
