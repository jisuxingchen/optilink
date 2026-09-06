# TF-007 physical pipeline self-test finding

## Why this test exists

The first phone run failed before CRC decoding because the 1080x1920 camera stream was processed as a portrait raster while the receiver searched three landscape lanes. Physical v2 added automatic orientation normalization and a known optical training frame. Before asking for another phone run, the same acquisition path is now exercised in a browser-only pixel pipeline.

## Evidence boundary

The self-test does **not** pass Sender payload/cells/locks directly into the Receiver. Sender renders three OptiGrid tiles to pixels, a separate simulated camera raster rotates those pixels into portrait/landscape orientations, Receiver normalizes the raster, reacquires from pixels, and only the known training oracle is regenerated locally. Dynamic payload bytes are compared only after CRC-valid decode.

## CI #256 finding

Commit `cb9cb5e60e79e82e5614a1894da65dcc4ce220d5` ran the new self-test before the long tiled sweep.

All four orientation cases selected the correct orientation family, but known-training acquisition converged to false locks:

- portrait camera CW: chosen `rotateCW`, training errors 955 / 932 / 929;
- portrait camera CCW: chosen `rotateCCW`, training errors 955 / 932 / 929;
- landscape native: chosen `native`, training errors 918 / 932 / 955;
- landscape upside-down: chosen `rotate180`, training errors 918 / 932 / 955.

The test therefore failed intentionally. This is useful negative evidence: orientation normalization alone is insufficient. The sparse known-training objective can accept a geometrically wrong local optimum, producing roughly random interior bits even while a lock is reported.

## Decision

Do **not** ask for another phone run on physical v2 yet.

Next receiver revision must qualify training geometry on full-interior bit error, not sparse score alone. A reported training lock must satisfy exact/near-exact interior oracle error in the pixel self-test before the phone gate reopens.
