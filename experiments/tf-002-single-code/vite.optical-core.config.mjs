import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

// Library-mode build that bundles the platform-neutral optical acquisition core
// into a single CommonJS file consumable by the WeChat Mini Program via require().
export default defineConfig({
  build: {
    outDir: 'dist-optical-core',
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL('./src/optical-core/orientation-acquisition.ts', import.meta.url)),
      name: 'OpticalCore',
      formats: ['cjs'],
      fileName: () => 'optical-core.js',
    },
    rollupOptions: {
      // Bundle everything (no external deps) so the Mini Program gets one file.
      external: [],
    },
  },
});
