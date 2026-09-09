/**
 * Prose that states a `harness.config.json` setting must state the real one
 * (#601).
 *
 * #601 is the instance: two live documents said the api-signature suppression
 * lived at `entropy.analyze.drift.checkApiSignatures`, while the key harness
 * actually reads — the one whose value changes `harness ci check` output — is
 * `entropy.drift.checkApiSignatures`. Nothing compared the sentence to the
 * file, so the wrong path survived every gate for months and got copied from
 * the roadmap row into the integration guide.
 *
 * The class is: **a documented key path is a claim about a file sitting in the
 * same repo, and an unchecked claim of that shape reads as verified because it
 * is specific.** Someone renaming or removing a config key has no reason to
 * grep the prose; someone reading the prose has no reason to doubt it. The
 * failure mode is silent on both ends.
 *
 * The invariant: every `` `a.b.c: value` `` claim in live documentation whose
 * root segment is a top-level key of `harness.config.json` must resolve to that
 * exact path, and — when the claimed value parses as JSON — to that exact
 * value.
 *
 * Scope is **live documentation only**. `docs/changes/**`, `docs/plans/**`,
 * `docs/specs/**`, `docs/ideation/**`, `docs/roadmap-archive.md` and
 * `CHANGELOG.md` are dated records of what was true when they were written;
 * rewriting them to match today's config would destroy the record rather than
 * fix a drift. That exclusion is why the scanner's own denominator is asserted
 * below and why a fabricated claim is run through the same matcher — a scope
 * this narrow could otherwise shrink to zero without anyone noticing.
 *
 * Offline: reads `harness.config.json` and the git index. Never runs `harness`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Documents that record history rather than describe the current setup. A
 * stale key path in one of these is accurate reporting, not drift.
 */
const HISTORICAL = [
  'CHANGELOG.md',
  'docs/roadmap-archive.md',
  'docs/changes/',
  'docs/plans/',
  'docs/specs/',
  'docs/ideation/',
];

/**
 * Inline code of the form `path.to.key: value` — the shape prose uses to assert
 * that a setting is configured a particular way. The `: value` half is load
 * bearing: without it the pattern also swallows dotted module paths
 * (`agent.llm`, `agent.core.orchestrator`) and filenames (`roadmap.md`), none
 * of which are claims about this config file.
 */
const CLAIM =
  /`([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*:\s*([^`]+)`/g;

interface Claim {
  file: string;
  line: number;
  path: string;
  value: string;
}

function config(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'harness.config.json'), 'utf-8'),
  ) as Record<string, unknown>;
}

function liveDocs(): string[] {
  return execFileSync('git', ['ls-files', '-z', '*.md'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .filter((f) => !HISTORICAL.some((prefix) => f.startsWith(prefix)));
}

/**
 * Walk a dotted path through the config.
 *
 * Returns `{ found: false }` rather than `undefined` so a key explicitly set to
 * `null` is distinguishable from a key that is not there at all.
 */
function lookup(
  cfg: Record<string, unknown>,
  path: string,
): { found: boolean; value?: unknown } {
  let cursor: unknown = cfg;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return { found: false };
    const record = cursor as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return { found: false };
    }
    cursor = record[segment];
  }
  return { found: true, value: cursor };
}

/** Every config claim in `text`, keyed to the roots the config actually has. */
function claimsIn(file: string, text: string, roots: Set<string>): Claim[] {
  const found: Claim[] = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(CLAIM)) {
      // Both groups are required by CLAIM, so a match populates both. Asserted
      // rather than guarded: a `continue` here would drop a claim silently,
      // which is the exact shape this file exists to catch.
      const path = match[1]!;
      const value = match[2]!;
      if (roots.has(path.split('.')[0]!)) {
        found.push({ file, line: index + 1, path, value: value.trim() });
      }
    }
  });
  return found;
}

const CONFIG = config();
const ROOTS = new Set(Object.keys(CONFIG));
const CLAIMS = liveDocs().flatMap((file) =>
  claimsIn(file, readFileSync(join(REPO_ROOT, file), 'utf-8'), ROOTS),
);

describe('documented harness.config.json settings match the file (#601)', () => {
  it('reads a non-empty config to check claims against', () => {
    expect(ROOTS.size).toBeGreaterThan(0);
  });

  it('finds at least one documented setting in live docs', () => {
    // Zero claims would pass every assertion below by checking nothing. If the
    // last one is legitimately removed, delete this file rather than let it
    // sit here reporting green over an empty set.
    expect(CLAIMS.length).toBeGreaterThan(0);
  });

  it('flags a fabricated key path', () => {
    // The matcher and the lookup are the whole guard; this proves they still
    // discriminate, so a green run above means "checked and correct" rather
    // than "matched nothing".
    const fake = claimsIn(
      'fixture.md',
      'The setting `entropy.nosuchsection.nosuchKey: false` is configured.',
      ROOTS,
    );
    expect(fake).toHaveLength(1);
    expect(lookup(CONFIG, fake[0]!.path).found).toBe(false);
  });

  it.each(CLAIMS.map((c) => [`${c.file}:${c.line}`, c] as const))(
    '%s states a key that exists',
    (_where, claim) => {
      expect(lookup(CONFIG, claim.path).found).toBe(true);
    },
  );

  it.each(CLAIMS.map((c) => [`${c.file}:${c.line}`, c] as const))(
    '%s states the configured value',
    (_where, claim) => {
      let claimed: unknown;
      try {
        claimed = JSON.parse(claim.value);
      } catch {
        // Prose like `docsDir: the docs folder` describes rather than quotes a
        // literal. The path assertion above still covers it.
        return;
      }
      expect(lookup(CONFIG, claim.path).value).toStrictEqual(claimed);
    },
  );
});
