/**
 * Platform-neutral camera frame abstraction shared by the browser Receiver and
 * the WeChat Mini Program Receiver.
 *
 * Browser provides:  ImageData { width, height, data: Uint8ClampedArray } (RGBA).
 * Mini Program provides: CameraFrame { width, height, data: ArrayBuffer } (RGBA,
 * 4 bytes/pixel) via CameraContext.onCameraFrame. The adapter wraps that
 * ArrayBuffer in a Uint8ClampedArray/Uint8Array view to satisfy this shape.
 *
 * `data` is row-major RGBA (4 bytes per pixel): [R,G,B,A,R,G,B,A,...].
 */
export interface PixelFrame {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}
