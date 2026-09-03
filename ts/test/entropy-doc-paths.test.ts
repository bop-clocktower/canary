/**
 * `entropy.drift.docPaths` is an allowlist, so it needs a test (#693).
 *
 * Left unset, the harness entropy analyzer defaults to
 * `['docs/**\/*.md', 'README.md', '**\/README.md']`. That put `AGENTS.md`,
 * `CHANGELOG.md`, `CLAUDE.md`, `STRATEGY.md`, `DEPLOY_CHECKLIST.md` and every
 * `SKILL.md` OUTSIDE the drift gate's denominator — three classes of surface
 * that describe how to operate this repo, none of them looked at by the gate
 * that exists to keep documentation honest. Both #691 defects and the
 * `AGENTS.md` half in #690 rotted undetected until a human hand-found them
 * during the v7.0.0 release audit.
 *
 * The list is now widened, and this file is why it can be trusted to stay
 * widened. An allowlist's denominator shrinks SILENTLY: every time someone
 * adds a doc surface and forgets to enumerate it, the gate quietly stops
 * looking at it and reports the same green as before. That is the false-green
 * shape ADR 0012 and the entropy ratchet exist to refuse, so the enumeration
 * is asserted against what is actually on disk rather than against a second
 * copy of itself.
 *
 * Two invariants, and the second is the one that matters:
 *
 * 1. The list is non-empty. A zero denominator is an ABSTENTION, not a pass —
 *    a drift check with no documents to read reports zero findings and looks
 *    identical to a clean repo.
 *
 * 2. Every doc surface on disk matches at least one entry. Adding
 *    `docs/runbooks/` or a new skill fails HERE, at the desk, rather than
 *    joining an invisible unscanned pile.
 *
 * KNOWN LIMITATION, stated so nobody reads a green here as more than it is.
 * `harness cleanup` — the command the entropy ratchet and CI actually run —
 * does NOT honour this config key. It hard-codes
 * `docPaths: [join(docsDir, '**\/*.md')]` when constructing the analyzer, so
 * `entropy.drift.docPaths` is read only by the MCP `detect_entropy` path.
 * Verified with a paired planted probe at CLI 12.2.0: an identical dead link
 * appended to `docs/CANARY_STATE.md` is reported, and appended to `AGENTS.md`
 * is not. Filed upstream. This file therefore pins the DECLARED denominator,
 * which is correct and takes effect the moment the CLI honours it; the
 * repo-side instrument that covers the wide surface TODAY is
 * `scripts/check_doc_links.mjs` (249 Markdown files, no path allowlist,
 * strict-at-zero in `doc-links.test.ts`, exit-3 abstention on an empty walk).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Trees that hold no authored documentation surface. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  '.venv',
  'venv',
  '__pycache__',
  'test-results',
  'playwright-report',
]);

const config = JSON.parse(
  readFileSync(join(REPO_ROOT, 'harness.config.json'), 'utf-8'),
) as { entropy?: { drift?: { docPaths?: string[] } } };

const docPaths = config.entropy?.drift?.docPaths ?? [];

/**
 * Compile one docPaths glob to a regex over a repo-relative POSIX path.
 *
 * Only the three constructs the list actually uses are supported, and
 * deliberately so: `**` (any number of path segments), `*` (any run of
 * characters within one segment), and literals. A matcher that quietly
 * accepted a construct it did not implement would report a surface as covered
 * when the analyzer does not cover it — the exact failure this file exists to
 * catch, reintroduced inside the catcher.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const rest = glob.slice(i);
    if (rest.startsWith('**/')) {
      // Zero or more leading segments, so `**/README.md` matches a root README.
      out += '(?:[^/]+/)*';
      i += 2;
    } else if (rest.startsWith('**')) {
      out += '.*';
      i += 1;
    } else if (glob[i] === '*') {
      out += '[^/]*';
    } else {
      out += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

const matchers = docPaths.map(globToRegExp);

/** True when the repo-relative path is inside the declared denominator. */
function isCovered(relPath: string): boolean {
  return matchers.some((re) => re.test(relPath));
}

/** Every Markdown file under `dir`, repo-relative and POSIX-separated. */
function walkMarkdown(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) found.push(...walkMarkdown(abs));
    else if (entry.endsWith('.md'))
      found.push(relative(REPO_ROOT, abs).split(sep).join('/'));
  }
  return found;
}

const allMarkdown = walkMarkdown(REPO_ROOT);

/**
 * The surfaces this repo commits to keeping in the drift denominator.
 *
 * Not "every Markdown file": issue templates, agent definitions and slash
 * command bodies are generated or template text, and enrolling them is a
 * separate decision with its own noise budget. These four are the ones a
 * reader operates the repo from.
 */
const SURFACES: Array<[label: string, predicate: (p: string) => boolean]> = [
  ['root-level Markdown', (p) => !p.includes('/')],
  ['docs/', (p) => p.startsWith('docs/')],
  ['README.md, anywhere', (p) => p.endsWith('README.md')],
  ['SKILL.md, anywhere', (p) => p.endsWith('SKILL.md')],
];

describe('#693 — entropy.drift.docPaths covers the operating surfaces', () => {
  it('declares a non-empty list (a zero denominator is an abstention)', () => {
    expect(docPaths.length).toBeGreaterThan(0);
  });

  it('walks a non-empty corpus (an empty walk would pass every assertion)', () => {
    expect(allMarkdown.length).toBeGreaterThan(100);
  });

  it.each(SURFACES.map(([label]) => [label]))(
    '%s is a non-empty category',
    (label) => {
      const predicate = SURFACES.find(([l]) => l === label)![1];
      expect(allMarkdown.filter(predicate).length).toBeGreaterThan(0);
    },
  );

  it.each(SURFACES.map(([label]) => [label]))(
    'every %s file matches an entry in docPaths',
    (label) => {
      const predicate = SURFACES.find(([l]) => l === label)![1];
      const uncovered = allMarkdown
        .filter(predicate)
        .filter((p) => !isCovered(p));
      expect(
        uncovered,
        `Not in entropy.drift.docPaths — the drift gate will never read these. ` +
          `Add a glob to harness.config.json rather than deleting them from this test.`,
      ).toEqual([]);
    },
  );

  it('names the three surfaces #693 was filed about, so a silent drop fails', () => {
    // Belt and braces over the walk above: if a future refactor narrows
    // SURFACES, these three still have to be covered by name.
    expect(isCovered('AGENTS.md')).toBe(true);
    expect(isCovered('CHANGELOG.md')).toBe(true);
    expect(isCovered('agents/skills/claude-code/canary-savant/SKILL.md')).toBe(
      true,
    );
  });

  it('matches only within a segment for a single star', () => {
    // Pins the matcher itself. `docs/**/*.md` must not match `README.md`, or
    // every assertion above passes for the wrong reason.
    expect(globToRegExp('docs/**/*.md').test('README.md')).toBe(false);
    expect(globToRegExp('docs/**/*.md').test('docs/a/b/c.md')).toBe(true);
    expect(globToRegExp('**/README.md').test('README.md')).toBe(true);
    expect(globToRegExp('AGENTS.md').test('docs/AGENTS.md')).toBe(false);
  });
});
