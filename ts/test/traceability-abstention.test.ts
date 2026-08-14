/**
 * `harness ci check`'s `traceability` line is an abstention in CI, not a pass
 * (#729).
 *
 * The instance: `traceability` read `pass 0 issue(s)` on every CI run and
 * `warn 1 issue(s)` the first time anyone ran the same command on the same
 * commit at a desk. Nothing between the two commits went near the requirement
 * the warning named, which is what made the movement look non-deterministic.
 *
 * It is not. The check is a pure function of `.harness/graph/graph.json`, and
 * that file is **gitignored and built by no workflow**. Upstream's
 * `runTraceabilityCheck` loads the graph and, when the load fails, returns an
 * empty issue list — which the reporter renders as `pass`. So the check has
 * never run in CI: `pass 0 issue(s)` is a zero denominator wearing a pass's
 * clothes, and the local `warn` is the first time it ran at all.
 *
 * Proven by running the identical commit two ways: with the graph present,
 * `warn traceability 1`; from a fresh `git clone` (what `actions/checkout`
 * produces), `pass traceability 0`.
 *
 * The invariant asserted here is the mechanical half of that claim, so the
 * documentation cannot quietly go stale. If someone wires a graph build into
 * CI, the check starts genuinely running and these tests fail — which is the
 * moment AGENTS.md needs rewriting, not a regression.
 *
 * Offline: parses `.github/workflows/*.yml` with js-yaml and reads two files as
 * text. Never executes a workflow and never runs `harness`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

interface Step {
  run?: string;
}
interface Job {
  steps?: Step[];
}
interface Workflow {
  jobs?: Record<string, Job>;
}

function allWorkflows(): Array<[string, Workflow]> {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map(
      (f) =>
        [
          f,
          loadYaml(readFileSync(join(WORKFLOW_DIR, f), 'utf8')) as Workflow,
        ] as [string, Workflow],
    );
}

/**
 * Every `run:` script in a workflow, with comment-only lines dropped. A
 * commented-out invocation is a note about what CI deliberately does not do —
 * `guardian.yml` carries exactly one, explaining that graph fidelity was
 * considered and declined — so counting it would invert this test's meaning.
 */
function runScriptLines(wf: Workflow): string[] {
  return Object.values(wf.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .flatMap((step) =>
      typeof step.run === 'string' ? step.run.split('\n') : [],
    )
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe('traceability abstains in CI (#729)', () => {
  it('ignores the knowledge graph rather than tracking it', () => {
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

  it('builds the graph in no workflow, so the check has no input in CI', () => {
    const workflows = allWorkflows();

    // Denominator: a glob that matched nothing would pass the loop below
    // without inspecting a single workflow.
    expect(workflows.length).toBeGreaterThan(0);

    const builders: string[] = [];
    for (const [name, wf] of workflows) {
      for (const line of runScriptLines(wf)) {
        if (/\bharness\s+graph\b/.test(line)) builders.push(`${name}: ${line}`);
      }
    }
    expect(builders).toEqual([]);
  });

  it('says so in AGENTS.md, naming the file the verdict depends on', () => {
    const agents = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('.harness/graph/graph.json');
    expect(agents).toMatch(/traceability/i);
  });
});
