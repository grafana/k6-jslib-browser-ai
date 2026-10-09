import { build } from 'esbuild';

// Bundles src/ into the single dist/index.js that jslib.k6.io serves at
// https://jslib.k6.io/browser-ai/<version>/index.js.
await build({
  entryPoints: [{ in: 'src/browser-ai.js', out: 'index' }],
  bundle: true,
  outdir: 'dist',

  // k6 runs ES modules natively, so no transpiling is needed.
  format: 'esm',
  platform: 'browser',

  // Provided by the k6 runtime.
  external: ['k6', 'k6/*'],

  // Not minified: jslib.k6.io reviewers need to be able to read the bundle.
  minify: false,
  sourcemap: true,

  // The source map's paths are relative to dist/, which would resolve to
  // jslib.k6.io/browser-ai/src/... once hosted. Setting sourceRoot makes them
  // resolve under jslib.k6.io/browser-ai/<version>/ instead.
  sourceRoot: 'dist/',
});
