/**
 * Prose that restates the required-check set must agree with the manifest
 * (#1122, #1123).
 *
 * `.github/required-checks.json` is primary for which checks block a merge
 * (ADR 0011), and `workflow-false-green.test.ts` holds the WORKFLOWS to it. No
 * test held the DOCS to it, so two copies drifted with no signal:
 *
 *  - #1123: the integration guide's "In one breath" list of merge-blocking
 *    workflows omitted `guardian.yml`, which produces the required `guardian`
 *    check. A reader working out what blocks a merge missed one.
 *  - #1122: the setup-harness skill told forks to put a `paths:` filter on
 *    `docs-lint.yml`, which produces three required checks. A required check
 *    behind a path filter never reports on a PR outside those paths, and the
 *    PR waits forever — the self-omitting false-green class (#542, #549).
 *
 * Both assertions read the manifest through `required-checks-testkit.ts`, so a
 * new required workflow reddens the guide until the guide names it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, requiredWorkflows } from './required-checks-testkit.js';

const GUIDE = join(
  REPO_ROOT,
  'docs',
  'guides',
  'harness-canary-integration.md',
);
const SETUP_SKILL = join(
  REPO_ROOT,
  'agents',
  'skills',
  'claude-code',
  'canary-setup-harness',
  'SKILL.md',
);

/** Workflow files named in the guide's "In one breath" merge-gate sentence. */
function guideMergeGateWorkflows(markdown: string): Set<string> {
  const start = markdown.indexOf('In one breath');
  const end = markdown.indexOf('must be green to merge', start);
  if (start < 0 || end < 0) return new Set();
  const sentence = markdown.slice(start, end);
  return new Set(
    [...sentence.matchAll(/`([\w.-]+\.ya?ml)`/g)].map((m) => m[1] ?? ''),
  );
}

/**
 * Split a skill body into its numbered steps (and heading-led sections), so a
 * `paths` mention is judged against the workflow the same step is about.
 */
function steps(markdown: string): string[] {
  return markdown.split(/\n(?=\d+\.\s|#{1,6}\s)/);
}

const PATHS_FILTER = /`paths:?`|\bpaths:|\bpaths?\s+filter/i;
const NEGATION = /\b(no|not|never|without|unfiltered|don't|do not|must not)\b/i;

/**
 * True when a step RECOMMENDS a path filter: a YAML fence carrying `paths:`, or
 * a sentence naming a paths filter with no negation in it. "Do not give it a
 * `paths:` filter" is the fix, not the bug, and must not fire.
 */
function recommendsPathsFilter(step: string): boolean {
  const fences = step.match(/```[\s\S]*?```/g) ?? [];
  if (fences.some((f) => /^\s*paths:/m.test(f))) return true;
  const prose = step.replace(/```[\s\S]*?```/g, ' ');
  return prose
    .split(/(?<=[.!?])\s+/)
    .some((s) => PATHS_FILTER.test(s) && !NEGATION.test(s));
}

/** `[step heading, workflow]` for each step recommending a filter on a required workflow. */
function filteredRequiredWorkflows(
  markdown: string,
  required: Set<string>,
): Array<[string, string]> {
  const hits: Array<[string, string]> = [];
  for (const step of steps(markdown)) {
    if (!recommendsPathsFilter(step)) continue;
    for (const wf of required) {
      if (step.includes(wf))
        hits.push([(step.split('\n')[0] ?? '').trim(), wf]);
    }
  }
  return hits;
}

describe('required-check prose agrees with .github/required-checks.json', () => {
  const required = requiredWorkflows();

  it('reads a non-empty required set (zero denominator is an abstention)', () => {
    expect(required.size).toBeGreaterThan(0);
  });

  describe('#1123 — the integration guide names every required workflow', () => {
    it('finds the merge-gate sentence and workflows in it', () => {
      const named = guideMergeGateWorkflows(readFileSync(GUIDE, 'utf-8'));
      expect(named.size).toBeGreaterThan(0);
    });

    it('lists exactly the manifest required workflows', () => {
      const named = guideMergeGateWorkflows(readFileSync(GUIDE, 'utf-8'));
      expect([...named].sort()).toEqual([...required].sort());
    });
  });

  describe('#1122 — the setup-harness skill never path-filters a required workflow', () => {
    it('the detector fires on a planted recommendation (not vacuous)', () => {
      const planted = [
        '4. **Confirm `docs-lint.yml` covers all doc paths.** The',
        "   workflow's `paths` filter should include:",
        '',
        '   - `docs/**`',
      ].join('\n');
      expect(filteredRequiredWorkflows(planted, required)).toEqual([
        [planted.split('\n')[0], 'docs-lint.yml'],
      ]);
      const yaml =
        '4. In `docs-lint.yml`:\n\n```yaml\non:\n  pull_request:\n    paths:\n      - docs/**\n```\n';
      expect(filteredRequiredWorkflows(yaml, required)).toHaveLength(1);
    });

    it('the detector stays quiet on a prohibition', () => {
      const prohibition =
        '4. **Run `docs-lint.yml` unfiltered.** Do not give it a `paths:` filter.';
      expect(filteredRequiredWorkflows(prohibition, required)).toEqual([]);
    });

    it('recommends no paths filter on any required workflow', () => {
      const skill = readFileSync(SETUP_SKILL, 'utf-8');
      expect(filteredRequiredWorkflows(skill, required)).toEqual([]);
    });
  });
});
