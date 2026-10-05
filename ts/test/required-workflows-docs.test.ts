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

  describe('#1143 — the setup-harness baseline is a classified subset of the manifest', () => {
    const skill = readFileSync(SETUP_SKILL, 'utf-8');
    const lists = baselineLists(skill);

    it('the parsers fire on a planted list and count (not vacuous)', () => {
      const planted = [
        '2. **Baseline workflows.** Each should exist:',
        '',
        '   - `harness.yml` — core',
        '   - `guardian.yml` — the guardian',
        '',
        '   **Conditional add-ons.**',
        '',
        '   - `leak-gate.yml` — only when the repo is public',
        '',
        '3. **Next step.** `docs-lint.yml` is not a list entry here.',
      ].join('\n');
      expect(baselineLists(planted)).toEqual({
        baseline: ['harness.yml', 'guardian.yml'],
        conditional: [['leak-gate.yml', 'only when the repo is public']],
      });
      expect(
        workflowCounts(
          'wires up the five required CI workflows; all six gates pass',
        ),
      ).toEqual(['five', 'six']);
    });

    it('finds a non-empty baseline (zero denominator is an abstention)', () => {
      expect(lists.baseline.length).toBeGreaterThan(0);
    });

    it('every baseline workflow is required by the manifest', () => {
      expect(lists.baseline.filter((wf) => !required.has(wf))).toEqual([]);
    });

    it('every conditional add-on is required here, not in the baseline, and states its condition', () => {
      expect(lists.conditional.length).toBeGreaterThan(0);
      for (const [wf, text] of lists.conditional) {
        expect(required.has(wf), wf).toBe(true);
        expect(lists.baseline.includes(wf), wf).toBe(false);
        expect(text, wf).toMatch(CONDITION);
      }
    });

    it('classifies every manifest-required workflow as baseline or conditional', () => {
      const classified = new Set([
        ...lists.baseline,
        ...lists.conditional.map(([wf]) => wf),
      ]);
      expect([...required].filter((wf) => !classified.has(wf))).toEqual([]);
    });

    it('every spelled-out workflow count equals the baseline length', () => {
      const counts = workflowCounts(skill);
      // Frontmatter, Success Criteria and the fresh-fork example all state it.
      expect(counts.length).toBeGreaterThanOrEqual(3);
      const expected = NUMBER_WORDS[lists.baseline.length];
      expect(counts.map((c) => c.toLowerCase())).toEqual(
        counts.map(() => expected),
      );
    });
  });
});

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
const COUNT = new RegExp(
  `\\b(${NUMBER_WORDS.join('|')})\\s+(?:(?:baseline|required)\\s+)?(?:CI\\s+)?(?:workflows?|workflow files|gates)\\b`,
  'gi',
);
const CONDITION = /\b(when|only|if|unless)\b/i;
const LIST_ENTRY = /^\s*- `([\w.-]+\.ya?ml)`\s+—\s+(.+)$/;

/** Every spelled-out number that counts workflows or gates in `text`. */
function workflowCounts(text: string): string[] {
  return [...text.matchAll(COUNT)].map((m) => m[1] ?? '');
}

/**
 * The setup skill's Phase 3 step 2: the baseline bullet list, then the
 * workflows under its "Conditional add-ons" heading with their stated text.
 */
function baselineLists(markdown: string): {
  baseline: string[];
  conditional: Array<[string, string]>;
} {
  const start = markdown.search(/^\d+\.\s+\*\*Baseline workflows/m);
  if (start < 0) return { baseline: [], conditional: [] };
  const rest = markdown.slice(start);
  const next = rest.slice(1).search(/\n\d+\.\s/);
  const step = next < 0 ? rest : rest.slice(0, next + 1);
  const split = step.indexOf('Conditional add-ons');
  const entries = (part: string): Array<[string, string]> =>
    part
      .split('\n')
      .map((line) => LIST_ENTRY.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1] ?? '', m[2] ?? '']);
  return {
    baseline: entries(split < 0 ? step : step.slice(0, split)).map(
      ([wf]) => wf,
    ),
    conditional: split < 0 ? [] : entries(step.slice(split)),
  };
}
