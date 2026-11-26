/**
 * `wiki-sync.yml` publishes `docs/wiki` to the public GitHub wiki (#1749).
 *
 * Three ways it drifted from that job, each pinned here:
 *
 * 1. It only ever ADDED pages. `cp docs/wiki/*.md wiki-repo/` never removes
 *    anything, so `TestTracker-Reporter.md` stayed live on the wiki long after
 *    a60d5b3e (#1187) deleted it from the repo. The wiki must be a mirror: the
 *    tracked pages are cleared before the copy, so a page deleted here is
 *    deleted there. Only `*.md` is cleared — `.git` and any non-page asset
 *    survive.
 *
 * 2. A failed clone was silenced (`2>/dev/null`) and fell through to
 *    `git init`, a fresh history with no pages but ours. With the mirror in
 *    place that path would try to publish a history unrelated to the real
 *    wiki. A clone failure has to fail the job, loudly, with the reason shown.
 *
 * 3. Two pushes to `main` in quick succession ran two syncs at once against
 *    the same wiki remote. A `concurrency:` group serializes them.
 *
 * Offline: parses the workflow with js-yaml and reads the run block as text.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'wiki-sync.yml');

interface Step {
  name?: string;
  run?: string;
}
interface Workflow {
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean } | string;
  jobs?: Record<string, { steps?: Step[] }>;
}

const workflow = loadYaml(readFileSync(WORKFLOW, 'utf-8')) as Workflow;

/** The one run block that talks to the wiki remote. */
function syncScript(): string {
  const steps = Object.values(workflow.jobs ?? {}).flatMap(
    (j) => j.steps ?? [],
  );
  const sync = steps.filter((s) => (s.run ?? '').includes('.wiki.git'));
  expect(sync, 'exactly one step pushes to the wiki remote').toHaveLength(1);
  return sync[0]?.run ?? '';
}

/** Non-comment shell lines, so prose in a comment cannot satisfy or trip a check. */
function codeLines(script: string): string[] {
  return script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

describe('wiki-sync.yml', () => {
  it('mirrors docs/wiki: clears the wiki pages before copying ours', () => {
    const lines = codeLines(syncScript());
    const clear = lines.findIndex((l) =>
      /^rm -f wiki-repo\/\*\.md(\s|$)/.test(l),
    );
    const copy = lines.findIndex((l) =>
      /^cp docs\/wiki\/\*\.md wiki-repo\/?(\s|$)/.test(l),
    );
    expect(clear, 'rm -f wiki-repo/*.md is present').toBeGreaterThanOrEqual(0);
    expect(copy, 'cp docs/wiki/*.md wiki-repo/ is present').toBeGreaterThan(
      clear,
    );
  });

  it('never clears anything but pages (keeps .git and non-md assets)', () => {
    const removals = codeLines(syncScript()).filter((l) => /^rm\s/.test(l));
    for (const r of removals) {
      expect(r).toMatch(/^rm -f wiki-repo\/\*\.md(\s|$)/);
    }
  });

  it('stages deletions, so a page removed here is removed there', () => {
    const lines = codeLines(syncScript());
    expect(lines.some((l) => /^git add (-A|--all)(\s|$)/.test(l))).toBe(true);
  });

  it('fails loudly on a clone failure: no silenced clone, no git init fallback', () => {
    const lines = codeLines(syncScript());
    const clone = lines.filter((l) => l.includes('git clone'));
    expect(clone, 'the wiki is cloned').not.toHaveLength(0);
    for (const l of clone) {
      expect(l, 'clone stderr is not discarded').not.toMatch(
        /2>\s*\/dev\/null/,
      );
      expect(l, 'clone failure is not swallowed').not.toMatch(/\|\|\s*true/);
    }
    expect(
      lines.some((l) => /\bgit init\b/.test(l)),
      'no fresh-history fallback',
    ).toBe(false);
    expect(
      lines.some((l) => /\bgit push\b.*(--force|\s-f\b)/.test(l)),
      'never force-pushes the wiki',
    ).toBe(false);
  });

  it('serializes runs with a concurrency group', () => {
    const c = workflow.concurrency;
    const group = typeof c === 'string' ? c : c?.group;
    expect(group).toMatch(/wiki-sync/);
    // A cancelled sync is harmless (the next one mirrors the whole tree), but
    // queueing keeps every merge's sync visible in the run list.
    if (typeof c !== 'string') {
      expect(c?.['cancel-in-progress'] ?? false).toBe(false);
    }
  });
});
