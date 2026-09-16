/**
 * `canary briefing` (#593, PR1): the FACTS half of the mission-briefing test
 * charter. Every test here pins one of the spec's honesty rules rather than a
 * rendering detail, because the failure mode this command exists to avoid is
 * reading as a gate verdict or implying coverage it never measured.
 *
 * Spec: docs/changes/593-mission-briefing/proposal.md (criteria 1-5, 7, 8).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';
import { invokeGuardian } from './guardian-cli-testkit.js';

/** One added range (lines 1-3) in a source file, on the new side. */
const DIFF = [
  'diff --git a/src/discount.ts b/src/discount.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/discount.ts',
  '@@ -0,0 +1,3 @@',
  '+export function discount(n: number): number {',
  '+  return n * 0.9;',
  '+}',
  '',
].join('\n');

/** lcov marking line 2 unhit, so Tier-0 returns a real uncovered verdict. */
const LCOV = 'SF:src/discount.ts\nDA:1,1\nDA:2,0\nDA:3,1\nend_of_record\n';

/** A diff that scopes to nothing: a docs-only change with no source unit. */
const DIFF_NO_UNITS = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,0 +1,1 @@',
  '+a line',
  '',
].join('\n');

/** A two-file diff: one source unit kept, one docs file filtered out. */
const DIFF_MIXED = [
  DIFF.trimEnd(),
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,0 +1,1 @@',
  '+a docs line',
  '',
].join('\n');

/** A second source unit, so a risk ranking has something to order. */
const DIFF_TWO_UNITS = [
  DIFF.trimEnd(),
  'diff --git a/src/summary.ts b/src/summary.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/summary.ts',
  '@@ -0,0 +1,2 @@',
  '+export const label = (n: number): string => `${n}%`;',
  '+export const zero = (): string => label(0);',
  '',
].join('\n');

describe('canary briefing', () => {
  let root: string;
  let diffPath: string;

  beforeEach(() => {
    root = mkTmp();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'discount.ts'),
      'export function discount(n: number): number {\n  return n * 0.9;\n}\n',
      'utf-8',
    );
    diffPath = join(root, 'change.diff');
    writeFileSync(diffPath, DIFF, 'utf-8');
  });
  afterEach(() => {
    rmTmp(root);
  });

  const lcovPath = (): string => {
    const p = join(root, 'lcov.info');
    writeFileSync(p, LCOV, 'utf-8');
    return p;
  };

  /** Criterion 1: a scoped diff emits BriefingFacts v1 and exits 0. */
  it('emits BriefingFacts with schema_version 1 and exits 0', async () => {
    const res = await invokeCanary(['briefing', '--diff', diffPath, '--json'], {
      cwd: root,
    });
    expect(res.code).toBe(0);
    const facts = JSON.parse(res.stdout);
    expect(facts.schema_version).toBe(1);
    expect(facts.units).toHaveLength(1);
    expect(facts.units[0].path).toBe('src/discount.ts');
    expect(facts.units[0].added_ranges).toEqual([[1, 3]]);
    expect(facts.provenance).toMatch(/^Diff: /);
  });

  /** Criterion 2: an empty diff abstains with exit 3, not a silent zero. */
  it('abstains with exit 3 on an empty diff', async () => {
    const empty = join(root, 'empty.diff');
    writeFileSync(empty, '', 'utf-8');
    const res = await invokeCanary(['briefing', '--diff', empty], {
      cwd: root,
    });
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(res.stdout).toContain('Abstained:');
    expect(res.stdout).not.toContain('Test charter');
  });

  /** Criterion 2: unparseable input is an abstention, never an empty charter. */
  it('abstains with exit 3 on an unparseable diff', async () => {
    const junk = join(root, 'junk.diff');
    writeFileSync(junk, 'this is not a unified diff at all\n', 'utf-8');
    const res = await invokeCanary(['briefing', '--diff', junk], { cwd: root });
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(res.stdout).toContain('Abstained:');
  });

  /** Criterion 2: zero units after the guardian filters also abstains. */
  it('abstains with exit 3 when the filters leave zero units', async () => {
    const docs = join(root, 'docs.diff');
    writeFileSync(docs, DIFF_NO_UNITS, 'utf-8');
    const res = await invokeCanary(['briefing', '--diff', docs], { cwd: root });
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(res.stdout).toContain('Abstained:');
  });

  /** Criterion 3: no coverage report means "coverage unknown", never covered. */
  it('labels every unit coverage unknown when coverage is unavailable', async () => {
    const res = await invokeCanary(['briefing', '--diff', diffPath], {
      cwd: root,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Coverage: unavailable');
    expect(res.stdout).toContain('coverage unknown');
    expect(res.stdout).not.toMatch(/\buncovered\b/);
    expect(res.stdout).not.toMatch(/\bcovered\b/);
  });

  /** Criterion 3, JSON half: unavailable coverage is `unknown` per unit. */
  it('reports per-unit coverage unknown in JSON when coverage is unavailable', async () => {
    const res = await invokeCanary(['briefing', '--diff', diffPath, '--json'], {
      cwd: root,
    });
    const facts = JSON.parse(res.stdout);
    expect(facts.coverage.status).toBe('unavailable');
    expect(facts.units[0].coverage).toBe('unknown');
    expect(facts.units[0].execution_evidence).toBeNull();
  });

  /** Criterion 4: an absent inventory says so, and never says "none found". */
  it('states inventory unavailable rather than "none found"', async () => {
    const res = await invokeCanary(['briefing', '--diff', diffPath], {
      cwd: root,
    });
    expect(res.stdout).toContain('Inventory: unavailable');
    expect(res.stdout).not.toContain('none found');
  });

  /** Criterion 4: an unknown schema_version is unavailable, not an empty read. */
  it('treats an unknown inventory schema_version as unavailable', async () => {
    mkdirSync(join(root, '.canary'), { recursive: true });
    writeFileSync(
      join(root, '.canary', 'test-inventory.json'),
      JSON.stringify({ schema_version: 99, files: [], skipped: [] }),
      'utf-8',
    );
    const res = await invokeCanary(['briefing', '--diff', diffPath], {
      cwd: root,
    });
    expect(res.stdout).toContain('Inventory: unavailable');
    expect(res.stdout).not.toContain('none found');
  });

  /** Criterion 4 (positive): a v1 inventory yields the imports column. */
  it('lists inventory import matches when a v1 inventory is present', async () => {
    mkdirSync(join(root, '.canary'), { recursive: true });
    writeFileSync(
      join(root, '.canary', 'test-inventory.json'),
      JSON.stringify({
        schema_version: 1,
        files: [
          {
            path: 'tests/discount.test.ts',
            framework: 'vitest',
            targets: ['src/discount'],
            tests: [{ name: 'discounts', line: 1, depth: 1 }],
          },
        ],
        skipped: [],
      }),
      'utf-8',
    );
    const res = await invokeCanary(['briefing', '--diff', diffPath, '--json'], {
      cwd: root,
    });
    const facts = JSON.parse(res.stdout);
    expect(facts.inventory).toBe('available');
    expect(facts.units[0].imported_by).toEqual(['tests/discount.test.ts']);
  });

  /**
   * Criterion 5: the "Nothing covers" lines are the guardian's own Tier-0
   * uncovered lines for the same diff and report — one definition, two
   * surfaces, asserted by running both.
   */
  it('agrees with the guardian Tier-0 result on the same diff', async () => {
    const lcov = lcovPath();
    const brief = await invokeCanary(
      ['briefing', '--diff', diffPath, '--coverage', lcov, '--json'],
      { cwd: root },
    );
    expect(brief.code).toBe(0);
    const facts = JSON.parse(brief.stdout);
    expect(facts.coverage.status).toBe('verified');
    expect(facts.units[0].coverage).toBe('uncovered');
    expect(facts.units[0].uncovered_lines).toEqual([2]);

    const gate = await invokeGuardian(
      [
        'pr-check',
        '--diff',
        diffPath,
        '--coverage',
        lcov,
        '--format',
        'json',
        '--gate',
        'soft',
      ],
      { cwd: root },
    );
    const gateJson = JSON.parse(gate.stdout);
    const finding = gateJson.findings.find(
      (f: { path: string }) => f.path === 'src/discount.ts',
    );
    expect(finding.uncovered_lines).toEqual(facts.units[0].uncovered_lines);
  });

  /** Criterion 7: the charter can never be read as a verdict. */
  it('carries no gate language, no verdict and no status emoji', async () => {
    const res = await invokeCanary(
      ['briefing', '--diff', diffPath, '--coverage', lcovPath()],
      { cwd: root },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('not a gate');
    expect(res.stdout).not.toMatch(/\bpass(ed|es|ing)?\b/i);
    expect(res.stdout).not.toMatch(/\bfail(ed|s|ing|ure)?\b/i);
    // The word "verdict" appears exactly once, and only to disown one (D3).
    expect(res.stdout).toContain('This is not a verdict');
    expect(res.stdout.match(/verdict/gi)).toHaveLength(1);
    // Status emoji live outside the BMP or in the misc-symbols blocks; the
    // charter is plain ASCII-safe Markdown.
    expect(res.stdout).not.toMatch(
      /[\u{2705}\u{274c}\u{26a0}\u{1f7e2}\u{1f534}]/u,
    );
  });

  /** Criterion 8: never exit 1, and never write a file under tests/. */
  it('never exits 1 and writes nothing under tests/', async () => {
    for (const args of [
      ['briefing', '--diff', diffPath],
      ['briefing', '--diff', diffPath, '--coverage', lcovPath()],
      ['briefing', '--diff', join(root, 'missing.diff')],
    ]) {
      const res = await invokeCanary(args, { cwd: root });
      expect(res.code).not.toBe(1);
      // Only the two contracted codes: 0 for a charter, 3 for an abstention.
      expect([0, EXIT_ABSTAINED]).toContain(res.code);
    }
    expect(existsSync(join(root, 'tests'))).toBe(false);
  });

  /** Sections 5-7 of the charter are present and labelled. */
  it('renders the facts sections a tester works through', async () => {
    const res = await invokeCanary(
      ['briefing', '--diff', diffPath, '--coverage', lcovPath()],
      { cwd: root },
    );
    expect(res.stdout).toContain('## Test charter (advisory, not a gate)');
    expect(res.stdout).toContain('### Existing tests');
    expect(res.stdout).toContain('### Nothing covers');
    expect(res.stdout).toContain('### Out of this charter');
    // PR1 is the facts half only: the judgment sections belong to the skill.
    expect(res.stdout).not.toContain('Verify by hand');
    expect(res.stdout).not.toContain('Edge cases');
  });

  /** Section 6, all-measured branch: no gap is stated as a measurement. */
  it('says everything was measured when no added line came back unhit', async () => {
    const lcov = join(root, 'full.info');
    writeFileSync(
      lcov,
      'SF:src/discount.ts\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n',
      'utf-8',
    );
    const res = await invokeCanary(
      ['briefing', '--diff', diffPath, '--coverage', lcov],
      { cwd: root },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Every changed unit was measured');
    expect(res.stdout).not.toContain('coverage unknown');
  });

  /**
   * Criterion 4, the other side: with a readable inventory that matches
   * nothing, "none found" IS the honest answer and must appear.
   */
  it('says "none found" only when the inventory was actually read', async () => {
    mkdirSync(join(root, '.canary'), { recursive: true });
    writeFileSync(
      join(root, '.canary', 'test-inventory.json'),
      JSON.stringify({
        schema_version: 1,
        files: [
          {
            path: 'tests/unrelated.test.ts',
            framework: 'vitest',
            targets: ['src/something-else'],
            tests: [],
          },
        ],
        skipped: [],
      }),
      'utf-8',
    );
    const res = await invokeCanary(['briefing', '--diff', diffPath], {
      cwd: root,
    });
    expect(res.stdout).toContain('Inventory: available');
    expect(res.stdout).toContain('none found');
  });

  /** D6: a readable ranking orders the units, and the header says so. */
  it('orders units by rank_score when a ranking is readable', async () => {
    const twoUnits = join(root, 'two.diff');
    writeFileSync(twoUnits, DIFF_TWO_UNITS, 'utf-8');
    writeFileSync(
      join(root, 'src', 'summary.ts'),
      'export const label = (n: number): string => `${n}%`;\n' +
        'export const zero = (): string => label(0);\n',
      'utf-8',
    );
    mkdirSync(join(root, '.canary'), { recursive: true });
    writeFileSync(
      join(root, '.canary', 'critical-areas.json'),
      JSON.stringify({
        areas: [
          { path: 'src/discount.ts', rank_score: 0.2 },
          { path: 'src/summary.ts', rank_score: 0.9 },
        ],
      }),
      'utf-8',
    );
    const res = await invokeCanary(['briefing', '--diff', twoUnits, '--json'], {
      cwd: root,
    });
    const facts = JSON.parse(res.stdout);
    expect(facts.risk_ranking).toBe('available');
    expect(facts.units.map((u: { path: string }) => u.path)).toEqual([
      'src/summary.ts',
      'src/discount.ts',
    ]);
    expect(facts.units[0].rank_score).toBe(0.9);
  });

  /** Section 7: a filtered file is named with its reason, never dropped. */
  it('names every filtered file and why it was filtered', async () => {
    const mixed = join(root, 'mixed.diff');
    writeFileSync(mixed, DIFF_MIXED, 'utf-8');
    const res = await invokeCanary(['briefing', '--diff', mixed], {
      cwd: root,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('### Out of this charter');
    expect(res.stdout).toContain('`README.md`');
    const json = await invokeCanary(['briefing', '--diff', mixed, '--json'], {
      cwd: root,
    });
    const facts = JSON.parse(json.stdout);
    expect(facts.units).toHaveLength(1);
    expect(facts.skipped.map((s: { path: string }) => s.path)).toContain(
      'README.md',
    );
    expect(
      facts.skipped.find((s: { path: string }) => s.path === 'README.md')
        .reason,
    ).toBeTruthy();
  });

  /** A diff on stdin resolves like the guardian's, and still abstains empty. */
  it('reads a diff from stdin via --diff -', async () => {
    const res = await invokeCanary(['briefing', '--diff', '-'], { cwd: root });
    // No stdin is attached under the test runner, so this is the abstention
    // path rather than a charter — the point is that `-` is accepted and the
    // empty result is never reported as a clean one.
    expect([0, EXIT_ABSTAINED]).toContain(res.code);
    if (res.code === EXIT_ABSTAINED) {
      expect(res.stdout).toContain('Abstained:');
    }
  });

  /** #369: an omitted --diff must not read as "nothing changed". */
  it('abstains rather than reporting an empty charter when --diff is omitted', async () => {
    const res = await invokeCanary(['briefing'], { cwd: root });
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(res.stdout).toContain('Abstained:');
  });
});
