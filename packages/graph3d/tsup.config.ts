import { copyFileSync, existsSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // Tiny helper that exports the co-located wasm URL. Its own entry (not
    // bundled into index) so its `import.meta.url` resolves against
    // dist/wasm/asset.*, sitting next to the copied binary below.
    'wasm/asset': 'src/wasm/asset.ts',
  },
  format: ['cjs', 'esm'],
  dts: false,
  clean: true,
  // `asset.ts` resolves the wasm via `import.meta.url`. esbuild keeps that as-is
  // for ESM, but in a CJS file `import.meta` is invalid/undefined — point it at
  // an identifier a CJS-only banner defines as the file's own URL. Mirrors the
  // @vectojs/core tsup config.
  esbuildOptions(options, context) {
    if (context.format === 'cjs') {
      options.define = {
        ...options.define,
        'import.meta.url': '__vecto_cjs_url',
      };
      options.banner = {
        ...options.banner,
        js: `const __vecto_cjs_url=require("url").pathToFileURL(__filename).href;${
          options.banner?.js ?? ''
        }`,
      };
    }
  },
  // Ship the prebuilt WASM alongside dist/wasm/asset.* so `forceWasmUrl` resolves
  // to a real file in the published package. The binary is gitignored and built
  // by crates/vectojs-force-rs/build.sh (in CI before publish); if a JS-only
  // contributor builds without it, dist just ships without the accelerator and
  // `enableWasmForce` falls through to the JS path — best-effort, never a hard
  // build failure.
  onSuccess: async () => {
    const src = 'src/wasm/vectojs_force.wasm';
    if (existsSync(src)) {
      copyFileSync(src, 'dist/wasm/vectojs_force.wasm');
      console.log('copied vectojs_force.wasm -> dist/wasm/');
    } else {
      console.warn(
        'src/wasm/vectojs_force.wasm not found — dist ships JS-only (run build.sh first)',
      );
    }
  },
});
