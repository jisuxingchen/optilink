# TF-007 next receiver revision gate

Before another phone run, the receiver must satisfy all of the following in the browser pixel self-test:

1. Correctly select all four camera orientation cases: native, 180°, portrait-CW, portrait-CCW.
2. Acquire all three 64×64 optical training tiles from pixels.
3. Use full-interior known-training BER as the final lock objective/qualification, not sparse score alone.
4. Produce zero training bit errors for all three tiles in the clean regression and retain a bounded BER under the mild affine/raster regression.
5. Reuse pixel-derived training geometry to CRC-decode 80/96/112/120 dynamic tiles with zero payload mismatch.
6. Keep Sender payload bytes/cells/locks out of the Receiver boundary; the only exception is the locally regenerated public training oracle.
7. Only after this gate is green may the moto razr physical test be requested again.

The physical throughput target remains separate from this correctness gate.
