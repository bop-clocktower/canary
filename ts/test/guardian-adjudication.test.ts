/**
 * Tests for adjudication without reactions (ADR 0025, #938).
 *
 * Precision is derived on demand from what GitHub already holds: the sticky
 * comment's edit history (first vs last verdict), the merged diff's
 * `canary:allow-untested` suppressions, and the merged file list. These tests
 * pin each signal, the 30-finding floor, and the disclosed denominators (a PR
 * with no retrievable history or an unparseable sticky is COUNTED, never
 * dropped silently).
 *
 * Network-free: the CLI and evidence collection run against
 * {@link FakeAdjudicationSource}.
 */

import { describe, expect, it } from 'vitest';

import {
  PRECISION_FLOOR,
  PrEvidence,
  classifyFinding,
  deriveReport,
  parseStickyFindings,
  renderReport,
  suppressionKind,
  suppressionsByPath,
} from '../src/guardian/adjudication.js';
import {
  FakeAdjudicationSource,
  collectEvidence,
} from '../src/guardian/adjudication-github.js';
import { GuardianFinding, renderFindings } from '../src/guardian/pr-check.js';
import { Fidelity } from '../src/guardian/diff-coverage/types.js';
import { invokeGuardian } from './guardian-cli-testkit.js';

// --- fixtures -------------------------------------------------------------

function finding(
  path: string,
  fidelity = Fidelity.CoverageVerified,
): GuardianFinding {
  return new GuardianFinding({
    path,
    unit: path,
    evidence: 'lines 1-9: 2 of 9 coverable line(s) uncovered',
    fidelity,
  });
}

/** A sticky body rendered by the real producer, so parser and renderer agree. */
function sticky(...findings: GuardianFinding[]): string {
  return renderFindings(findings, 'comment', 0, null);
}

const addSuppression = (reason: string): string =>
  `@@ -1,1 +1,2 @@\n const x = 1;\n+export type T = 1; // canary:allow-untested ${reason}`;

function pr(
  number: number,
  revisions: string[] | null,
  files: PrEvidence['files'] = [{ filename: 'src/a.ts', patch: '' }],
): PrEvidence {
  return { number, revisions, files };
}

// --- fp: parsing ------------------------------------------------------------

describe('suppressionKind', () => {
  it('a plain reason is intentional', () => {
    expect(suppressionKind('type-only barrel')).toBe('intentional');
  });

  it('an fp: reason is a false positive', () => {
    expect(suppressionKind('fp: type-only barrel')).toBe('false-positive');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(suppressionKind('  FP :  wrong file')).toBe('false-positive');
    expect(suppressionKind('Fp:x')).toBe('false-positive');
  });

  it('a bare fp: with no reason still records a false positive', () => {
    expect(suppressionKind('fp:')).toBe('false-positive');
  });

  it('fp inside a word is not the prefix', () => {
    expect(suppressionKind('fpga shim, no runtime')).toBe('intentional');
  });
});

describe('suppressionsByPath', () => {
  it('reads suppressions on ADDED lines of the merged diff only', () => {
    const map = suppressionsByPath([
      { filename: 'src/a.ts', patch: addSuppression('fp: barrel') },
      { filename: 'src/b.ts', patch: addSuppression('generated') },
      {
        filename: 'src/c.ts',
        patch: '@@ -1 +1 @@\n-// canary:allow-untested fp: gone\n x',
      },
      { filename: 'src/d.ts' },
    ]);
    expect(map.get('src/a.ts')).toBe('false-positive');
    expect(map.get('src/b.ts')).toBe('intentional');
    expect(map.has('src/c.ts')).toBe(false);
    expect(map.has('src/d.ts')).toBe(false);
  });

  it('fp: wins when a file carries both kinds', () => {
    const patch = `${addSuppression('generated')}\n+y; # canary:allow-untested fp: nope`;
    expect(suppressionsByPath([{ filename: 'a.py', patch }]).get('a.py')).toBe(
      'false-positive',
    );
  });
});

// --- sticky parsing -----------------------------------------------------------

describe('parseStickyFindings', () => {
  it('reads path and fidelity from every finding row', () => {
    const body = sticky(
      finding('src/a.ts'),
      finding('src/b.ts', Fidelity.Heuristic),
    );
    expect(parseStickyFindings(body)).toEqual([
      { path: 'src/a.ts', fidelity: 'coverage-verified' },
      { path: 'src/b.ts', fidelity: 'heuristic' },
    ]);
  });

  it('a no-gaps body parses to zero findings, not null', () => {
    expect(parseStickyFindings(sticky())).toEqual([]);
  });

  it('a body that is not a guardian sticky is unparseable (null)', () => {
    expect(parseStickyFindings('thanks, looks good')).toBeNull();
  });

  it('a findings table whose rows no longer parse is null, never zero', () => {
    const body =
      '<!-- canary-pr-guardian -->\n## Canary PR Guardian - 2 files need test coverage\n\n' +
      '| Sev | File | What | Confidence |\n| --- | --- | --- | --- |\n| high | src/a.ts | x |';
    expect(parseStickyFindings(body)).toBeNull();
  });
});

// --- signal classification ----------------------------------------------------

describe('classifyFinding', () => {
  const base = {
    last: [] as { path: string; fidelity: string }[],
    suppressions: new Map<string, 'false-positive' | 'intentional'>(),
    mergedPaths: new Set(['src/a.ts']),
  };
  const f = { path: 'src/a.ts', fidelity: 'coverage-verified' };

  it('disappears and becomes covered -> true positive', () => {
    expect(classifyFinding(f, base)).toBe('true-positive');
  });

  it('allow-untested <reason> -> intentional', () => {
    const suppressions = new Map([['src/a.ts', 'intentional' as const]]);
    expect(classifyFinding(f, { ...base, suppressions })).toBe('intentional');
  });

  it('allow-untested fp: <reason> -> false positive', () => {
    const suppressions = new Map([['src/a.ts', 'false-positive' as const]]);
    expect(classifyFinding(f, { ...base, suppressions })).toBe(
      'false-positive',
    );
  });

  it('still active at merge -> unresolved, not a false positive', () => {
    expect(classifyFinding(f, { ...base, last: [f] })).toBe('unresolved');
  });

  it('disappears because the file left the diff -> ambiguous', () => {
    expect(classifyFinding(f, { ...base, mergedPaths: new Set() })).toBe(
      'ambiguous',
    );
  });

  it('disappears with no coverage evidence (heuristic tier) -> ambiguous', () => {
    expect(classifyFinding({ ...f, fidelity: 'heuristic' }, base)).toBe(
      'ambiguous',
    );
  });
});

// --- report: floor and denominators --------------------------------------------

describe('deriveReport', () => {
  /** A PR whose one coverage-verified finding was fixed by a later commit. */
  const fixed = (n: number): PrEvidence =>
    pr(n, [sticky(finding('src/a.ts')), sticky()]);
  const falsePositive = (n: number): PrEvidence =>
    pr(
      n,
      [sticky(finding('src/a.ts')), sticky()],
      [{ filename: 'src/a.ts', patch: addSuppression('fp: barrel') }],
    );

  it('below the floor precision is null (unknown), never a number', () => {
    const report = deriveReport([fixed(1), fixed(2)], 2);
    expect(report.counts['true-positive']).toBe(2);
    expect(report.adjudicated).toBe(2);
    expect(report.precision).toBeNull();
    expect(renderReport(report)).toContain(`unknown (N < ${PRECISION_FLOOR})`);
    expect(renderReport(report)).not.toContain('100%');
  });

  it('at the floor precision is measured and rendered with its sample size', () => {
    const prs = [
      ...Array.from({ length: 27 }, (_, i) => fixed(i)),
      ...Array.from({ length: 3 }, (_, i) => falsePositive(100 + i)),
    ];
    const report = deriveReport(prs, prs.length);
    expect(report.precision).toBeCloseTo(0.9);
    const text = renderReport(report);
    expect(text).toContain('90%');
    expect(text).toContain('n=30');
  });

  it('intentional, ambiguous and unresolved never count toward the floor', () => {
    const report = deriveReport(
      [
        pr(1, [sticky(finding('src/a.ts')), sticky(finding('src/a.ts'))]),
        pr(2, [sticky(finding('src/a.ts', Fidelity.Heuristic)), sticky()]),
        pr(
          3,
          [sticky(finding('src/a.ts')), sticky()],
          [{ filename: 'src/a.ts', patch: addSuppression('generated') }],
        ),
      ],
      3,
    );
    expect(report.adjudicated).toBe(0);
    expect(report.counts).toMatchObject({
      unresolved: 1,
      ambiguous: 1,
      intentional: 1,
    });
  });

  it('missing edit history excludes the PR and COUNTS it in the denominator', () => {
    const report = deriveReport([fixed(1), pr(2, null)], 5);
    expect(report.prs).toEqual({
      scanned: 5,
      withSticky: 2,
      noHistory: 1,
      unparseable: 0,
    });
    expect(renderReport(report)).toContain('1 excluded: no edit history');
  });

  it('an unparseable sticky excludes the PR and counts it, never as zero findings', () => {
    const report = deriveReport(
      [pr(1, ['<!-- canary-pr-guardian -->\ngarbage', sticky()])],
      1,
    );
    expect(report.prs.unparseable).toBe(1);
    expect(report.counts['true-positive']).toBe(0);
    expect(renderReport(report)).toContain('1 excluded: unparseable sticky');
  });
});

// --- evidence collection (seam) -------------------------------------------------

describe('collectEvidence', () => {
  it('skips PRs without a sticky but still counts them as scanned', async () => {
    const source = new FakeAdjudicationSource({
      merged: [1, 2],
      stickies: { 1: [sticky(finding('src/a.ts')), sticky()] },
      files: { 1: [{ filename: 'src/a.ts', patch: '' }] },
    });
    const { evidence, scanned } = await collectEvidence(source, '2026-09-01');
    expect(scanned).toBe(2);
    expect(evidence.map((e) => e.number)).toEqual([1]);
  });
});

// --- CLI ----------------------------------------------------------------------

describe('guardian precision (CLI, derived)', () => {
  const env = { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r' };

  it('reports unknown with the sample size below the floor', async () => {
    const source = new FakeAdjudicationSource({
      merged: [7],
      stickies: { 7: [sticky(finding('src/a.ts')), sticky()] },
      files: { 7: [{ filename: 'src/a.ts', patch: '' }] },
    });
    const res = await invokeGuardian(['precision'], {
      env,
      deps: { buildAdjudicationSource: () => source },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('unknown (N < 30)');
    expect(res.stdout).toContain('n=1');
  });

  it('--json carries precision null and the counts', async () => {
    const source = new FakeAdjudicationSource({ merged: [] });
    const res = await invokeGuardian(['precision', '--json'], {
      env,
      deps: { buildAdjudicationSource: () => source },
    });
    const json = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(json['precision']).toBeNull();
    expect(json['adjudicated']).toBe(0);
  });

  it('without a token it exits 2 loudly instead of calling the API', async () => {
    const res = await invokeGuardian(['precision'], {
      env: { GITHUB_REPOSITORY: 'o/r' },
      deps: {
        buildAdjudicationSource: () => {
          throw new Error('must not be built without a token');
        },
      },
    });
    expect(res.code).toBe(2);
    expect(res.stdout).toContain('GITHUB_TOKEN');
  });

  it('a non-numeric --days is a usage error (exit 2), not a RangeError crash', async () => {
    const source = new FakeAdjudicationSource({ merged: [] });
    await expect(
      invokeGuardian(['precision', '--days', 'abc'], {
        env,
        deps: { buildAdjudicationSource: () => source },
      }),
    ).resolves.toMatchObject({ code: 2 });
  });

  it('collect-adjudications is gone (ADR 0025)', async () => {
    const res = await invokeGuardian(['collect-adjudications']);
    expect(res.code).not.toBe(0);
  });
});
