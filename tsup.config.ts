import { builtinModules } from 'node:module';
import type { Plugin } from 'esbuild';
import { defineConfig } from 'tsup';

// Fails the Edge build on any Node built-in import, bare or node:-prefixed (CLAUDE.md
// invariant 8). Measured while scaffolding #5: by default tsup rewrites `node:fs` to a bare
// `fs` in the output, which CI's node:-only grep of dist/edge.js misses.
const bare = builtinModules.filter((name) => !name.startsWith('node:'));
const noNodeBuiltins: Plugin = {
  name: 'no-node-builtins',
  setup(build) {
    const escaped = bare.map((name) => name.replace(/[/]/g, '\\/'));
    build.onResolve({ filter: new RegExp(`^(node:.*|(${escaped.join('|')}))$`) }, (args) => ({
      errors: [
        {
          text: `"${args.path}" is a Node built-in; the Edge entry must not import one (CLAUDE.md invariant 8)`,
        },
      ],
    }));
  },
};

// dist/ is cleared by the prebuild script; two configs sharing tsup's `clean` could race.
export default defineConfig([
  {
    entry: { index: 'src/index.ts', next: 'src/next.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    platform: 'node',
    target: 'node20',
    sourcemap: true,
  },
  {
    // Edge is built alone and unsplit, so dist/edge.js is one self-contained file and CI's
    // grep sees everything it ships. ESM only: the Edge runtime has no CJS (DESIGN §4.2).
    entry: { edge: 'src/edge.ts' },
    format: ['esm'],
    dts: true,
    platform: 'neutral',
    target: 'es2022',
    sourcemap: true,
    // tsup strips the node: prefix by default, before plugins see the import; keep it so the
    // plugin below can reject it.
    removeNodeProtocol: false,
    esbuildPlugins: [noNodeBuiltins],
  },
]);
