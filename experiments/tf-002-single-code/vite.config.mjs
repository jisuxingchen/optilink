import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

const entry = name => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        baseline: entry('./index.html'),
        fountain: entry('./fountain.html'),
        optigrid: entry('./optigrid.html'),
        carrierBench: entry('./carrier-bench.html'),
        carrierFrontier: entry('./carrier-frontier.html'),
        tiledCarrier: entry('./tiled-carrier.html'),
        tiledTemporal: entry('./tiled-temporal.html'),
        tiledPhysical: entry('./tiled-physical.html'),
        tiledPhysicalSelftest: entry('./tiled-physical-selftest.html'),
      },
    },
  },
});
