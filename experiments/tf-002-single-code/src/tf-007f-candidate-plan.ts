import {payloadCapacityForMatrixV1} from './optigrid-v1.ts';
import {buildSymbolHoldPlan, theoreticalGrossBytesPerSecond} from './symbol-hold-plan.ts';

export type Tf007fCandidate = {
  matrixSize: number;
  tileCount: 3;
  desiredSymbolHz: number;
  actualSymbolHz: number;
  holdRefreshes: number;
  payloadBytesPerTile: number;
  theoreticalGrossBytesPerSecond: number;
  role: 'control' | 'candidate';
};

export function buildTf007fCandidatePlan(displayRefreshHz = 60): Tf007fCandidate[] {
  const specs = [
    {matrixSize: 96, desiredSymbolHz: 15, role: 'control' as const},
    {matrixSize: 160, desiredSymbolHz: 10, role: 'candidate' as const},
    {matrixSize: 160, desiredSymbolHz: 12, role: 'candidate' as const},
    {matrixSize: 160, desiredSymbolHz: 15, role: 'candidate' as const},
    {matrixSize: 176, desiredSymbolHz: 15, role: 'candidate' as const},
    {matrixSize: 192, desiredSymbolHz: 15, role: 'candidate' as const},
  ];
  return specs.map(spec => {
    const hold = buildSymbolHoldPlan({displayRefreshHz, desiredSymbolHz: spec.desiredSymbolHz});
    const payloadBytesPerTile = payloadCapacityForMatrixV1(spec.matrixSize);
    return {
      matrixSize: spec.matrixSize,
      tileCount: 3,
      desiredSymbolHz: spec.desiredSymbolHz,
      actualSymbolHz: hold.actualSymbolHz,
      holdRefreshes: hold.holdRefreshes,
      payloadBytesPerTile,
      theoreticalGrossBytesPerSecond: theoreticalGrossBytesPerSecond({tileCount: 3, payloadBytesPerTile, opticalSymbolHz: hold.actualSymbolHz}),
      role: spec.role,
    };
  });
}
