export type BufferedThroughputModel = {
  totalSymbols: number;
  bytesPerSymbol: number;
  captureSymbolHz: number;
  decodeSymbolsPerSecond: number;
  captureSeconds: number;
  decodedDuringCapture: number;
  backlogSymbols: number;
  postCaptureDecodeSeconds: number;
  e2eSeconds: number;
  opticalCaptureIngressBytesPerSecond: number;
  e2eNetGoodputUpperBoundBytesPerSecond: number;
};

export function modelBufferedThroughput(input: {
  totalSymbols: number;
  bytesPerSymbol: number;
  captureSymbolHz: number;
  decodeSymbolsPerSecond: number;
}): BufferedThroughputModel {
  const {totalSymbols, bytesPerSymbol, captureSymbolHz, decodeSymbolsPerSecond} = input;
  if (!Number.isInteger(totalSymbols) || totalSymbols < 1) throw new Error('totalSymbols must be a positive integer');
  if (![bytesPerSymbol, captureSymbolHz, decodeSymbolsPerSecond].every(value => Number.isFinite(value) && value > 0)) throw new Error('throughput inputs must be positive');
  const captureSeconds = totalSymbols / captureSymbolHz;
  const decodedDuringCapture = Math.min(totalSymbols, captureSeconds * decodeSymbolsPerSecond);
  const backlogSymbols = Math.max(0, totalSymbols - decodedDuringCapture);
  const postCaptureDecodeSeconds = backlogSymbols / decodeSymbolsPerSecond;
  const e2eSeconds = captureSeconds + postCaptureDecodeSeconds;
  const totalBytes = totalSymbols * bytesPerSymbol;
  return {
    totalSymbols,
    bytesPerSymbol,
    captureSymbolHz,
    decodeSymbolsPerSecond,
    captureSeconds,
    decodedDuringCapture,
    backlogSymbols,
    postCaptureDecodeSeconds,
    e2eSeconds,
    opticalCaptureIngressBytesPerSecond: bytesPerSymbol * captureSymbolHz,
    e2eNetGoodputUpperBoundBytesPerSecond: totalBytes / e2eSeconds,
  };
}

export function minimumDecodeSymbolsPerSecondForGoodput(input: {targetBytesPerSecond: number; bytesPerSymbol: number}): number {
  if (![input.targetBytesPerSecond, input.bytesPerSymbol].every(value => Number.isFinite(value) && value > 0)) throw new Error('inputs must be positive');
  return input.targetBytesPerSecond / input.bytesPerSymbol;
}
