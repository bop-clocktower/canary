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

/** One release section: its `## …` heading, its `### …` subsections, and every top-level bullet in it. */
interface Section {
  heading: string;
  subsections: string[];
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
      current = { heading: line.slice(3).trim(), subsections: [], bullets: [] };
      sections.push(current);
    } else if (current && line.startsWith('### ')) {
      current.subsections.push(line.slice(4).trim());
    } else if (current && line.startsWith('- ')) {
      current.bullets.push(line.slice(2).trim());
    }
  }
  return sections;
}

/** Values that appear more than once in the given list. */
function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
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
      .filter((s) => duplicates(s.bullets).length > 0)
      .map((s) => `${s.heading}: ${duplicates(s.bullets).join(' | ')}`);
    expect(offenders).toEqual([]);
  });

  it('parses subsection headings in at least one release section', () => {
    // Same zero-denominator guard as above: a parser that silently stopped
    // collecting `###` lines would make the assertion below vacuously true.
    expect(sections.some((s) => s.subsections.length > 0)).toBe(true);
  });

  it('declares each change-type heading at most once per release section', () => {
    // `MD024` is disabled file-wide because `### Fixed` legitimately recurs
    // *across* releases. Within one release it never should: two `### Fixed`
    // blocks under one version render as disconnected lists and let a later
    // entry contradict an earlier one unnoticed — which is exactly how the
    // stale `schema_version` claim survived the 7.1.0 window.
    const offenders = sections
      .filter((s) => duplicates(s.subsections).length > 0)
      .map((s) => `${s.heading}: ${duplicates(s.subsections).join(' | ')}`);
    expect(offenders).toEqual([]);
  });
});
