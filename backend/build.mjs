/**
 * backend/build.mjs — production bundle.
 *
 * `tsc` alone does not produce a runnable artifact here. With
 * `moduleResolution: "Bundler"` the source imports are extensionless, and tsc
 * emits them verbatim — which Node's ESM loader rejects with
 * ERR_MODULE_NOT_FOUND. The options were to append `.js` to every relative
 * import by hand, or to bundle. Bundling also folds `shared/` in, so the
 * deployed artifact is one file with no path aliases to get wrong at runtime.
 *
 * Dependencies stay external. Bundling express and ws buys nothing on a server
 * and makes stack traces worse.
 *
 * Type checking is NOT done here — esbuild strips types without reading them.
 * `npm run build` runs `typecheck` first for exactly that reason; do not
 * shortcut it to just this script.
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  minify: false, // a server bundle gains nothing from it and loses readable traces
  external: [
    ...Object.keys(pkg.dependencies ?? {}),
    // Optional peer deps ws probes for at require time. Marking them external
    // stops esbuild failing the build over modules that are meant to be absent.
    'bufferutil',
    'utf-8-validate',
  ],
  banner: {
    // Some CJS deps reach for these under ESM. Cheaper than shipping a shim file.
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
