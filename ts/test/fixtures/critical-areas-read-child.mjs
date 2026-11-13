/**
 * Runs one critical-areas read against a planted path in its own process, so
 * the caller can bound it with a spawn `timeout:`. A read that blocks (a FIFO)
 * or never ends (`/dev/zero`) is synchronous, and in the vitest worker it would
 * hang the run: vitest's own timer cannot fire while the thread is blocked.
 *
 * Loads the TypeScript source through `typescript`'s transpiler, with a
 * resolve hook for the `.js` specifiers tsc expects, so the suite needs no
 * build (the TS engine CI job runs it without `ts/dist`).
 *
 * Usage: node critical-areas-read-child.mjs <importers|symbols> <root> <path>
 * Prints the result as one JSON line.
 */
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || !specifier.endsWith('.js')) throw err;
      return next(specifier.replace(/\.js$/, '.ts'), context);
    }
  },
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context);
    const { outputText } = ts.transpileModule(
      readFileSync(fileURLToPath(url), 'utf-8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      },
    );
    return { format: 'module', source: outputText, shortCircuit: true };
  },
});

const [mode, root, path] = process.argv.slice(2);
const src = new URL('../../src/critical-areas/', import.meta.url);

if (mode === 'importers') {
  const { countImporters } = await import(new URL('importers.ts', src).href);
  console.log(JSON.stringify(countImporters(root, [path]).source));
} else if (mode === 'symbols') {
  const { keepSymbols } = await import(
    new URL('declared-symbols.ts', src).href
  );
  const { kept } = keepSymbols(path, ['src/a.ts']);
  console.log(JSON.stringify({ kept: [...kept.keys()] }));
} else {
  throw new Error(`unknown mode: ${mode}`);
}
