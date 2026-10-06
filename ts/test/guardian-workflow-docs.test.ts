/**
 * Prose that tells an adopter how to wire up `guardian.yml` must agree with the
 * workflow file itself (#1160).
 *
 * The pr-guardian guide said the stock `.github/workflows/guardian.yml`
 * "installs canary". It does not: it is canary's self-hosted version — it
 * builds canary from `ts/`, runs canary's own suite for an lcov, looks up a
 * `ts-coverage-lcov-<sha>` artifact only canary's own workflows upload, and
 * calls `node ts/bin/canary.js`. Copied into another repo it fails at the
 * first build step. The setup-harness skill got the adaptation note in #1159;
 * the guide kept the old wording, and no test read the two side by side.
 *
 * Each requirement below is derived from a marker in the workflow file, not
 * from a fixed string list: when the workflow stops building from `ts/` the
 * self-hosted note stops being required, and when it grows a new canary-only
 * dependency the matching rule starts firing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './required-checks-testkit.js';

const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'guardian.yml');
const GUIDE = join(REPO_ROOT, 'docs', 'guides', 'pr-guardian.md');
const SETUP_SKILL = join(
  REPO_ROOT,
  'agents',
  'skills',
  'claude-code',
  'canary-setup-harness',
  'SKILL.md',
);

type Rule = {
  /** What the workflow does that a non-canary repo cannot. */
  marker: RegExp;
  /** What the doc must say about it. */
  says: RegExp;
  why: string;
};

/** Self-hosted traits of the workflow, each paired with the adopter guidance it demands. */
const RULES: Rule[] = [
  {
    marker: /npm --prefix ts\b/,
    says: /self-hosted/i,
    why: 'builds canary from ts/ — the doc must call the stock file self-hosted',
  },
  {
    marker: /npm --prefix ts\b/,
    says: /`ts\/`/,
    why: 'builds canary from ts/ — the doc must say so',
  },
  {
    marker: /node ts\/bin\/canary\.js/,
    says: /canary-test-cli/,
    why: 'runs the in-tree CLI — the doc must name the published package to install instead',
  },
  {
    marker: /--coverage ts\/coverage\/lcov\.info/,
    says: /`--coverage`/,
    why: "reads canary's own lcov — the doc must tell adopters to point --coverage at theirs",
  },
  {
    marker: /ts-coverage-lcov-/,
    says: /ts-coverage-lcov/,
    why: 'looks up a canary-only base-coverage artifact — the doc must name it',
  },
  {
    marker: /^ {2}mutation:/m,
    says: /`mutation`/,
    why: 'has a mutation job that builds ts/ — the doc must say to drop it',
  },
];

/** A claim that the stock workflow installs canary, which a self-hosted file contradicts. */
const INSTALLS_CLAIM = /stock workflow[\s\S]{0,80}?\binstalls canary\b/i;

/** The `### PR check` section of the guide. */
function guideSection(markdown: string): string {
  const start = markdown.indexOf('### PR check');
  if (start < 0) return '';
  const end = markdown.indexOf('\n### ', start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
}

/** The setup skill's "Wire up `guardian.yml`" step. */
function skillStep(markdown: string): string {
  const start = markdown.search(/^\d+\.\s+\*\*Wire up `guardian\.yml`/m);
  if (start < 0) return '';
  const rest = markdown.slice(start);
  const next = rest.slice(1).search(/\n\d+\.\s/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The reasons a doc section disagrees with the workflow it describes. */
function disagreements(workflow: string, section: string): string[] {
  const out: string[] = [];
  const selfHosted = /npm --prefix ts\b/.test(workflow);
  if (selfHosted && INSTALLS_CLAIM.test(section)) {
    out.push('claims the stock workflow installs canary; it builds from ts/');
  }
  for (const rule of RULES) {
    if (rule.marker.test(workflow) && !rule.says.test(section)) {
      out.push(rule.why);
    }
  }
  return out;
}

describe('#1160 — guardian.yml adoption prose agrees with the workflow file', () => {
  const workflow = readFileSync(WORKFLOW, 'utf-8');

  it('the workflow carries at least one self-hosted marker (zero denominator is an abstention)', () => {
    expect(RULES.filter((r) => r.marker.test(workflow)).length).toBeGreaterThan(
      0,
    );
  });

  it('the checker fires on the pre-#1160 guide wording (not vacuous)', () => {
    const old = [
      '### PR check',
      '',
      'Set `canary.guardian.pr.enabled` to `true`. The stock workflow',
      '(`.github/workflows/guardian.yml`) installs canary and runs',
      '`canary guardian pr-check --post-comment` (Tier 0).',
    ].join('\n');
    const found = disagreements(workflow, guideSection(old));
    expect(found).toContain(
      'claims the stock workflow installs canary; it builds from ts/',
    );
    expect(found.length).toBeGreaterThan(1);
  });

  it('the checker is bound to the workflow: a published-CLI workflow requires no self-hosted note', () => {
    const adopter =
      'jobs:\n  guardian:\n    steps:\n      - run: npm i -g canary-test-cli\n      - run: canary guardian pr-check --post-comment\n';
    expect(
      disagreements(adopter, 'The stock workflow installs canary.'),
    ).toEqual([]);
  });

  it('the guide PR check section agrees with guardian.yml', () => {
    const section = guideSection(readFileSync(GUIDE, 'utf-8'));
    expect(section).not.toBe('');
    expect(disagreements(workflow, section)).toEqual([]);
  });

  it('the setup-harness wire-up step agrees with guardian.yml', () => {
    const step = skillStep(readFileSync(SETUP_SKILL, 'utf-8'));
    expect(step).not.toBe('');
    expect(disagreements(workflow, step)).toEqual([]);
  });
});
