/**
 * Every harness scan in `harness-quality.yml` runs the version the resolve
 * step reported, not a fresh resolution of the floating major (#1248).
 *
 * `HARNESS_CLI` is `@harness-engineering/cli@12` on purpose: the float is how
 * CI tracks upstream. The `Resolve harness CLI version` step resolves it once
 * and hands the answer to the docs, entropy and perf ratchets as
 * `--cli-version`, which is what arms their instrument check (#744). But if a
 * scan then runs `npx -p "$HARNESS_CLI"` again, npm resolves `@12` again —
 * and a 12.x published in between, or a runner cache serving a different
 * 12.x, means the report came from an analyzer other than the one
 * `--cli-version` certified. Head and base scans can even disagree with each
 * other, which breaks the delta rules' same-instrument invariant silently.
 *
 * The fix pins WITHIN a run: the resolve step exports
 * `HARNESS_CLI_EXACT=<package>@<resolved>` to `$GITHUB_ENV`, and every later
 * scan uses that. These tests parse the workflow (not grep it), so a scan
 * moved above the resolve step, or into another job, is caught too.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'harness-quality.yml');

type Step = { name?: string; id?: string; run?: string };
type Workflow = {
  env?: Record<string, string>;
  jobs: Record<string, { steps?: Step[] }>;
};

const RESOLVE_ID = 'harness-cli';
/** An `npx ... -p <pkg> harness <subcommand>` invocation, any quoting. */
const NPX_HARNESS =
  /npx\b[^\n]*?-p\s+("?)(\$\w+|'[^']*'|"[^"]*"|\S+)\1[\s\\]*harness\s+([\w-]+)/g;

type Scan = {
  job: string;
  step: string;
  index: number;
  pkg: string;
  sub: string;
};

/** The harness invocations in one step, with the package spec each ran. */
function stepScans(job: string, s: Step, index: number): Scan[] {
  // Folded `run:` scalars keep `\` continuations; join them to one line.
  const run = (s.run ?? '').replace(/\\\n\s*/g, ' ');
  const step = s.name ?? s.id ?? `#${index}`;
  return [...run.matchAll(NPX_HARNESS)].map((m) => ({
    job,
    step,
    index,
    pkg: m[2]!,
    sub: m[3]!,
  }));
}

/** Every harness invocation in every job. */
function scans(wf: Workflow): Scan[] {
  return Object.entries(wf.jobs).flatMap(([job, { steps = [] }]) =>
    steps.flatMap((s, index) => stepScans(job, s, index)),
  );
}

/** Violations of the #1248 invariant; empty means the workflow is pinned. */
function violations(wf: Workflow): string[] {
  const problems: string[] = [];
  for (const scan of scans(wf)) {
    const steps = wf.jobs[scan.job]!.steps ?? [];
    const resolve = steps.findIndex((s) => s.id === RESOLVE_ID);
    if (scan.index === resolve) continue; // the resolve step itself floats, by design
    const where = `${scan.job} / ${scan.step} (harness ${scan.sub})`;
    if (resolve === -1) {
      problems.push(`${where}: job has no '${RESOLVE_ID}' resolve step`);
    } else if (resolve > scan.index) {
      problems.push(`${where}: precedes the resolve step`);
    }
    if (scan.pkg !== '$HARNESS_CLI_EXACT') {
      problems.push(`${where}: uses ${scan.pkg}, not "$HARNESS_CLI_EXACT"`);
    }
  }
  return problems;
}

const load = (text: string): Workflow => loadYaml(text) as Workflow;
const text = (): string => readFileSync(WORKFLOW, 'utf8');

describe('harness-quality.yml pins every scan to the resolved CLI (#1248)', () => {
  it('finds every scan it guards (denominator, not a vacuous pass)', () => {
    const wf = load(text());
    const resolve = stepsOf(wf).findIndex((s) => s.id === RESOLVE_ID);
    const subs = scans(wf)
      .filter((s) => s.index !== resolve)
      .map((s) => s.sub)
      .sort();
    // head + merge base for each of the three ratchets.
    expect(subs).toEqual([
      'check-docs',
      'check-docs',
      'check-perf',
      'check-perf',
      'cleanup',
      'cleanup',
    ]);
  });

  it('runs no scan on the floating pin, and none before the resolve step', () => {
    expect(violations(load(text()))).toEqual([]);
  });

  it('exports the exact version from the resolve step', () => {
    const resolve = stepsOf(load(text())).find((s) => s.id === RESOLVE_ID)!;
    expect(resolve.run).toMatch(
      /npx --yes -p "\$HARNESS_CLI" harness --version/,
    );
    expect(resolve.run).toMatch(
      /echo "HARNESS_CLI_EXACT=\$\{HARNESS_CLI%@\*\}@\$resolved" >> "\$GITHUB_ENV"/,
    );
  });

  it('keeps the workflow-level pin a floating major (pinning is per run)', () => {
    expect(load(text()).env?.HARNESS_CLI).toMatch(
      /^@harness-engineering\/cli@\d+$/,
    );
  });

  // Planted positives: the checker has to see each failure shape, or the
  // green above means nothing.
  describe('the checker catches a planted regression', () => {
    it('a scan back on the floating $HARNESS_CLI', () => {
      const planted = text().replace(
        /"\$HARNESS_CLI_EXACT" harness check-perf/,
        '"$HARNESS_CLI" harness check-perf',
      );
      expect(planted).not.toBe(text());
      expect(violations(load(planted))).toEqual([
        expect.stringMatching(/Harness Performance Check .*uses \$HARNESS_CLI/),
      ]);
    });

    it('a scan moved above the resolve step', () => {
      const wf = load(text());
      const steps = stepsOf(wf);
      const scanAt = steps.findIndex(
        (s) => s.name === 'Harness Cleanup (Entropy Scan)',
      );
      const [scan] = steps.splice(scanAt, 1);
      steps.unshift(scan!);
      expect(violations(wf)).toEqual([
        expect.stringMatching(/Entropy Scan.*precedes the resolve step/),
      ]);
    });

    it('a scan in a job with no resolve step', () => {
      const wf = load(text());
      wf.jobs.extra = {
        steps: [
          {
            name: 'stray',
            run: 'npx --yes -p "$HARNESS_CLI_EXACT" harness check-docs',
          },
        ],
      };
      expect(violations(wf)).toEqual([
        expect.stringMatching(/extra \/ stray.*no 'harness-cli'/),
      ]);
    });

    it('a hardcoded or single-quoted package spec', () => {
      const wf = load(text());
      stepsOf(wf).push({
        name: 'quoted',
        run: "npx --yes -p '@harness-engineering/cli@12' harness cleanup",
      });
      expect(violations(wf)).toEqual([
        expect.stringMatching(/quoted.*uses '@harness/),
      ]);
    });
  });
});

function stepsOf(wf: Workflow): Step[] {
  return wf.jobs.validate!.steps!;
}
