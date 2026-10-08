/**
 * Contract tests for `scripts/docs-ratchet.mjs` (#865).
 *
 * `harness check-docs --min-coverage 3` was an ABSOLUTE floor set at the day's
 * measurement, and main sat on it: 5/199 = 2.51% printed as 3.0% and passed.
 * #864 added two undocumented source files (5/201 = 2.49%) and failed a PR
 * that did nothing wrong except add code. The floor taxed new files instead of
 * catching regressions.
 *
 * The ratchet compares documented-file IDENTITIES against the merge base, the
 * shape the perf ratchet moved to in #853: a PR fails only when a file that was
 * documented at the base is still present and no longer documented. Adding an
 * undocumented file is free; deleting a documented one is free. A report that
 * cannot be read, or that measured nothing, is an abstention (exit 3).
 *
 * #1241 adds the absolute FLOOR the identity rule cannot see: a long run of
 * PRs that each add only undocumented files is green under the identity rule
 * forever, while coverage walks down. The floor lives in
 * `.harness/docs-coverage-baseline.json` with deliberate headroom below the
 * measurement, the same shape as the entropy and perf ceilings, so a single
 * undocumented file does not replay #864.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'docs-ratchet.mjs');

/** The shape `harness check-docs --json` prints, verified against CLI 12. */
function report(documented: string[], undocumented: string[]): string {
  const total = documented.length + undocumented.length;
  const pct = total === 0 ? 0 : Math.round((documented.length / total) * 100);
  return JSON.stringify(
    { valid: true, coveragePercent: pct, documented, undocumented },
    null,
    2,
  );
}

/** `n` file names, for building reports with a chosen ratio. */
const files = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}.ts`);

describe('docs-ratchet', () => {
  let dir: string;
  let head: string;
  let base: string;
  let baseline: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'docs-ratchet-'));
    head = join(dir, 'head.json');
    base = join(dir, 'base.json');
    baseline = join(dir, 'baseline.json');
    // A floor of zero and no instrument: the identity-rule cases below are
    // about the merge base, not the floor, so the floor must not decide them.
    writeFileSync(baseline, JSON.stringify({ minCoveragePercent: 0 }));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(extra: string[] = []): { status: number; out: string } {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--report', head, '--baseline', baseline, ...extra],
      {
        encoding: 'utf8',
      },
    );
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  const withBase = (): string[] => ['--base-report', base];

  it('passes when a PR only adds undocumented files (the #864 case)', () => {
    writeFileSync(base, report(['a.ts', 'b.ts'], ['c.ts']));
    writeFileSync(head, report(['a.ts', 'b.ts'], ['c.ts', 'd.ts', 'e.ts']));
    const r = run(withBase());
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/2\/5 documented/);
  });

  it('fails when a file documented at the base loses its doc link', () => {
    writeFileSync(base, report(['a.ts', 'b.ts'], ['c.ts']));
    writeFileSync(head, report(['a.ts'], ['b.ts', 'c.ts']));
    const r = run(withBase());
    expect(r.status).toBe(1);
    expect(r.out).toContain('b.ts');
  });

  it('explains that only markdown links count, since nothing else says so', () => {
    writeFileSync(base, report(['a.ts', 'b.ts'], []));
    writeFileSync(head, report(['a.ts'], ['b.ts']));
    expect(run(withBase()).out).toMatch(/\[\.\.\]\(path\)/);
  });

  it('does not count a deleted or renamed documented file as a loss', () => {
    writeFileSync(base, report(['a.ts', 'gone.ts'], []));
    writeFileSync(head, report(['a.ts'], ['renamed.ts']));
    expect(run(withBase()).status).toBe(0);
  });

  it('reports without gating when there is no merge base (push to main)', () => {
    writeFileSync(head, report(['a.ts'], ['b.ts']));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/no merge base/i);
  });

  it('tolerates a banner before the JSON body', () => {
    writeFileSync(base, report(['a.ts'], []));
    writeFileSync(head, `npm warn something\n${report(['a.ts'], ['b.ts'])}`);
    expect(run(withBase()).status).toBe(0);
  });

  describe('abstains (exit 3) rather than passing on nothing', () => {
    it('on an empty head report', () => {
      writeFileSync(head, '');
      expect(run().status).toBe(3);
    });

    it('on a missing report file', () => {
      expect(run().status).toBe(3);
    });

    it('on a base report that cannot be parsed', () => {
      writeFileSync(head, report(['a.ts'], []));
      writeFileSync(base, 'x Documentation check crashed');
      expect(run(withBase()).status).toBe(3);
    });

    it('on a head that measured zero files', () => {
      writeFileSync(head, report([], []));
      expect(run().status).toBe(3);
    });

    it('on a base with no documented files at all', () => {
      // This repo has carried documented files since #718. A base reading zero
      // means the instrument stopped seeing links, and with an empty base
      // every loss is invisible, so the delta rule would be green over nothing.
      writeFileSync(base, report([], ['a.ts']));
      writeFileSync(head, report([], ['a.ts']));
      expect(run(withBase()).status).toBe(3);
    });

    it('on a head that suddenly documents nothing', () => {
      writeFileSync(base, report(['a.ts', 'b.ts'], []));
      writeFileSync(head, report([], ['a.ts', 'b.ts']));
      expect(run(withBase()).status).toBe(3);
    });
  });

  describe('coverage floor (#1241)', () => {
    /** A floor of 50% with 5 points of headroom unless a test says otherwise. */
    function writeBaseline(body: Record<string, unknown> = {}): void {
      writeFileSync(
        baseline,
        JSON.stringify({ minCoveragePercent: 50, maxHeadroom: 5, ...body }),
      );
    }

    /** A head report at `documented` out of 100 files. */
    const at = (documented: number): string =>
      report(files('d', documented), files('u', 100 - documented));

    it('fails when coverage drops below the floor', () => {
      writeBaseline();
      writeFileSync(head, at(49));
      const r = run();
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/FAILED/);
      expect(r.out).toContain('49.00%');
      expect(r.out).toContain('50.00%');
    });

    it('passes when coverage sits exactly at the floor', () => {
      writeBaseline();
      writeFileSync(head, at(50));
      const r = run();
      expect(r.status).toBe(0);
      expect(r.out).not.toMatch(/restamp/i);
    });

    it('passes when coverage sits above the floor, inside the headroom', () => {
      writeBaseline();
      writeFileSync(head, at(54));
      const r = run();
      expect(r.status).toBe(0);
      expect(r.out).not.toMatch(/restamp/i);
    });

    // Never auto-tightens: raising the floor is a reviewed baseline edit, the
    // same as lowering an entropy ceiling. The nudge says what to write.
    it('nudges a restamp, without failing, when coverage outgrows the headroom', () => {
      writeBaseline();
      writeFileSync(head, at(60));
      const r = run();
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/restamp/i);
      expect(r.out).toContain('"minCoveragePercent": 55');
    });

    // harness prints Math.round(documented / total * 100), so 49.6% reads as
    // "50" and would clear a 50 floor. The ratchet derives the ratio from the
    // file lists itself.
    it('judges the exact ratio, not the rounded coveragePercent', () => {
      writeBaseline();
      writeFileSync(head, report(files('d', 124), files('u', 126)));
      expect(JSON.parse(readFileSync(head, 'utf8')).coveragePercent).toBe(50);
      expect(run().status).toBe(1);
    });

    // The floor is the backstop the identity rule cannot be: every file here
    // is a NEW undocumented one, so no documented file lost its link.
    it('fires even when the merge-base identity rule is clean', () => {
      writeBaseline();
      writeFileSync(base, at(50));
      writeFileSync(head, report(files('d', 50), files('u', 60)));
      const r = run(withBase());
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/no documented file lost its link/);
    });

    it('runs on a push to main, where there is no merge base', () => {
      writeBaseline();
      writeFileSync(head, at(40));
      expect(run().status).toBe(1);
    });

    describe('abstains (exit 3), never passes, when it cannot verify', () => {
      it('on a report that checked zero files', () => {
        writeBaseline();
        writeFileSync(head, report([], []));
        const r = run();
        expect(r.status).toBe(3);
        expect(r.out).toMatch(/ABSTAINED/);
      });

      it('on a report that says scannedNothing', () => {
        writeBaseline();
        writeFileSync(
          head,
          JSON.stringify({
            valid: false,
            coveragePercent: 0,
            documented: [],
            undocumented: [],
            scanned: 0,
            scannedNothing: true,
          }),
        );
        expect(run().status).toBe(3);
      });

      it('on output that is not check-docs JSON', () => {
        writeBaseline();
        writeFileSync(head, 'x Documentation coverage: 18.0%\n');
        expect(run().status).toBe(3);
      });

      it('on JSON whose lists are missing', () => {
        writeBaseline();
        writeFileSync(head, JSON.stringify({ coveragePercent: 99 }));
        expect(run().status).toBe(3);
      });

      it('on a missing report', () => {
        writeBaseline();
        expect(run().status).toBe(3);
      });
    });

    describe('instrument identity, as the entropy and perf ratchets do', () => {
      it('passes when the running CLI matches the baseline', () => {
        writeBaseline({ harnessCli: '12.10.1' });
        writeFileSync(head, at(50));
        expect(run(['--cli-version', '12.10.1']).status).toBe(0);
      });

      it('ABSTAINS when the CLI moved under the baseline', () => {
        writeBaseline({ harnessCli: '12.10.1' });
        writeFileSync(head, at(10));
        const r = run(['--cli-version', '12.11.0']);
        expect(r.status).toBe(3);
        expect(r.out).toContain('12.10.1');
        expect(r.out).toContain('12.11.0');
      });

      it('ABSTAINS when the baseline names a CLI and the caller does not', () => {
        writeBaseline({ harnessCli: '12.10.1' });
        writeFileSync(head, at(50));
        const r = run();
        expect(r.status).toBe(3);
        expect(r.out).toMatch(/--cli-version/);
      });
    });

    describe('usage errors exit 2 (ADR 0009)', () => {
      it('when --report is not given', () => {
        const r = spawnSync(
          process.execPath,
          [SCRIPT, '--baseline', baseline],
          {
            encoding: 'utf8',
          },
        );
        expect(r.status).toBe(2);
      });

      it('when the baseline file is missing', () => {
        rmSync(baseline);
        writeFileSync(head, at(50));
        expect(run().status).toBe(2);
      });

      it('when the baseline carries no numeric floor', () => {
        writeFileSync(baseline, JSON.stringify({ minCoveragePercent: '50' }));
        writeFileSync(head, at(50));
        expect(run().status).toBe(2);
      });
    });
  });
});

/**
 * The checked-in floor. Offline structural guards on the JSON, the twin of
 * "the checked-in entropy baseline": they catch a HUMAN EDIT (a lowered floor,
 * a floor moved without re-measuring, a missing instrument), not the live
 * tree. Only the ratchet's runtime line sees the live tree.
 */
describe('the checked-in docs coverage baseline (#1241)', () => {
  const BASELINE_REL = '.harness/docs-coverage-baseline.json';
  const BASELINE_PATH = join(REPO_ROOT, BASELINE_REL);

  type Baseline = {
    minCoveragePercent: number;
    maxHeadroom: number;
    measuredDocumented: number;
    measuredScanned: number;
    measuredPercent: number;
    harnessCli: string;
  };

  function baselineNumbers(): Baseline {
    const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    for (const key of [
      'minCoveragePercent',
      'maxHeadroom',
      'measuredDocumented',
      'measuredScanned',
      'measuredPercent',
    ]) {
      expect(typeof raw[key], `${BASELINE_REL} needs a numeric "${key}"`).toBe(
        'number',
      );
    }
    return raw as Baseline;
  }

  // THE ratchet invariant: git holds the only offline ground truth for the
  // value before this edit, so a floor and measurement lowered together
  // cannot pass by agreeing with each other.
  it('never lowers the floor below its last committed value', () => {
    const prev = spawnSync('git', ['show', `HEAD:${BASELINE_REL}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    // A brand-new file has nothing to ratchet against; every other guard runs.
    if (prev.status !== 0) return;
    const before = JSON.parse(prev.stdout).minCoveragePercent as number;
    expect(
      baselineNumbers().minCoveragePercent,
      `${BASELINE_REL}: the docs floor FELL ${before} -> ` +
        `${baselineNumbers().minCoveragePercent}. A ratchet turns one way; ` +
        'link the new files from docs/ instead of lowering the floor.',
    ).toBeGreaterThanOrEqual(before);
  });

  it('records a measurement that agrees with its own counts', () => {
    const b = baselineNumbers();
    expect(b.measuredScanned).toBeGreaterThan(0);
    expect(b.measuredPercent).toBeCloseTo(
      (b.measuredDocumented / b.measuredScanned) * 100,
      2,
    );
  });

  it('never sets the floor above the coverage it last measured', () => {
    const b = baselineNumbers();
    expect(b.minCoveragePercent).toBeLessThanOrEqual(b.measuredPercent);
  });

  it('keeps the floor within the headroom it declares', () => {
    const b = baselineNumbers();
    expect(
      b.measuredPercent - b.minCoveragePercent,
      `${BASELINE_REL}: the floor sits more than "maxHeadroom" below the ` +
        'measurement, so it is not ratcheting. Restamp it.',
    ).toBeLessThanOrEqual(b.maxHeadroom + 1e-9);
  });

  it('records the exact CLI that measured it, on the pinned major', () => {
    const { harnessCli } = baselineNumbers();
    expect(harnessCli).toMatch(/^\d+\.\d+\.\d+$/);
    const yml = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'harness-quality.yml'),
      'utf8',
    );
    const pins = [
      ...yml.matchAll(/^\s*HARNESS_CLI:\s*'@harness-engineering\/cli@(\d+)'/gm),
    ].map((m) => m[1]);
    expect(pins).toHaveLength(1);
    expect(harnessCli.split('.')[0]).toBe(pins[0]);
  });

  it('is the single source of the headroom the ratchet uses', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toContain('parsed.maxHeadroom');
  });
});

describe('the docs merge-base ratchet is wired (#865)', () => {
  const WORKFLOW = join(
    REPO_ROOT,
    '.github',
    'workflows',
    'harness-quality.yml',
  );
  const yaml = (): string => readFileSync(WORKFLOW, 'utf8');

  it('no longer gates on an absolute --min-coverage floor above zero', () => {
    // Comments narrate the old `--min-coverage 3` floor; only commands count.
    const code = yaml()
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    for (const m of code.matchAll(/--min-coverage\s+(\d+)/g)) {
      expect(Number(m[1])).toBe(0);
    }
  });

  it('measures head and base with the same floating pin, as JSON', () => {
    const scans = [
      ...yaml().matchAll(
        /npx --yes -p "\$HARNESS_CLI" harness check-docs --json/g,
      ),
    ];
    expect(scans.length).toBe(2);
  });

  it('puts the base worktree outside the checkout', () => {
    expect(yaml()).toMatch(
      /git worktree add --detach "\$RUNNER_TEMP\/docs-base"/,
    );
  });

  it('gates the base scan on pull_request and hands it to the ratchet', () => {
    expect(yaml()).toMatch(
      /Harness Docs Coverage \(merge base\)[\s\S]{0,200}?if:\s*github\.event_name == 'pull_request'/,
    );
    expect(yaml()).toMatch(/docs-ratchet\.mjs[\s\S]{0,200}?\$DOCS_BASE_FLAG/);
  });

  // #1241: the floor is only armed if CI names the analyzer that measured the
  // head. Without `--cli-version` the ratchet abstains on every run.
  it('hands the resolved CLI version to the ratchet', () => {
    expect(yaml()).toMatch(
      /docs-ratchet\.mjs[\s\S]{0,200}?--cli-version\s+"\$\{\{ steps\.harness-cli\.outputs\.version \}\}"/,
    );
  });

  it('resolves that version before the ratchet step reads it', () => {
    const resolve = yaml().indexOf('id: harness-cli');
    const ratchet = yaml().indexOf('node scripts/docs-ratchet.mjs');
    expect(resolve).toBeGreaterThan(-1);
    expect(ratchet).toBeGreaterThan(resolve);
  });

  it('runs in the required `validate` job, without continue-on-error', () => {
    const y = yaml();
    const step = y.slice(y.indexOf('- name: Docs coverage ratchet (blocking)'));
    const body = step.slice(0, step.indexOf('\n      - '));
    expect(body).not.toMatch(/continue-on-error/);
    expect(y.indexOf('\n  validate:\n')).toBeGreaterThan(-1);
    expect(y.indexOf('\n  validate:\n')).toBeLessThan(
      y.indexOf('Docs coverage ratchet (blocking)'),
    );
  });

  it('keeps the floor in the baseline the ratchet reads by default', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toContain(
      "'docs-coverage-baseline.json'",
    );
    const parsed = JSON.parse(
      readFileSync(
        join(REPO_ROOT, '.harness', 'docs-coverage-baseline.json'),
        'utf8',
      ),
    );
    expect(typeof parsed.minCoveragePercent).toBe('number');
    expect(typeof parsed.harnessCli).toBe('string');
  });
});
