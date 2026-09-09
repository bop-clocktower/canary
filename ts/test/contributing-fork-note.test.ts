/**
 * While a required check cannot run on a fork PR, CONTRIBUTING.md has to say so
 * (#843).
 *
 * `No removed-symbol or proprietary leaks` is required
 * (`.github/required-checks.json`) and hard-fails on a zero denominator, which
 * is correct. Its denylist comes only from `secrets.CANARY_PROPRIETARY_DENYLIST`
 * — `.proprietary-denylist` is gitignored, so there is no in-repo fallback — and
 * GitHub does not pass secrets to fork-triggered `pull_request` runs. On a
 * public repo that makes every fork PR structurally unmergeable.
 *
 * The audit on #831 established that this gate has never reported a false
 * green; the abstention has always been loud. So the risk here is not a bad
 * merge, it is a contributor spending an afternoon on a PR that could never
 * have passed, with nothing in the repo warning them.
 *
 * This test couples the warning to the condition that makes it true rather than
 * to a hardcoded expectation, so it RETIRES ITSELF: when #843 moves the gate to
 * a fork-safe trigger (`pull_request_target` / `workflow_run`, which run in
 * base-repo context where secrets resolve), `secretGatedOnForkBlindTrigger`
 * goes empty and the note is no longer demanded. A stale warning that outlives
 * its defect is its own kind of wrong documentation.
 *
 * Offline: reads workflow YAML and JSON. Never executes a workflow.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const CONTRIBUTING = join(REPO_ROOT, 'CONTRIBUTING.md');
const REQUIRED_CHECKS = join(REPO_ROOT, '.github', 'required-checks.json');

/** Triggers that run in BASE-repo context, where secrets resolve for forks. */
const FORK_SAFE_TRIGGERS = ['pull_request_target', 'workflow_run'];

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, unknown>;
}
interface Job {
  name?: string;
  steps?: Step[];
}
interface Workflow {
  on?: unknown;
  jobs?: Record<string, Job>;
}

function triggersOf(wf: Workflow): string[] {
  const on = wf.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === 'object') return Object.keys(on as object);
  return [];
}

/** Every check name `.github/required-checks.json` marks as required. */
function requiredCheckNames(): Set<string> {
  const raw = JSON.parse(readFileSync(REQUIRED_CHECKS, 'utf-8')) as Record<
    string,
    unknown
  >;
  const rows = Object.values(raw).filter(Array.isArray).flat() as Array<{
    check?: unknown;
  }>;
  return new Set(
    rows
      .map((r) => r.check)
      .filter((c): c is string => typeof c === 'string' && c.length > 0),
  );
}

/**
 * Required checks produced by a job that reads a secret, in a workflow with no
 * fork-safe trigger. Each one is a check a fork PR can never satisfy.
 */
function secretGatedOnForkBlindTrigger(): string[] {
  const required = requiredCheckNames();
  const blocked: string[] = [];

  for (const file of readdirSync(WORKFLOW_DIR)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
    const wf = loadYaml(
      readFileSync(join(WORKFLOW_DIR, file), 'utf-8'),
    ) as Workflow;

    const triggers = triggersOf(wf);
    if (!triggers.includes('pull_request')) continue;
    if (triggers.some((t) => FORK_SAFE_TRIGGERS.includes(t))) continue;

    for (const job of Object.values(wf.jobs ?? {})) {
      const readsSecret = (job.steps ?? []).some((s) =>
        JSON.stringify(s.env ?? {}).includes('secrets.'),
      );
      if (!readsSecret) continue;
      // A job's check name on the PR is its display `name`, which is what
      // required-checks.json records for these jobs.
      const label = job.name;
      if (label && required.has(label)) blocked.push(label);
    }
  }
  return [...new Set(blocked)].sort();
}

describe('fork-PR limitation is disclosed while it exists', () => {
  it('names at least one secret-gated required check, or has retired itself', () => {
    // Guard against a vacuous pass: if this list is empty because the detection
    // broke rather than because #843 landed, every assertion below is trivially
    // satisfied and the note could be deleted unnoticed.
    const blocked = secretGatedOnForkBlindTrigger();
    if (blocked.length === 0) {
      // #843 landed (or the gate stopped reading a secret). Nothing to disclose.
      expect(blocked).toEqual([]);
      return;
    }
    expect(blocked).toContain('No removed-symbol or proprietary leaks');
  });

  it('CONTRIBUTING.md exists and warns that fork PRs cannot pass', () => {
    const blocked = secretGatedOnForkBlindTrigger();
    if (blocked.length === 0) return;

    expect(
      existsSync(CONTRIBUTING),
      'a required check is unreachable from forks, so CONTRIBUTING.md must exist to say so',
    ).toBe(true);

    const text = readFileSync(CONTRIBUTING, 'utf-8');
    expect(text.toLowerCase()).toContain('fork');
    // The tracking issue, so a reader can find the status rather than guess.
    expect(text).toContain('#843');
    // Name the actual check, so the warning matches what CI will show them.
    for (const check of blocked) expect(text).toContain(check);
  });

  it('CONTRIBUTING.md points at AGENTS.md rather than restating it', () => {
    if (secretGatedOnForkBlindTrigger().length === 0) return;
    const text = readFileSync(CONTRIBUTING, 'utf-8');
    // AGENTS.md is the canonical knowledge map; duplicated conventions drift.
    expect(text).toContain('AGENTS.md');
  });
});
