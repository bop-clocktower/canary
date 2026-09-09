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
 * ## The former caveat is RETIRED as of CLI 12.4.0 (#788)
 *
 * This header used to carry a standing warning that `harness cleanup` — the
 * command the ratchet and CI actually run — ignored this key entirely,
 * hard-coding `docPaths: [join(docsDir, '**\/*.md')]`, so the list below was
 * correct and inert. That is fixed upstream. The key is now honoured on the
 * CI path, and the widening #693 asked for is live rather than declared.
 *
 * Verified by paired planted probe on `main` at `6926e1a` under a pinned CLI
 * 12.4.0, in a detached worktree. An identical dead link, appended one file at
 * a time, against a clean tree that reports drift 0:
 *
 * | probe | drift findings |
 * | --- | --- |
 * | `docs/CANARY_STATE.md` (control, always covered) | 1 |
 * | `AGENTS.md` | 1 |
 * | `agents/skills/claude-code/canary-katana/SKILL.md` | 1 |
 * | `STRATEGY.md` | 1 |
 * | `AGENTS.md`, with `AGENTS.md` REMOVED from `docPaths` | **0** |
 *
 * The last row is the one that carries it. Three surfaces firing could just as
 * easily mean the CLI widened its hard-coded default, which is a different
 * fact with the same appearance — the same trap `$driftfix2_evidence` records
 * for the entropy count. Deleting one entry and watching its planted link stop
 * being reported is what proves the CONFIG is what widened the denominator.
 *
 * So #693's last open item is answerable: the widening added **0** findings.
 * A measured floor, not an assumed one, and a real zero rather than an
 * abstention — the planted positives above are what separate the two.
 *
 * `scripts/check_doc_links.mjs` remains the second, independent instrument
 * over a larger denominator (254 Markdown files, no path allowlist,
 * strict-at-zero in `doc-links.test.ts`, exit-3 abstention on an empty walk).
 * Keep it. It does not move when the harness CLI floats, and the CLI has now
 * moved this check's behaviour five releases running.
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
