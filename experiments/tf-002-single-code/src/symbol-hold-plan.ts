export type SymbolHoldPlan = {holdRefreshes: number; actualSymbolHz: number};

export function buildSymbolHoldPlan(input: {displayRefreshHz: number; desiredSymbolHz: number}): SymbolHoldPlan {
  const {displayRefreshHz, desiredSymbolHz} = input;
  if (!Number.isFinite(displayRefreshHz) || displayRefreshHz <= 0) throw new Error('displayRefreshHz must be positive');
  if (!Number.isFinite(desiredSymbolHz) || desiredSymbolHz <= 0) throw new Error('desiredSymbolHz must be positive');
  if (desiredSymbolHz > displayRefreshHz) throw new Error('optical symbol rate cannot exceed display refresh');
  const holdRefreshes = Math.max(1, Math.round(displayRefreshHz / desiredSymbolHz));
  return {holdRefreshes, actualSymbolHz: displayRefreshHz / holdRefreshes};
}

export function theoreticalGrossBytesPerSecond(input: {tileCount: number; payloadBytesPerTile: number; opticalSymbolHz: number}): number {
  const {tileCount, payloadBytesPerTile, opticalSymbolHz} = input;
  if (![tileCount, payloadBytesPerTile, opticalSymbolHz].every(Number.isFinite)) throw new Error('gross-capacity inputs must be finite');
  if (tileCount <= 0 || payloadBytesPerTile <= 0 || opticalSymbolHz <= 0) throw new Error('gross-capacity inputs must be positive');
  return tileCount * payloadBytesPerTile * opticalSymbolHz;
}

export function candidateSymbolHoldPlans(input: {displayRefreshHz: number; tileCount: number; payloadBytesPerTile: number; desiredSymbolHz: readonly number[]}) {
  return input.desiredSymbolHz.map(desired => {
    const hold = buildSymbolHoldPlan({displayRefreshHz: input.displayRefreshHz, desiredSymbolHz: desired});
    return {
      desiredSymbolHz: desired,
      ...hold,
      theoreticalGrossBytesPerSecond: theoreticalGrossBytesPerSecond({tileCount: input.tileCount, payloadBytesPerTile: input.payloadBytesPerTile, opticalSymbolHz: hold.actualSymbolHz}),
    };
  });
}
