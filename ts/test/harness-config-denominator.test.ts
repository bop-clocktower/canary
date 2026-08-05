/**
 * Class-level structural tests for vacuous architecture rules in
 * `harness.config.json` (#543).
 *
 * #543 was filed as "the layer patterns point at the deleted `agent/` tree".
 * That is the instance. The class is: **a configured rule that matches nothing
 * still reports as configured.** `harness check-arch` stayed green across the
 * entire v6.0.0 Python-to-TypeScript cutover, not because the boundaries held
 * but because there was nothing left for them to hold — a zero denominator is
 * an abstention, not a pass.
 *
 * The specific shape that hid it: `layers[3].pattern` was `tests/**`, and a
 * `tests/` directory does still exist on disk. It contains 280 `.pyc` files and
 * a `generated/` folder, none of it git-tracked. So a naive "does this path
 * exist?" check passes while the rule governs zero source files. That is why
 * the denominator here is **git-tracked files**, never a filesystem walk.
 *
 * The four invariants:
 *
 * 1. Every `layers[].pattern` matches at least one tracked file. A layer that
 *    matches nothing cannot be violated, so it cannot fail.
 *
 * 2. Every `forbiddenImports[].from` and every entry in its `disallow` list
 *    matches at least one tracked file. A boundary drawn between two paths that
 *    no longer exist is a comment wearing a rule's clothes — the pre-v6 rule
 *    isolating `agent/llm/**` from `agent/core/**` protected nothing for the
 *    entire life of the TypeScript engine.
 *
 * 3. Every name in `allowedDependencies` refers to a declared layer. A typo
 *    here silently narrows what is permitted rather than erroring.
 *
 * 4. Every tracked file in the live source tree belongs to some layer.
 *    Invariants 1-3 only prove the rules match *something*; a config could
 *    satisfy all three while governing one file out of seventy-five. This is
 *    the one that makes the rules describe the codebase instead of a corner
 *    of it.
 *
 * Offline: reads `harness.config.json` and asks git for its index. Never runs
 * `harness`, and never executes project code.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The live source tree every layer rule is ultimately meant to cover. */
const SOURCE_ROOT = 'ts/src';

interface Layer {
  name: string;
  pattern: string;
  allowedDependencies?: string[];
}
interface ForbiddenImport {
  from: string;
  disallow: string[];
  message?: string;
}
interface HarnessConfig {
  layers?: Layer[];
  forbiddenImports?: ForbiddenImport[];
}

function config(): HarnessConfig {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'harness.config.json'), 'utf-8'),
  ) as HarnessConfig;
}

/**
 * Git-tracked paths, repo-relative and forward-slashed.
 *
 * Deliberately the index rather than the filesystem: untracked build spoil
 * (`tests/__pycache__`, `ts/dist`, `node_modules`) would otherwise let a dead
 * rule look alive, which is the exact failure #543 describes.
 */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

/**
 * Compile a harness layer glob to a RegExp.
 *
 * Supports the three forms the config uses: `**` across segment boundaries,
 * `*` within one segment, and literal paths. `/​**​/` collapses to an optional
 * run of segments so `ts/src/**​/cli.ts` matches `ts/src/cli.ts` as well as
 * `ts/src/history/cli.ts`.
 */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const rest = pattern.slice(i);
    if (rest.startsWith('/**/')) {
      out += '/(?:.*/)?';
      i += 3;
    } else if (rest.startsWith('**')) {
      out += '.*';
      i += 1;
    } else if (pattern[i] === '*') {
      out += '[^/]*';
    } else {
      out += pattern[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function matches(pattern: string, files: string[]): string[] {
  const re = globToRegExp(pattern);
  return files.filter((f) => re.test(f));
}

const CONFIG = config();
const TRACKED = trackedFiles();
const LAYERS = CONFIG.layers ?? [];
const FORBIDDEN = CONFIG.forbiddenImports ?? [];

describe('harness.config.json architecture rules govern real files (#543)', () => {
  it('git reports a tracked-file denominator', () => {
    expect(TRACKED.length).toBeGreaterThan(0);
  });

  describe('every layer pattern matches something', () => {
    it('has at least one layer to check', () => {
      expect(LAYERS.length).toBeGreaterThan(0);
    });

    it.each(LAYERS.map((l) => [l.name, l.pattern] as const))(
      'layer %s (%s) matches at least one tracked file',
      (_name, pattern) => {
        expect(matches(pattern, TRACKED)).not.toHaveLength(0);
      },
    );
  });

  describe('every import boundary is drawn between paths that exist', () => {
    const sides: Array<[string, string]> = [];
    for (const rule of FORBIDDEN) {
      sides.push([`from ${rule.from}`, rule.from]);
      for (const target of rule.disallow) {
        sides.push([`${rule.from} -x-> ${target}`, target]);
      }
    }

    it('has at least one boundary to check', () => {
      expect(sides.length).toBeGreaterThan(0);
    });

    it.each(sides)(
      '%s matches at least one tracked file',
      (_label, pattern) => {
        expect(matches(pattern, TRACKED)).not.toHaveLength(0);
      },
    );
  });

  describe('layer references resolve', () => {
    const declared = new Set(LAYERS.map((l) => l.name));
    const refs: Array<[string, string]> = LAYERS.flatMap((l) =>
      (l.allowedDependencies ?? []).map(
        (dep) => [l.name, dep] as [string, string],
      ),
    );

    it('has at least one allowedDependencies reference to check', () => {
      expect(refs.length).toBeGreaterThan(0);
    });

    it.each(refs)('layer %s may depend on declared layer %s', (_from, dep) => {
      expect(declared).toContain(dep);
    });
  });

  it('every tracked source file belongs to a layer', () => {
    const sourceFiles = TRACKED.filter(
      (f) => f.startsWith(`${SOURCE_ROOT}/`) && f.endsWith('.ts'),
    );
    expect(sourceFiles.length).toBeGreaterThan(0);

    const covered = new Set(
      LAYERS.flatMap((l) => matches(l.pattern, sourceFiles)),
    );
    const orphans = sourceFiles.filter((f) => !covered.has(f));

    // Named in the failure so the fix is the file list, not a bisect.
    expect(orphans).toEqual([]);
  });
});
