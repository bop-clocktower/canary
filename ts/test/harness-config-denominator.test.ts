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
 * 5. `knowledge.domainBlocklist` blocks paths that are real and only paths that
 *    are not ours (#564). This one needs two different denominators; see the
 *    block comment above it for why the obvious single check cannot work.
 *
 * Offline: reads `harness.config.json` and asks git for its index. Never runs
 * `harness`, and never executes project code.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reportAbstention, reportVerified } from './abstention-testkit.js';

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
  knowledge?: { domainBlocklist?: string[] };
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
      out += pattern[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
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
const BLOCKLIST = CONFIG.knowledge?.domainBlocklist ?? [];

/** True when `entry` names a directory that actually holds at least one file. */
function holdsFiles(entry: string): boolean {
  const path = join(REPO_ROOT, entry);
  if (!existsSync(path) || !statSync(path).isDirectory()) return false;
  return readdirSync(path, { recursive: true, withFileTypes: true }).some((d) =>
    d.isFile(),
  );
}

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

/**
 * Invariant 5 — `knowledge.domainBlocklist` (#564).
 *
 * #564 proposes the obvious check: every blocklist entry matches at least one
 * real path. That check cannot run as specified, and the reason is worth
 * recording because it will come up again for any config key whose subject is
 * deliberately untracked.
 *
 * Both shipped entries name **machine-local agent state**. `.remember` hides
 * itself with a nested `.gitignore` containing `*`; `.kiro` is in the repo
 * `.gitignore`. Neither is tracked, so neither exists in CI or in a fresh
 * clone:
 *
 *     .remember   dev laptop 193 files   fresh clone 0
 *     .kiro       dev laptop  75 files   fresh clone 0
 *     .claude     dev laptop  97 files   fresh clone 2   <- the entry #563 REMOVED
 *     .cursor     dev laptop  73 files   fresh clone 1   <- the entry #563 REMOVED
 *
 * A presence check would therefore go red in CI on both live entries while
 * passing on the two that were deleted for being inert — precisely inverted.
 * The graph-node denominator #564 suggests fares no better: the graph in CI is
 * built from a tree where these directories do not exist.
 *
 * So the property splits in two.
 *
 * 5a runs everywhere and is the one that must never be skipped: an entry must
 * match **zero tracked files**. This catches the failure that actually costs
 * something — blocklisting a path that holds our own committed source, which
 * silently removes it from the knowledge graph. It is the mirror image of
 * invariants 1-2, which demand a non-empty match.
 *
 * 5b is the vacuity check, and it can only run where agent state materialises.
 * The conditional makes it real rather than decorative: if *any* entry is
 * present, this is a checkout where these directories do exist, so an absent
 * entry is a genuine typo or a dead entry and fails. If *none* are present,
 * there is no denominator and the suite abstains **out loud** — reported by
 * vitest as skipped and by the reason line below — rather than passing green
 * on nothing checked.
 *
 * Known floor: "holds at least one file" is weaker than "the graph ingested
 * it". `.claude`/`.cursor` were dropped from #563 because the graph held no
 * *code* nodes under them, and no offline check can see that — both they and
 * `.remember` are almost entirely Markdown. Closing that gap needs a built
 * graph, which is not something a unit test should require.
 */
const VERIFIABLE = BLOCKLIST.filter(holdsFiles);
const UNVERIFIABLE = BLOCKLIST.filter((e) => !holdsFiles(e));

describe('knowledge.domainBlocklist blocks real, foreign paths (#564)', () => {
  it('has at least one blocklist entry to check', () => {
    expect(BLOCKLIST.length).toBeGreaterThan(0);
  });

  // 5a — portable, and the one with teeth.
  it.each(BLOCKLIST)('%s blocks no git-tracked file', (entry) => {
    const tracked = TRACKED.filter(
      (f) => f === entry || f.startsWith(`${entry}/`),
    );
    expect(tracked).toEqual([]);
  });

  // 5b — real where the data exists, an audible abstention where it does not.
  it('states how much of the blocklist this checkout could verify', () => {
    if (UNVERIFIABLE.length === 0) {
      reportVerified(
        'domainBlocklist',
        `all ${BLOCKLIST.length} entries resolved against on-disk state`,
      );
    } else if (VERIFIABLE.length === 0) {
      // No denominator at all — the honest CI case.
      reportAbstention(
        'domainBlocklist',
        `0/${BLOCKLIST.length} entries checkable here (${UNVERIFIABLE.join(', ')}). ` +
          `These are machine-local agent directories, untracked by design, so a ` +
          `clean checkout and CI cannot see them. Nothing about their contents ` +
          `was proven.`,
      );
    } else {
      // Mixed: agent state does materialise here, so the missing ones are dead
      // entries rather than an artefact of the environment. Said plainly,
      // because the failing assertion below is the real verdict.
      reportVerified(
        'domainBlocklist',
        `${VERIFIABLE.length}/${BLOCKLIST.length} entries resolved; ` +
          `${UNVERIFIABLE.join(', ')} did not, on a checkout where the others ` +
          `did — treated as dead entries, not as missing data`,
      );
    }
    expect(VERIFIABLE.length + UNVERIFIABLE.length).toBe(BLOCKLIST.length);
  });

  describe.skipIf(VERIFIABLE.length === 0)(
    'entries resolve on a checkout where agent state exists',
    () => {
      it('every entry names a directory that holds files', () => {
        // Reached only when at least one entry resolved, which proves this
        // checkout is one where these directories materialise — so an absent
        // entry here is a dead entry, not an artefact of the environment.
        expect(UNVERIFIABLE).toEqual([]);
      });
    },
  );
});
