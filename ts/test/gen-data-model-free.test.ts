/**
 * No model sits in gen-data's value path (ADR 0041, #1377).
 *
 * ADR 0041 records that `canary gen-data` calls no model: shapes, values,
 * seeds and gaps are all deterministic. Until this file, nothing enforced it —
 * a model SDK import or a subprocess call could be added under
 * `ts/src/gen-data/` or `ts/src/core/gen-data/` and every gate stayed green.
 *
 * WHAT IS CHECKED. Every source file under the two gen-data directories, plus
 * every module those files reach through relative imports, transitively. A
 * helper in `ts/src/util/` that imports `child_process` is caught as surely
 * as a direct import in `generate.ts`. In that closure the test forbids:
 *
 *   - model SDKs (`MODEL_PACKAGES`) — the direct route to a model;
 *   - process-spawning modules (`PROCESS_PACKAGES`) — the indirect route: a
 *     model CLI shelled out to is still a model in the value path;
 *   - the injected route: a call or reference to `spawnSync` / `spawn` /
 *     `exec*` / `fork` in any closure file. `MainDeps` (ts/src/main-deps.ts)
 *     hands commands a `spawnSync`, so a command can shell out without ever
 *     importing `child_process`. Matching the identifier, not the import, is
 *     what catches `deps.spawnSync(...)`. Bare `exec(` is deliberately NOT
 *     matched: `RegExp#exec` is everywhere and would drown the signal.
 *
 * TYPE-ONLY IMPORTS ARE NOT FOLLOWED. `import type { MainDeps }` is erased at
 * compile time and cannot put code in the value path; ADR 0041 itself lists
 * "the `MainDeps` type" among gen-data's sanctioned imports. Following it
 * would drag `main-deps.ts` (which imports `node:child_process`) into the
 * closure and make the rule false on day one for a reason that cannot execute.
 * The injected-identifier check above is what covers that route instead: the
 * type may arrive, a `deps.spawnSync(...)` call may not. A forbidden PACKAGE is
 * still flagged even in a type-only import — an SDK's types in gen-data are a
 * coupling worth a human look regardless of erasure.
 *
 * OPAQUE IMPORTS ARE LISTED, NOT SKIPPED. A dynamic `import(expr)` with a
 * non-literal specifier cannot be followed statically. Rather than silently
 * treating it as clean, the scan reports it and the live test pins the exact
 * set, so a new opaque import fails here and forces someone to look.
 *
 * Offline: reads source text and resolves relative specifiers by path, like
 * `import-graph-acyclic.test.ts`. It never imports project code.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEN_DATA_DIRS = ['ts/src/gen-data', 'ts/src/core/gen-data'];

/** Exact package names, or `@scope/` prefixes, of model SDKs. */
const MODEL_PACKAGES = [
  '@anthropic-ai/',
  'openai',
  '@openai/',
  '@google/generative-ai',
  '@google/genai',
  '@google-cloud/vertexai',
  '@mistralai/',
  'cohere-ai',
  'ollama',
  'langchain',
  '@langchain/',
  'ai',
  '@ai-sdk/',
  'groq-sdk',
  'replicate',
  '@huggingface/inference',
  '@aws-sdk/client-bedrock-runtime',
];

/** Modules whose job is starting another process. */
const PROCESS_PACKAGES = [
  'child_process',
  'node:child_process',
  'execa',
  'cross-spawn',
  'shelljs',
  'zx',
];

/** The injected route: spawn-family calls or property references. */
const SPAWN_IDENTIFIER =
  /\b(spawnSync|spawn|execSync|execFileSync|execFile|fork)\s*\(|\.\s*(spawnSync|spawn|execSync|execFileSync|execFile)\b/;

/**
 * Source with comments blanked out (newlines kept), so a comment that says
 * "never call spawnSync here" is not itself a violation. String contents are
 * kept: a string is code-adjacent data, and a template literal is how a
 * specifier would be smuggled past a comment-only reader.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const commentEnd = endOfComment(src, i);
    if (commentEnd !== -1) {
      out += src.slice(i, commentEnd).replace(/[^\n]/g, ' ');
      i = commentEnd;
      continue;
    }
    const next = QUOTES.has(src[i]!) ? endOfString(src, i) : i + 1;
    out += src.slice(i, next);
    i = next;
  }
  return out;
}

const QUOTES = new Set(['"', "'", '`']);

/** Index just past the comment opening at `i`, or -1 when none opens there. */
function endOfComment(src: string, i: number): number {
  if (src[i] !== '/') return -1;
  if (src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl;
  }
  if (src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end === -1 ? src.length : end + 2;
  }
  return -1;
}

/** Index just past the string literal whose opening quote is at `i`. */
function endOfString(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, src.length);
}

interface ImportRef {
  spec: string;
  typeOnly: boolean;
}

interface Imports {
  refs: ImportRef[];
  /** A dynamic `import(expr)` whose specifier is not a string literal. */
  opaque: boolean;
}

/**
 * Every import a file makes. Four forms, because four forms load code:
 * `import/export ... from 'x'`, side-effect `import 'x'`, literal
 * `import('x')`, and `require('x')`.
 */
export function importsOf(source: string): Imports {
  const src = stripComments(source);
  const refs: ImportRef[] = [];
  const statics =
    /\b(?:import|export)\s+(type\b\s*)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(statics)) {
    refs.push({ spec: m[2]!, typeOnly: m[1] !== undefined });
  }
  const loaders = [
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g,
    /\brequire\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g,
  ];
  for (const re of loaders) {
    for (const m of src.matchAll(re)) {
      refs.push({ spec: m[1]!, typeOnly: false });
    }
  }
  const dynamic = [...src.matchAll(/\bimport\s*\(\s*([^)]*)/g)];
  const opaque = dynamic.some((m) => !/^['"`][^'"`$]*['"`]\s*$/.test(m[1]!));
  return { refs, opaque };
}

/** `@scope/pkg/sub` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** Why a bare specifier is forbidden, or null when it is allowed. */
export function forbiddenReason(spec: string): string | null {
  const pkg = packageName(spec);
  const matches = (list: string[]): boolean =>
    list.some((p) => (p.endsWith('/') ? pkg.startsWith(p) : pkg === p));
  if (matches(MODEL_PACKAGES)) return 'model SDK';
  if (matches(PROCESS_PACKAGES)) return 'process spawning';
  return null;
}

const SOURCE_EXT = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

function sourceFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf-8' })
    .map((f) => join(dir, f))
    .filter(
      (f) =>
        SOURCE_EXT.test(f) &&
        !f.endsWith('.d.ts') &&
        !/\.test\.[cm]?[jt]s$/.test(f) &&
        statSync(f).isFile(),
    );
}

/** A relative specifier to a file on disk; NodeNext `.js` maps to `.ts`. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts'),
    base,
    `${base}.ts`,
    join(base, 'index.ts'),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

interface Scan {
  /** Every file in the value-import closure, relative to the base. */
  closure: string[];
  /** One line per finding: what was reached, and from where. */
  violations: string[];
  /** Closure files containing a non-literal dynamic `import()`. */
  opaque: string[];
}

/** The import chain that pulled `file` into the closure, for messages. */
function viaChain(
  reachedFrom: Map<string, string | null>,
  file: string,
  rel: (abs: string) => string,
): string {
  const chain: string[] = [];
  for (let p = reachedFrom.get(file); p; p = reachedFrom.get(p)) {
    chain.unshift(rel(p));
  }
  return chain.length ? ` (via ${chain.join(' -> ')})` : '';
}

/**
 * Forbidden routes in one file: bare imports of a forbidden package (even
 * type-only, see the header) and spawn-family identifiers. `name` and `via`
 * only label the messages.
 */
function routesIn(
  text: string,
  found: Imports,
  name: string,
  via: string,
): string[] {
  const routes: string[] = [];
  for (const { spec } of found.refs) {
    const reason = spec.startsWith('.') ? null : forbiddenReason(spec);
    if (reason) routes.push(`${name} imports ${spec} [${reason}]${via}`);
  }
  const call = SPAWN_IDENTIFIER.exec(stripComments(text));
  if (call) {
    const id = call[1] ?? call[2];
    routes.push(`${name} references ${id} [process spawning]${via}`);
  }
  return routes;
}

/**
 * Walk the value-import closure from every source file under `roots`
 * (relative to `base`) and report each forbidden route found in it.
 */
function scanModelFree(base: string, roots: string[]): Scan {
  const rel = (abs: string): string =>
    relative(base, abs).split('\\').join('/');
  const reachedFrom = new Map<string, string | null>();
  const queue = roots.flatMap((r) => sourceFilesUnder(join(base, r)));
  for (const f of queue) reachedFrom.set(f, null);

  const violations: string[] = [];
  const opaque: string[] = [];
  for (let i = 0; i < queue.length; i += 1) {
    const file = queue[i]!;
    const text = readFileSync(file, 'utf-8');
    const found = importsOf(text);
    if (found.opaque) opaque.push(rel(file));
    for (const { spec, typeOnly } of found.refs) {
      // Type-only edges are erased at compile time: not followed (header).
      if (!spec.startsWith('.') || typeOnly) continue;
      const target = resolveRelative(file, spec);
      if (target && !reachedFrom.has(target)) {
        reachedFrom.set(target, file);
        queue.push(target);
      }
    }
    const via = viaChain(reachedFrom, file, rel);
    violations.push(...routesIn(text, found, rel(file), via));
  }
  return {
    closure: queue.map(rel).sort(),
    violations: violations.sort(),
    opaque: opaque.sort(),
  };
}

/**
 * Planted fixture trees, one miniature repo each. The detector scans only a
 * tree's `gen-data/` directory and the offending module sits in `shared/`,
 * outside the scanned root, so it is reached only by following a relative
 * import. A detector that read `gen-data/` alone would miss every case.
 *
 * | Tree            | Planted route (`gen-data/entry.ts` -> `shared/...`) | Expected |
 * | --------------- | --------------------------------------------------- | -------- |
 * | `model-sdk`     | helper imports `@anthropic-ai/sdk`                  | flagged  |
 * | `child-process` | helper imports `node:child_process`                 | flagged  |
 * | `deps-spawn`    | helper calls an injected `deps.spawnSync(...)`      | flagged  |
 * | `type-only`     | `import type` of a module that imports a subprocess | clean    |
 *
 * Written to a temp dir rather than checked in under `test/fixtures/`, as
 * `import-graph-acyclic.test.ts` does: committed `.ts` fixtures are walked by
 * `harness cleanup`, and these eight files would read as 15 dead-code
 * findings against the entropy ceiling.
 */
const TREES: Record<string, Record<string, string>> = {
  'model-sdk': {
    'gen-data/entry.ts':
      "import { pickValue } from '../shared/values.js';\n\nexport const value = pickValue();\n",
    'shared/values.ts':
      "import Anthropic from '@anthropic-ai/sdk';\n\nexport function pickValue(): unknown {\n  return new Anthropic();\n}\n",
  },
  'child-process': {
    'gen-data/entry.ts':
      "import { run } from '../shared/run.js';\n\nexport const out = run();\n",
    'shared/run.ts':
      "import { spawnSync } from 'node:child_process';\n\nexport function run(): string {\n  return String(spawnSync('echo', ['hi']).stdout);\n}\n",
  },
  'deps-spawn': {
    'gen-data/entry.ts': "export { runner } from '../shared/runner.js';\n",
    // The MainDeps route: no child_process import, the spawn arrives injected.
    'shared/runner.ts':
      "export function runner(deps: { spawnSync: (c: string) => unknown }): unknown {\n  return deps.spawnSync('model-cli');\n}\n",
  },
  'type-only': {
    'gen-data/entry.ts':
      "import type { Shape } from '../shared/heavy.js';\n\nexport const shape: Shape | null = null;\n",
    'shared/heavy.ts':
      "import { spawnSync } from 'node:child_process';\n\nexport type Shape = { kind: string };\nexport const probe = (): unknown => spawnSync('true');\n",
  },
};

let plantDir = '';

const fixture = (tree: string): Scan =>
  scanModelFree(join(plantDir, tree), ['gen-data']);

/**
 * Planted positives. Each tree hides its offending module in `shared/`,
 * outside the scanned `gen-data/` root, so a pass here proves the detector
 * follows imports rather than reading only the named directories. Without
 * these, a clean live tree is indistinguishable from a detector that returns
 * `[]` unconditionally.
 */
describe('planted positives (transitive)', () => {
  beforeAll(() => {
    plantDir = mkdtempSync(join(tmpdir(), 'gen-data-model-free-'));
    for (const [tree, files] of Object.entries(TREES)) {
      for (const [file, body] of Object.entries(files)) {
        const abs = join(plantDir, tree, file);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, body);
      }
    }
  });
  afterAll(() => rmSync(plantDir, { recursive: true, force: true }));

  it('flags a model SDK imported by a helper outside the scanned root', () => {
    expect(fixture('model-sdk').violations).toEqual([
      'shared/values.ts imports @anthropic-ai/sdk [model SDK] (via gen-data/entry.ts)',
    ]);
  });

  it('flags node:child_process imported by a helper outside the scanned root', () => {
    expect(fixture('child-process').violations).toEqual([
      'shared/run.ts imports node:child_process [process spawning] (via gen-data/entry.ts)',
      'shared/run.ts references spawnSync [process spawning] (via gen-data/entry.ts)',
    ]);
  });

  it('flags an injected deps.spawnSync call reached through a re-export', () => {
    expect(fixture('deps-spawn').violations).toEqual([
      'shared/runner.ts references spawnSync [process spawning] (via gen-data/entry.ts)',
    ]);
  });

  it('does not follow an import type into a module that spawns', () => {
    // Clean control for the type-only decision documented above: the erased
    // edge is not walked, so the spawning module never enters the closure.
    expect(fixture('type-only').closure).toEqual(['gen-data/entry.ts']);
  });
});

describe('import extraction', () => {
  it.each([
    ["import OpenAI from 'openai';", 'openai'],
    ["const m = await import('ollama');", 'ollama'],
    ["const cp = require('child_process');", 'child_process'],
    ["import 'execa';", 'execa'],
    ["export { x } from '@langchain/core/llms';", '@langchain/core/llms'],
    ['import {\n  generateText,\n} from "ai";', 'ai'],
  ])('reads the specifier of %j', (source, spec) => {
    expect(importsOf(source).refs.map((r) => r.spec)).toContain(spec);
  });

  it('marks `import type` as type-only', () => {
    expect(importsOf("import type { A } from './a.js';").refs).toEqual([
      { spec: './a.js', typeOnly: true },
    ]);
  });

  it('ignores an import that appears only in a comment', () => {
    const src = "// import x from 'openai';\n/* require('execa') */\n";
    expect(importsOf(src).refs).toEqual([]);
  });

  it('reports no route for spawn calls that appear only in comments', () => {
    const src = "// spawnSync('a')\n/* fork() */\n";
    expect(routesIn(src, importsOf(src), 'f.ts', '')).toEqual([]);
  });

  it('reports a non-literal dynamic import as opaque, with no specifier', () => {
    expect(importsOf('await import(pathToFileURL(f).href);')).toEqual({
      refs: [],
      opaque: true,
    });
  });
});

describe('forbidden package matching', () => {
  it.each([
    ['@anthropic-ai/sdk', 'model SDK'],
    ['@anthropic-ai/bedrock-sdk', 'model SDK'],
    ['openai/resources', 'model SDK'],
    ['@google/genai', 'model SDK'],
    ['ai', 'model SDK'],
    ['node:child_process', 'process spawning'],
    ['cross-spawn', 'process spawning'],
  ])('forbids %s', (spec, reason) => {
    expect(forbiddenReason(spec)).toBe(reason);
  });

  it.each(['commander', 'node:fs', 'aidbox', 'openapi-types', '@google/maps'])(
    'allows %s',
    (spec) => {
      expect(forbiddenReason(spec)).toBeNull();
    },
  );
});

describe('live gen-data closure', () => {
  const live = scanModelFree(REPO_ROOT, GEN_DATA_DIRS);

  it('closure holds both gen-data entry points and a module outside them', () => {
    // Denominator rule: a moved or renamed gen-data directory must turn this
    // red, not leave a vacuous "no violations" over zero files. Reaching
    // cli-common.ts proves the walk is transitive on the real tree too.
    expect(
      live.closure,
      'gen-data dirs moved or the walk stopped following imports: the guard is vacuous',
    ).toEqual(
      expect.arrayContaining([
        'ts/src/gen-data/gen-data-cli.ts',
        'ts/src/core/gen-data/generate.ts',
        'ts/src/cli-common.ts',
      ]),
    );
  });

  it('reaches no model SDK and no process-spawning route', () => {
    expect(
      live.violations,
      'ADR 0041: gen-data must not reach a model or a subprocess; each line names the route',
    ).toEqual([]);
  });

  it('has only self-check.ts as an unfollowable dynamic import', () => {
    // self-check.ts loads the bundled blackhawk/savant scanner.mjs files by
    // computed path (ADR 0041, Context). It cannot be followed statically; a
    // second opaque import should fail here and be read by a human.
    expect(
      live.opaque,
      'a new non-literal import() in the gen-data closure needs a human read',
    ).toEqual(['ts/src/core/gen-data/self-check.ts']);
  });
});
