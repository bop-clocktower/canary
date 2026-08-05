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
 * Offline: reads source text, resolves relative specifiers by path. It never
 * imports project code, so a cycle here cannot break the test that detects it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_ROOT = 'ts/src';

/** Tracked `.ts` files under the source root, repo-relative. */
function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', SOURCE_ROOT], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
}

/**
 * Relative import specifiers in a file, `import` and `export ... from` alike.
 *
 * Bare specifiers (`node:fs`, `@supabase/supabase-js`) are skipped: they are
 * outside the graph under test and can never close a local cycle.
 */
function relativeSpecifiers(source: string): string[] {
  const found: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*['"](\.[^'"]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) found.push(m[1]!);
  return found;
}

/**
 * Resolve a specifier to a repo-relative `.ts` path, or null when it leaves the
 * source tree. NodeNext specifiers carry a `.js` suffix that maps back to the
 * `.ts` on disk; directory specifiers resolve through `index.ts`.
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = resolve(REPO_ROOT, dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    join(base, 'index.ts'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      const rel = relative(REPO_ROOT, c).split('\\').join('/');
      if (rel.startsWith(`${SOURCE_ROOT}/`)) return rel;
    }
  }
  return null;
}

function buildGraph(files: string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf-8');
    const edges = relativeSpecifiers(text)
      .map((s) => resolveSpecifier(file, s))
      .filter((t): t is string => t !== null && t !== file);
    graph.set(file, [...new Set(edges)]);
  }
  return graph;
}

/**
 * Every cycle in the graph, each as a readable `a -> b -> a` chain.
 *
 * Plain colour-marking DFS: grey means "on the current stack", so an edge into
 * a grey node closes a cycle and the stack slice names it. Cycles are keyed by
 * their sorted member set, so one cycle is reported once no matter which entry
 * point reached it first.
 */
function findCycles(graph: Map<string, string[]>): string[] {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const stack: string[] = [];
  const cycles = new Map<string, string>();

  function visit(node: string): void {
    colour.set(node, GREY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const c = colour.get(next) ?? WHITE;
      if (c === GREY) {
        const members = stack.slice(stack.indexOf(next));
        const key = [...members].sort().join('|');
        if (!cycles.has(key)) {
          cycles.set(key, [...members, next].join(' -> '));
        }
      } else if (c === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    colour.set(node, BLACK);
  }

  for (const node of graph.keys()) {
    if ((colour.get(node) ?? WHITE) === WHITE) visit(node);
  }
  return [...cycles.values()].sort();
}

const FILES = sourceFiles();
const GRAPH = buildGraph(FILES);

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
