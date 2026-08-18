/**
 * The `traceability` check in `harness ci check` has never had a denominator
 * in CI, and reported `pass` the whole time.
 *
 * `runTraceabilityCheck` is a pure function of `.harness/graph/graph.json`.
 * That path is gitignored (`.harness/.gitignore` ignores `graph/`), it is
 * untracked, and until this change no workflow built it — the only
 * `harness graph` invocation in the repo was COMMENTED OUT in `guardian.yml`.
 * Upstream returns an empty issue list when the graph fails to load, and the
 * reporter renders empty as `pass`. So every `actions/checkout` produced
 * `traceability pass, 0 issues` having read zero requirements.
 *
 * Reproduced at the desk on the same commit with the same pinned CLI: a
 * worktree with a graph present reports `warn traceability 1`; a fresh
 * `git clone` — what CI does — reports `pass traceability 0`.
 *
 * That is the project's most-violated invariant (AGENTS.md, "No silent
 * abstention"): a check that verified zero items has abstained, not passed.
 *
 * Two halves are pinned here, because either alone leaves the false green
 * reachable:
 *
 *   1. The workflow BUILDS the graph before the check runs, and does not
 *      swallow a build failure. A build step that no-ops silently recreates
 *      the bug it was added to fix.
 *   2. The summariser REFUSES to render a traceability entry whose denominator
 *      it cannot see. If the graph is missing or empty, the run says so and
 *      exits 3 — the repo's abstention code — rather than printing `pass`.
 *
 * Note the trap named in AGENTS.md: the denominator is NOT the finding count.
 * Zero traceability issues over 54 requirements is a genuinely clean read;
 * zero over zero is an absent measurement. These tests key the abstention off
 * the requirement count and prove the two do not collapse into each other.
 */

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load as loadYaml } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERDICT = join(REPO_ROOT, 'scripts', 'traceability-verdict.mjs');
const SUMMARY = join(REPO_ROOT, 'scripts', 'harness-report-summary.mjs');
const HARNESS_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'harness.yml');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  'continue-on-error'?: boolean;
}
interface Workflow {
  jobs?: Record<string, { steps?: Step[] }>;
}

function harnessSteps(): Step[] {
  const wf = loadYaml(readFileSync(HARNESS_WORKFLOW, 'utf-8')) as Workflow;
  const steps = wf.jobs?.harness?.steps;
  expect(Array.isArray(steps)).toBe(true);
  return steps as Step[];
}

/** Index of the first step whose `run` block contains `needle`. */
function stepIndex(steps: Step[], needle: string): number {
  return steps.findIndex((s) => (s.run ?? '').includes(needle));
}

/** One requirement in a `harness traceability --json` report. */
function requirement(
  index: number,
  opts: { code?: boolean; test?: boolean; name?: string } = {},
) {
  const file = (path: string) => ({
    path,
    confidence: 0.6,
    method: 'convention',
  });
  return {
    requirementId: `req:fixture:${index}`,
    requirementName: opts.name ?? `Requirement ${index}`,
    index,
    codeFiles: opts.code === false ? [] : [file('ts/src/core/migrator.ts')],
    testFiles: opts.test === true ? [file('ts/test/migrator.test.ts')] : [],
    status: 'traced',
    maxConfidence: 0.6,
  };
}

/** The real `harness traceability --json` shape (harness CLI 11.x). */
function traceReport(requirements: ReturnType<typeof requirement>[]) {
  return [
    {
      specPath: 'docs/changes/fixture/proposal.md',
      featureName: 'fixture',
      requirements,
    },
  ];
}

/** A `harness ci check --json` report carrying one traceability entry. */
function ciReport(
  traceability: { status: string; issues?: unknown[] } = { status: 'pass' },
) {
  return {
    exitCode: 0,
    summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
    checks: [
      {
        name: 'traceability',
        status: traceability.status,
        issues: traceability.issues ?? [],
        durationMs: 988,
      },
    ],
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traceability-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(name: string, body: unknown | string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf-8',
  );
  return path;
}

function runVerdict(path: string) {
  return runCapture('node', [VERDICT, path]);
}

function runSummary(args: string[]) {
  return runCapture('node', [SUMMARY, ...args]);
}

const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * Every `run:` line across every workflow, with comment-only lines dropped.
 *
 * The comment stripping is load-bearing in both directions. `guardian.yml`
 * carries a commented-out `harness graph` invocation with a note saying graph
 * fidelity was considered and declined; counting it inverted the meaning of the
 * original #729 assertion, and it would now let a workflow satisfy "builds the
 * graph" with a line that runs nothing at all.
 */
function runScriptLines(): Array<[string, string]> {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .flatMap((file) => {
      const wf = loadYaml(
        readFileSync(join(WORKFLOW_DIR, file), 'utf8'),
      ) as Workflow;
      return Object.values(wf.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .flatMap((step) =>
          typeof step.run === 'string' ? step.run.split('\n') : [],
        )
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => [file, line] as [string, string]);
    });
}

/**
 * Inherited from #729, which recorded this bug while it was still open.
 *
 * Its third assertion was the inverse of the one below — that NO workflow built
 * the graph — and it said out loud that wiring a build into CI should fail it:
 * "which is the moment AGENTS.md needs rewriting, not a regression". This is
 * that moment. The assertion is inverted rather than deleted, so the invariant
 * still has a guard pointing the other way; the two that remain true are kept
 * verbatim in intent, because they explain WHY the build step has to exist.
 */
describe('the graph the traceability check reads (#729)', () => {
  it('is still gitignored rather than tracked', () => {
    const ignore = readFileSync(
      join(REPO_ROOT, '.harness', '.gitignore'),
      'utf8',
    );
    const rules = ignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));

    // Denominator: an empty ignore file would satisfy any "does not track"
    // phrasing by containing nothing at all.
    expect(rules.length).toBeGreaterThan(0);
    expect(rules).toContain('graph/');
  });

  it('is built by exactly one workflow — the inverse of the #729 assertion', () => {
    const lines = runScriptLines();

    // Denominator: a glob that matched nothing would pass the filter below
    // without inspecting a single workflow.
    expect(lines.length).toBeGreaterThan(0);

    const builders = lines
      .filter(([, line]) => /\bharness\s+graph\b/.test(line))
      .map(([file, line]) => `${file}: ${line}`);
    expect(builders).toHaveLength(1);
    expect(builders[0]).toContain('harness.yml');
  });

  it('is documented in AGENTS.md, naming the file the verdict depends on', () => {
    const agents = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('.harness/graph/graph.json');
    expect(agents).toMatch(/traceability/i);
  });
});

describe('the CI workflow builds the graph the traceability check reads', () => {
  it('runs `harness graph scan` in the harness job', () => {
    const steps = harnessSteps();
    expect(stepIndex(steps, 'harness graph scan')).toBeGreaterThanOrEqual(0);
  });

  it('builds the graph BEFORE `harness ci check` reads it', () => {
    const steps = harnessSteps();
    const build = stepIndex(steps, 'harness graph scan');
    const check = stepIndex(steps, 'harness ci check');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(check);
  });

  it('does not swallow a graph-build failure', () => {
    // A `|| true` here would put the job straight back where it started: the
    // check still runs, still finds no graph, and still prints `pass`. The
    // failure has to be the loud one, because it names the real cause.
    const steps = harnessSteps();
    const build = steps[stepIndex(steps, 'harness graph scan')];
    expect(build.run).not.toMatch(/\|\|\s*(true|echo|:)/);
    expect(build['continue-on-error']).not.toBe(true);
  });

  it('states in a comment why the build step is allowed to fail the job', () => {
    const raw = readFileSync(HARNESS_WORKFLOW, 'utf-8');
    expect(raw).toMatch(/traceability/i);
    expect(raw).toMatch(/denominator|zero|false green|no-op/i);
  });

  it('hands the traceability detail report to the summariser', () => {
    const steps = harnessSteps();
    const summary = steps[stepIndex(steps, 'harness-report-summary.mjs')];
    expect(summary?.run).toContain('--traceability');
  });
});

describe('traceability-verdict', () => {
  describe('a zero denominator is an abstention, never a pass', () => {
    it('abstains on a report with zero requirements', () => {
      const r = runVerdict(writeJson('trace.json', []));
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/ABSTAIN/i);
      expect(r.output).toMatch(/zero requirement/i);
      // The VERDICT must not read as a pass. The word itself is allowed to
      // appear further down — the fix step has to quote the `pass` upstream
      // prints, or the reader cannot connect this to what they saw in CI.
      expect(r.output.split('\n')[0]).not.toMatch(/\bpass(ed|es)?\b/i);
    });

    it('abstains when specs exist but carry no requirements', () => {
      const r = runVerdict(writeJson('trace.json', traceReport([])));
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/zero requirement/i);
    });

    it('passes through the error a bare checkout actually produces', () => {
      // Not a hypothetical shape. Verified against CLI 11 in a fresh
      // `git clone` of this repo — the same thing `actions/checkout` gives CI:
      // `harness traceability --json` exits 2 and writes this object instead
      // of the array of specs. That capture is what the summariser will read
      // on the day someone removes the graph-build step.
      const r = runVerdict(
        writeJson('trace.json', {
          error: 'No knowledge graph found. Run `harness graph scan` first.',
        }),
      );
      expect(r.status).toBe(3);
      expect(r.output).toContain('No knowledge graph found');
    });

    it('names the graph as the first fix step, not just the symptom', () => {
      // AGENTS.md new-gate checklist: "the abstention output names WHY the
      // denominator collapsed and the FIRST FIX STEP. A bare 'abstained' is
      // half a bug report."
      const r = runVerdict(writeJson('trace.json', []));
      expect(r.output).toContain('harness graph scan');
      expect(r.output).toContain('.harness/graph/graph.json');
    });

    it('abstains when the report is missing', () => {
      const r = runVerdict(join(dir, 'absent.json'));
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/ABSTAIN/i);
      expect(r.output).toContain('absent.json');
    });

    it('abstains when the report is not parseable', () => {
      const r = runVerdict(writeJson('trace.json', '[{"specPath":'));
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/truncated|parseable/i);
    });

    it('abstains rather than assuming zero when the shape changed', () => {
      // An upstream rename must surface as "I cannot read this", never as a
      // clean bill of health derived from an absent field.
      const r = runVerdict(writeJson('trace.json', { specs: [] }));
      expect(r.status).toBe(3);
      expect(r.output).toMatch(/ABSTAIN/i);
    });
  });

  describe('a real denominator renders the numbers', () => {
    it('reports requirements, code coverage and test coverage', () => {
      const reqs = [
        requirement(1, { test: true }),
        requirement(2),
        requirement(3),
        requirement(4),
      ];
      const r = runVerdict(writeJson('trace.json', traceReport(reqs)));
      expect(r.status).toBe(0);
      expect(r.output).toContain('4 requirement');
      expect(r.output).toMatch(/4\/4|100%/); // code-traced
      expect(r.output).toMatch(/1\/4|25%/); // test-traced
      expect(r.output).not.toMatch(/ABSTAIN/i);
    });

    it('names the requirements nothing traces at all', () => {
      const r = runVerdict(
        writeJson(
          'trace.json',
          traceReport([
            requirement(1),
            requirement(2, { code: false, name: 'An untraced requirement' }),
          ]),
        ),
      );
      expect(r.status).toBe(0);
      expect(r.output).toContain('An untraced requirement');
      expect(r.output).toContain('docs/changes/fixture/proposal.md');
    });

    it('does not fail the run for thin test coverage', () => {
      // Raising `minCoverage` is a separate, deliberate decision. This surface
      // reports the number honestly; it does not gate on it.
      const r = runVerdict(
        writeJson('trace.json', traceReport([requirement(1), requirement(2)])),
      );
      expect(r.status).toBe(0);
      expect(r.output).toMatch(/0\/2|0%/);
    });
  });

  // The per-row tolerances the classifier already has, pinned before they were
  // moved into named helpers. A partial upstream shape change — one spec whose
  // `requirements` key went missing, one requirement that lost its display
  // name — must degrade to a smaller honest denominator, never to a crash
  // (which reads as a broken gate) and never to a silently inflated count.
  describe('a malformed row degrades the denominator without inflating it', () => {
    it('skips a spec whose requirements are not an array', () => {
      const r = runVerdict(
        writeJson('trace.json', [
          {
            specPath: 'docs/changes/broken/proposal.md',
            featureName: 'broken',
          },
          ...traceReport([requirement(1)]),
        ]),
      );
      expect(r.status).toBe(0);
      // Two specs are read; only the one that carries requirements
      // contributes to the requirement count.
      expect(r.output).toContain('1 requirement');
      expect(r.output).toContain('2 spec');
    });

    it('falls back to the requirement id when the name is missing', () => {
      const { requirementName, ...unnamed } = requirement(1, { code: false });
      expect(requirementName).toBeDefined();
      const r = runVerdict(
        writeJson('trace.json', traceReport([unnamed as never])),
      );
      expect(r.status).toBe(0);
      expect(r.output).toContain('req:fixture:1');
    });

    it('names an untraced requirement that carries no identity at all', () => {
      const r = runVerdict(
        writeJson('trace.json', [
          { specPath: 'docs/changes/fixture/proposal.md', requirements: [{}] },
        ]),
      );
      expect(r.status).toBe(0);
      expect(r.output).toContain('(unnamed)');
    });
  });
});

describe('the summariser refuses a traceability entry with no denominator', () => {
  it('abstains when the CI report has a traceability check and no detail report', () => {
    // The exact shipped false green: `pass`, zero issues, zero requirements
    // read. Without the detail report the summariser cannot tell a clean read
    // from an absent one, and saying so is the finding.
    const r = runSummary([writeJson('report.json', ciReport())]);
    expect(r.status).toBe(3);
    expect(r.output).toMatch(/CANNOT VERIFY|ABSTAIN/i);
    expect(r.output).toContain('--traceability');
  });

  it('abstains when the detail report shows zero requirements', () => {
    const r = runSummary([
      writeJson('report.json', ciReport()),
      '--traceability',
      writeJson('trace.json', []),
    ]);
    expect(r.status).toBe(3);
    expect(r.output).toMatch(/zero requirement/i);
    expect(r.output).toMatch(/::error/);
  });

  it('abstains when the detail report cannot be read', () => {
    const r = runSummary([
      writeJson('report.json', ciReport()),
      '--traceability',
      join(dir, 'absent.json'),
    ]);
    expect(r.status).toBe(3);
    expect(r.output).toContain('absent.json');
  });

  it('still prints the rest of the summary when it abstains', () => {
    // The abstention must not cost the reader the report — that trade was the
    // #588 defect. Everything renders; the exit code carries the verdict.
    const r = runSummary([
      writeJson('report.json', ciReport()),
      '--traceability',
      writeJson('trace.json', []),
    ]);
    expect(r.output).toContain('harness ci check');
    expect(r.output).toContain('traceability');
  });
});

describe('the summariser renders a real traceability denominator', () => {
  it('prints the counts and exits 0', () => {
    const r = runSummary([
      writeJson('report.json', ciReport()),
      '--traceability',
      writeJson(
        'trace.json',
        traceReport([requirement(1, { test: true }), requirement(2)]),
      ),
    ]);
    expect(r.status).toBe(0);
    expect(r.output).toContain('2 requirement');
    expect(r.output).not.toMatch(/ABSTAIN/i);
  });

  it('renders a warn traceability check normally when the denominator is real', () => {
    // The control: a non-zero denominator with a real finding must still read
    // as a finding, not as an abstention. Trading a false green for a false
    // alarm would be the same bug wearing the other sign.
    const report = ciReport({
      status: 'warn',
      issues: [
        {
          severity: 'warning',
          message:
            'Requirement "`span_reader.read_traces()` correctly correlates" has no traced code or tests',
        },
      ],
    });
    const r = runSummary([
      writeJson('report.json', report),
      '--traceability',
      writeJson(
        'trace.json',
        traceReport([requirement(1, { test: true }), requirement(2)]),
      ),
    ]);
    expect(r.status).toBe(0);
    expect(r.output).toContain('span_reader.read_traces()');
    expect(r.output).toContain('2 requirement');
  });

  it('says nothing about traceability when the report has no such check', () => {
    const noTrace = {
      exitCode: 0,
      summary: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
      checks: [{ name: 'arch', status: 'pass', issues: [], durationMs: 5 }],
    };
    const r = runSummary([writeJson('report.json', noTrace)]);
    expect(r.status).toBe(0);
    expect(r.output).not.toMatch(/traceability/i);
  });
});
