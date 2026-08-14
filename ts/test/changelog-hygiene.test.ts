/**
 * Structural hygiene checks on `CHANGELOG.md` (#725).
 *
 * A verbatim duplicate entry survived every existing gate: markdownlint has
 * `MD024` disabled at the top of the file (release sections legitimately repeat
 * `### Fixed`), prettier reformats but never deduplicates, and the release
 * audit compares the changelog against merged PRs — a check both copies pass,
 * because both have a real PR behind them. Nothing in the repo was looking at
 * the entries themselves.
 *
 * The check is deliberately narrow: identical bullet *headlines* inside a
 * single release section. Across sections a repeat can be legitimate (the same
 * fix re-landing in a later release), so the scope is the one place a repeat
 * is always a mistake.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** One release section: its `## …` heading and every top-level bullet in it. */
interface Section {
  heading: string;
  bullets: string[];
}

/**
 * Split the changelog into release sections, keeping each bullet's first line.
 *
 * The first line is the headline — the bolded claim — which is what a duplicate
 * repeats. Comparing whole bullets would miss a near-copy and comparing bodies
 * would false-positive on shared boilerplate.
 */
function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), bullets: [] };
      sections.push(current);
    } else if (current && line.startsWith('- ')) {
      current.bullets.push(line.slice(2).trim());
    }
  }
  return sections;
}

/** Bullet headlines that appear more than once in the same section. */
function duplicateBullets(section: Section): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const bullet of section.bullets) {
    if (seen.has(bullet)) dupes.add(bullet);
    seen.add(bullet);
  }
  return [...dupes];
}

describe('CHANGELOG.md has no duplicated entries (#725)', () => {
  const sections = parseSections(
    readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8'),
  );

  it('parses at least one release section with entries', () => {
    // A zero denominator here would make every assertion below vacuously true.
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.some((s) => s.bullets.length > 0)).toBe(true);
  });

  it('repeats no bullet headline within a release section', () => {
    const offenders = sections
      .filter((s) => duplicateBullets(s).length > 0)
      .map((s) => `${s.heading}: ${duplicateBullets(s).join(' | ')}`);
    expect(offenders).toEqual([]);
  });
});
