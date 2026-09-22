/**
 * Gates that would keep reporting green after their denominator collapsed
 * (#1057).
 *
 * The repo states the rule in its own source — `dogfood.yml:304-306`: *"the
 * half verified ZERO items, so it measured nothing. This is not a pass."* —
 * and `docs-lint.yml` states it again for the removed-symbols job: *"a gate
 * matching zero patterns has verified nothing and cannot report a pass."*
 * These tests assert that rule where it was not yet applied.
 *
 * Both are INVARIANTS rather than instances, so the next gate to grow the
 * pattern fails here instead of shipping a permanent green.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

interface Step {
  name?: string;
  run?: string;
}
interface Job {
  name?: string;
  steps?: Step[];
}
interface Workflow {
  jobs?: Record<string, Job>;
}

function loadWorkflow(file: string): Workflow {
  return loadYaml(
    readFileSync(join(REPO_ROOT, '.github', 'workflows', file), 'utf8'),
  ) as Workflow;
}

/**
 * The shell body of the step that renders every Mermaid chart in `docs/wiki`,
 * lifted verbatim out of the workflow so the test exercises the REAL script
 * rather than a paraphrase of it.
 */
function mermaidRunBlock(): string {
  const job = loadWorkflow('docs-lint.yml').jobs?.mermaid;
  const step = job?.steps?.find((s) => s.run?.includes('mermaid-cli'));
  if (!step?.run)
    throw new Error('docs-lint.yml: mermaid render step not found');
  return step.run;
}

describe('#1057 — "Wiki diagrams render" must abstain, not pass, on zero charts', () => {
  /**
   * Executed, not pattern-matched. With an EMPTY `docs/wiki` the loop body
   * never runs, so `npx @mermaid-js/mermaid-cli` is never invoked and this
   * stays hermetic and offline — but every other line of the real step runs.
   *
   * The current denominator in this repo is 1: a single file carries the only
   * mermaid chart in the tree. Deleting or restructuring it converts a
   * REQUIRED check into a permanent green that renders nothing.
   */
  function runWithEmptyWikiDir(): { status: number | null; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mermaid-denominator-'));
    mkdirSync(join(dir, 'docs', 'wiki'), { recursive: true });
    const r = spawnSync('bash', ['-c', mermaidRunBlock()], {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, RUNNER_TEMP: dir },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it('finds the mermaid render step to check (zero denominator is an abstention)', () => {
    expect(mermaidRunBlock()).toContain('mermaid-cli');
  });

  it('exits non-zero when it found no charts to render', () => {
    expect(runWithEmptyWikiDir().status).not.toBe(0);
  });

  it('annotates the abstention so the reason is visible in the run log', () => {
    expect(runWithEmptyWikiDir().out).toMatch(/::error::/);
  });
});

describe('#1057 — a tool-gated skip must announce itself', () => {
  /**
   * `const itX = have('x') ? it : it.skip;` turns a missing tool into a silent
   * skip. Vitest's default reporter — the one `npm test` and every CI job use
   * — records the whole event as a digit in `N skipped` and never names the
   * test or the reason. `ts/test/abstention-testkit.ts` exists precisely for
   * this (#650); this invariant makes routing through it mandatory.
   */
  const GATE = /^const\s+\w+\s*=.*\?\s*it\s*:\s*it\.skip/m;

  const gated = readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(join(TEST_DIR, f), 'utf8')] as const)
    .filter(([, src]) => GATE.test(src));

  it('has at least one tool-gated test file to check', () => {
    expect(gated.length).toBeGreaterThan(0);
  });

  it.each(gated.map(([f]) => f))(
    '%s reports an abstention when the tool is absent',
    (file) => {
      const src = readFileSync(join(TEST_DIR, file), 'utf8');
      expect(src).toContain('reportAbstention');
    },
  );
});
