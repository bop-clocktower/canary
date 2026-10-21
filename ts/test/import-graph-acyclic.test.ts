/**
 * The live import graph under `ts/src` contains no cycles (#543).
 *
 * Companion to `harness-config-denominator.test.ts`. That file proves the
 * architecture rules *match* real files; this one proves the property those
 * rules exist to protect actually holds — and it is the invariant
 * `harness check-deps` enforces in `.github/workflows/harness-architecture.yml`,
 * reproduced locally so the graph is checked at desk speed rather than only
 * after a push.
 *
 * Why this test appears now: `check-deps` reported `validation passed` for the
 * entire life of the TypeScript engine while two genuine cycles sat in the
 * tree. It was not wrong so much as empty — the layer patterns still pointed at
 * the deleted `agent/` tree, so it analysed nothing. Repointing them turned a
 * vacuous pass into two findings. A gate that only starts failing once you give
 * it something to look at was never a gate.
 *
 * TYPE-ONLY IMPORTS COUNT. `import type { X } from './y.js'` is erased at
 * compile time and cannot deadlock a module at runtime, so a purist graph would
 * drop it. This test keeps it, for one reason: the CI gate keeps it. A local
 * check that is *more* permissive than the gate it stands in for hands back
 * green while the pipeline goes red, which is the same false-confidence shape
 * #543 is about. Matching the gate beats being theoretically tidy.
 *
 * `npm/src` TOO (#1422). `check-deps` reports value and type-only cycles in
 * `ts/src` but reads no file in `npm/src` (no layer pattern matches it), so it
 * missed two real `import type` cycles there that the arch ratchet caught.
 *
 * Offline: reads source text, resolves relative specifiers by path. It never
 * imports project code, so a cycle here cannot break the test that detects it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_ROOT = 'ts/src';

/** Tracked `.ts` files under `root`, repo-relative. */
function sourceFiles(root: string = SOURCE_ROOT): string[] {
  return execFileSync('git', ['ls-files', '-z', root], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
}

/**
 * Relative import specifiers in a file.
 *
 * Two forms, because two forms create edges:
 *   - `import ... from './x.js'` and `export ... from './x.js'`
 *   - `import './x.js'` — side-effect only, no `from` clause
 *
 * The side-effect form is matched even though `ts/src` currently contains none.
 * A detector that misses a real edge reports "no cycles" for the wrong reason,
 * which is the failure this whole file exists to rule out; leaving the form
 * uncovered would make that a matter of luck rather than of design.
 *
 * Bare specifiers (`node:fs`, `@supabase/supabase-js`) are skipped: they are
 * outside the graph under test and can never close a local cycle. Dynamic
 * `import(expr)` with a non-literal specifier is unresolvable statically and is
 * skipped by this test exactly as it is by `harness check-deps`; the one
 * occurrence in the tree (`skills-cli.ts`, loading an external skill module by
 * name) could not be graphed by either.
 */
function relativeSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*['"](\.[^'"]*)['"]/g,
    /(?:^|\n)\s*import\s*['"](\.[^'"]*)['"]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) found.push(m[1]!);
  }
  return found;
}

/**
 * Resolve a specifier to a `baseDir`-relative `.ts` path, or null when it
 * leaves `root`. NodeNext and node16 specifiers carry a `.js` suffix that maps
 * back to the `.ts` on disk; directory specifiers resolve through `index.ts`.
 */
function resolveSpecifier(
  fromFile: string,
  spec: string,
  root: string,
  baseDir: string,
): string | null {
  const base = resolve(baseDir, dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    join(base, 'index.ts'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      const rel = relative(baseDir, c).split('\\').join('/');
      if (rel.startsWith(`${root}/`)) return rel;
    }
  }
  return null;
}

function buildGraph(files: string[], root: string, baseDir = REPO_ROOT) {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(join(baseDir, file), 'utf-8');
    const edges = relativeSpecifiers(text)
      .map((s) => resolveSpecifier(file, s, root, baseDir))
      .filter((t): t is string => t !== null && t !== file);
    graph.set(file, [...new Set(edges)]);
  }
  return graph;
}

/** DFS colours: unvisited, on the current stack, finished. */
const WHITE = 0;
const GREY = 1;
const BLACK = 2;

interface Walk {
  graph: Map<string, string[]>;
  colour: Map<string, number>;
  stack: string[];
  cycles: Map<string, string>;
}

/**
 * Record the cycle closed by an edge back into a node already on the stack.
 *
 * Keyed by sorted member set, so one cycle is reported once no matter which
 * entry point reached it first.
 */
function recordCycle(walk: Walk, closing: string): void {
  const members = walk.stack.slice(walk.stack.indexOf(closing));
  const key = [...members].sort().join('|');
  if (!walk.cycles.has(key)) {
    walk.cycles.set(key, [...members, closing].join(' -> '));
  }
}

/** Colour-marking DFS: an edge into a grey node closes a cycle. */
function visit(walk: Walk, node: string): void {
  walk.colour.set(node, GREY);
  walk.stack.push(node);
  for (const next of walk.graph.get(node) ?? []) {
    const colour = walk.colour.get(next) ?? WHITE;
    if (colour === GREY) recordCycle(walk, next);
    else if (colour === WHITE) visit(walk, next);
  }
  walk.stack.pop();
  walk.colour.set(node, BLACK);
}

/** Every cycle in the graph, each as a readable `a -> b -> a` chain. */
function findCycles(graph: Map<string, string[]>): string[] {
  const walk: Walk = {
    graph,
    colour: new Map(),
    stack: [],
    cycles: new Map(),
  };
  for (const node of graph.keys()) {
    if ((walk.colour.get(node) ?? WHITE) === WHITE) visit(walk, node);
  }
  return [...walk.cycles.values()].sort();
}

const graphOf = (root: string) => buildGraph(sourceFiles(root), root);

const FILES = sourceFiles();
const GRAPH = buildGraph(FILES, SOURCE_ROOT);

/**
 * Self-checks on the detector.
 *
 * Without these, the only evidence the cycle finder works was that it went red
 * once against the two cycles this PR fixes — evidence that cannot be produced
 * again from a clean tree. A detector whose sole proof of life is a failure you
 * have since fixed is indistinguishable from one that returns `[]`
 * unconditionally, and "no cycles found" would then be worth nothing.
 */
describe('cycle detector self-checks', () => {
  const graph = (edges: Record<string, string[]>): Map<string, string[]> =>
    new Map(Object.entries(edges));

  it('finds a two-node cycle and names the chain', () => {
    expect(findCycles(graph({ a: ['b'], b: ['a'] }))).toEqual(['a -> b -> a']);
  });

  it('finds a cycle reachable only through an acyclic prefix', () => {
    // The shape both real findings had: an entry point that is not itself part
    // of the cycle it leads to.
    expect(findCycles(graph({ entry: ['a'], a: ['b'], b: ['a'] }))).toEqual([
      'a -> b -> a',
    ]);
  });

  it('reports one cycle once regardless of entry point', () => {
    const found = findCycles(graph({ a: ['b'], b: ['a'], c: ['a'] }));
    expect(found).toHaveLength(1);
  });

  it('reports nothing for a diamond', () => {
    // Shared dependencies are not cycles; a detector that cannot tell the
    // difference would fail this suite constantly and get deleted.
    expect(
      findCycles(graph({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] })),
    ).toEqual([]);
  });

  it('extracts both import forms and ignores bare specifiers', () => {
    const source = [
      "import { a } from './a.js';",
      "import './side-effect.js';",
      "export { b } from './b.js';",
      "import { readFileSync } from 'node:fs';",
      "import pkg from '@scope/pkg';",
    ].join('\n');
    expect(relativeSpecifiers(source)).toEqual(
      expect.arrayContaining(['./a.js', './side-effect.js', './b.js']),
    );
    expect(relativeSpecifiers(source)).toHaveLength(3);
  });
});

describe('ts/src import graph (#543)', () => {
  it('has a non-empty file denominator', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it('resolves a non-empty edge set', () => {
    // Guards the resolver itself: a specifier regex that silently matched
    // nothing would make the cycle check below pass for the wrong reason.
    const edges = [...GRAPH.values()].reduce((n, e) => n + e.length, 0);
    expect(edges).toBeGreaterThan(0);
  });

  it('contains no circular dependencies', () => {
    // Named in the failure so the fix is the chain, not a bisect.
    expect(findCycles(GRAPH)).toEqual([]);
  });
});

// Planted positives (#1422), written to a temp dir: committed, they would be
// counted by the arch and entropy ratchets, which walk ts/test/fixtures/ too.
const PLANTED: Record<string, string> = {
  'value/a.ts': "import { b } from './b.js';\nexport const a = b;\n",
  'value/b.ts': "import { a } from './a.js';\nexport const b = a;\n",
  'type/a.ts': "import type { B } from './b.js';\nexport type A = B[];\n",
  'type/b.ts': "import type { A } from './a.js';\nexport type B = A[];\n",
};

describe('planted cycles through the real file pipeline (#1422)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-cycles-'));
  for (const [file, source] of Object.entries(PLANTED)) {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), source);
  }
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const plantedGraph = (shape: string) =>
    buildGraph([`${shape}/a.ts`, `${shape}/b.ts`], shape, dir);

  it.each([
    { shape: 'value', via: 'value imports' },
    { shape: 'type', via: 'only `import type` edges' },
  ])('reports a two-file cycle closed through $via', ({ shape }) => {
    expect(findCycles(plantedGraph(shape))).toEqual([
      `${shape}/a.ts -> ${shape}/b.ts -> ${shape}/a.ts`,
    ]);
  });
});

describe('npm/src import graph (#1422)', () => {
  const NPM_GRAPH = graphOf('npm/src');
  it('has a non-vacuous denominator (files and resolved edges)', () => {
    // Either zero makes the acyclic check below pass over nothing.
    expect(NPM_GRAPH.size, 'npm/src: no .ts files').toBeGreaterThan(0);
    const edges = [...NPM_GRAPH.values()].reduce((n, e) => n + e.length, 0);
    expect(edges, 'npm/src: no import resolved').toBeGreaterThan(0);
  });

  it('contains no circular dependencies', () => {
    const why = 'npm/src import cycles; move the shared types to a leaf module';
    expect(findCycles(NPM_GRAPH), why).toEqual([]);
  });
});
