TF-007 browser-only physical-pipeline regression

Run:
  npm run bench:physical-selftest

Purpose:
- emulate portrait and landscape camera rasters after real Sender pixel rendering;
- normalize orientation to the same 1280x720 processing frame used by physical v2;
- reacquire three independent training tiles from pixels;
- decode 80/96/112/120 dynamic frames from pixels only;
- fail if a training lock is geometrically false or if decoded payload differs.

This is engineering regression evidence only, not a physical screen-camera benchmark.
