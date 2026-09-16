/**
 * Throwaway spike harness for #765 D2 -- question 4. NOT engine code.
 *
 * Enumerates exactly the compiler-API surface the shape extractor touches and
 * reports, per `typescript` install, whether each entry point still exists.
 * The point is to size the version-coupling risk by API footprint rather than
 * by reputation: a 12-symbol surface couples very differently from a 200-symbol
 * one.
 *
 *   node version-probe.mjs [--ts <root>] [--ts2 <root>]
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_TS, loadTs } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

/** Every compiler-API entry point lib.mjs actually calls. */
const SURFACE = {
  module: [
    'createProgram',
    'createSourceFile',
    'forEachChild',
    'isFunctionDeclaration',
    'version',
  ],
  enums: [
    'ScriptTarget',
    'ScriptKind',
    'ModuleKind',
    'ModuleResolutionKind',
    'TypeFlags',
    'SymbolFlags',
    'IndexKind',
  ],
  typeFlags: [
    'Any',
    'Unknown',
    'Never',
    'TypeParameter',
    'Void',
    'Undefined',
    'Null',
    'BooleanLike',
    'String',
    'Number',
    'BigInt',
    'ESSymbolLike',
    'Object',
  ],
  program: ['getTypeChecker', 'getSourceFile', 'getSourceFiles'],
  checker: [
    'typeToString',
    'getTypeArguments',
    'getPropertiesOfType',
    'getTypeOfSymbolAtLocation',
    'getDeclaredTypeOfSymbol',
    'getTypeAtLocation',
    'getIndexInfoOfType',
    'isArrayType',
    'isTupleType',
  ],
  type: [
    'isUnion',
    'isIntersection',
    'isStringLiteral',
    'isNumberLiteral',
    'getSymbol',
    'getCallSignatures',
  ],
};

async function probe(root) {
  const { ts, version, entry } = await loadTs(root);

  // TypeScript 7 moved the whole compiler API off the package's main export
  // and onto `typescript/unstable/*`. Probing it with the 5.x/6.x surface
  // throws, so report the shape of the break instead of crashing.
  if (typeof ts.createProgram !== 'function') {
    // Resolve the subpath from the SAME install root, not from this file:
    // a bare specifier here would resolve against the spike directory and
    // report a spurious "absent".
    let unstable = null;
    let unstableError = null;
    try {
      const req = createRequire(path.join(root ?? REPO_TS, 'noop.js'));
      const sub = req.resolve('typescript/unstable/sync');
      unstable = Object.keys(await import(pathToFileURL(sub).href)).sort();
    } catch (e) {
      unstableError = String(e.message).split('\n')[0];
    }
    return {
      version,
      entry,
      mainExportKeys: Object.keys(ts).sort(),
      classicApiPresent: false,
      note:
        'ts.createProgram absent from the main export; the classic ' +
        'compiler API is not reachable at `import("typescript")`.',
      unstableSyncExports: unstable,
      unstableSyncError: unstableError,
    };
  }

  const missing = [];
  const present = [];
  const note = (group, name, ok) =>
    (ok ? present : missing).push(`${group}.${name}`);

  for (const n of SURFACE.module) note('ts', n, ts[n] !== undefined);
  for (const n of SURFACE.enums) note('ts', n, ts[n] !== undefined);
  for (const n of SURFACE.typeFlags) {
    note('ts.TypeFlags', n, ts.TypeFlags?.[n] !== undefined);
  }

  const program = ts.createProgram({
    rootNames: [new URL('./hard-target.ts', import.meta.url).pathname],
    options: { noEmit: true, strict: true, skipLibCheck: true },
  });
  for (const n of SURFACE.program) {
    note('Program', n, typeof program[n] === 'function');
  }
  const checker = program.getTypeChecker();
  for (const n of SURFACE.checker) {
    note('TypeChecker', n, typeof checker[n] === 'function');
  }
  const sf = program.getSourceFile(
    new URL('./hard-target.ts', import.meta.url).pathname,
  );
  let sample = null;
  ts.forEachChild(sf, (n) => {
    if (
      !sample &&
      ts.isFunctionDeclaration(n) &&
      n.name?.text === 'hardIndexed'
    ) {
      sample = checker.getTypeAtLocation(n.parameters[0]);
    }
  });
  for (const n of SURFACE.type) {
    note('Type', n, typeof sample?.[n] === 'function');
  }

  return {
    version,
    entry,
    classicApiPresent: true,
    surfaceSize: present.length + missing.length,
    presentCount: present.length,
    missing,
  };
}

const roots = [opt('ts', undefined), opt('ts2', undefined)].filter(
  (r, i) => i === 0 || r,
);
const out = [];
for (const r of roots) out.push(await probe(r));
process.stdout.write(JSON.stringify({ probes: out }, null, 2) + '\n');
