import type {FiducialLocatorDiagnostic} from './tiled-orientation-fiducial.ts';

export type OrientationRankInput = {
  success: boolean;
  acquiredTiles: number;
  exactTiles: number;
  totalBitErrors: number;
  scoreSum: number;
  projectionSafe: boolean | null;
};

/**
 * The macro markers live above the three tiles in the canonical sender view.
 * A 180-degree/wrong-normal interpretation can still form an excellent marker
 * triplet while projecting the actual tile centers outside the normalized frame.
 * Require most of every estimated tile region to remain in-frame before using a
 * failed candidate as an orientation winner. Exact 3/3 preamble evidence remains
 * authoritative and is ranked above this geometric heuristic.
 */
export function projectedTileRegionsSafe(
  diagnostic: FiducialLocatorDiagnostic | null | undefined,
  width: number,
  height: number,
): boolean | null {
  const triplet = diagnostic?.triplet;
  if (!triplet) return null;
  if (!(width > 0 && height > 0 && triplet.estimatedTileSide > 0)) return false;
  const halfRequired = triplet.estimatedTileSide * 0.40;
  const edgeAllowance = Math.max(4, Math.min(width, height) * 0.012);
  return triplet.points.every(point =>
    point.x - halfRequired >= -edgeAllowance
    && point.x + halfRequired <= width + edgeAllowance
    && point.y - halfRequired >= -edgeAllowance
    && point.y + halfRequired <= height + edgeAllowance,
  );
}

export function rankOrientationCandidate(input: OrientationRankInput): number {
  const score = Number.isFinite(input.scoreSum) ? input.scoreSum : 0;
  if (input.success) return 1e15 + score * 1e4;
  // Do not let a visually strong but geometrically impossible marker triplet win
  // merely because the alternative candidate had fewer acquired tiles.
  if (input.projectionSafe === false) return -1e15 + input.exactTiles * 1e7 + score * 1e4;
  const errors = Number.isFinite(input.totalBitErrors) ? input.totalBitErrors : 1e9;
  return input.acquiredTiles * 1e9 + input.exactTiles * 1e7 - errors * 1e5 + score * 1e4;
}
