import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The harness knowledge pipeline ingests ADRs from `docs/knowledge/decisions/`
 * and rejects a file **silently** when its frontmatter does not yield both
 * `number` and `title` — no error, no warning, the ADR simply never becomes a
 * graph node. A malformed ADR is therefore indistinguishable from an absent
 * one, which is the same false-green shape as a gate with a zero denominator.
 *
 * The rejection that motivated this test: prettier wrapped one ADR's long
 * `title:` value onto a continuation line. That is valid YAML, but harness
 * parses frontmatter line-by-line with `/^(\w+):\s*(.+)$/`, so a bare `title:`
 * matched nothing and the ADR vanished from the graph.
 *
 * This mirrors harness's parser exactly rather than using a real YAML parser.
 * Matching a stricter parser here would pass while the ingestor still refused
 * the file — the contract under test is what harness accepts, not what YAML
 * permits.
 */

const DECISIONS_DIR = join(
  __dirname,
  '..',
  '..',
  'docs',
  'knowledge',
  'decisions',
);

/** Byte-for-byte port of the harness decisions ingestor's frontmatter parser. */
function parseAsHarnessDoes(raw: string): Record<string, string> | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    frontmatter[kv[1]!] = kv[2]!.trim();
  }

  if (!frontmatter.number || !frontmatter.title) return null;
  return frontmatter;
}

const adrFiles = readdirSync(DECISIONS_DIR)
  .filter((f) => /^\d{4}-.*\.md$/.test(f))
  .sort();

describe('ADRs are ingestable by the harness knowledge pipeline', () => {
  it('finds ADR files to check (a zero denominator is an abstention)', () => {
    expect(adrFiles.length).toBeGreaterThan(0);
  });

  it.each(adrFiles)('%s yields both number and title', (file) => {
    const raw = readFileSync(join(DECISIONS_DIR, file), 'utf-8');
    const frontmatter = parseAsHarnessDoes(raw);

    expect(
      frontmatter,
      `${file} is rejected by the ingestor — it will be silently absent from ` +
        `the knowledge graph. Most likely its frontmatter 'title:' was wrapped ` +
        `onto a continuation line; keep each key and value on one physical line.`,
    ).not.toBeNull();
  });

  it.each(adrFiles)('%s declares a number matching its filename', (file) => {
    const frontmatter = parseAsHarnessDoes(
      readFileSync(join(DECISIONS_DIR, file), 'utf-8'),
    );
    expect(frontmatter).not.toBeNull();
    expect(Number(frontmatter!.number)).toBe(Number(file.slice(0, 4)));
  });

  it('keeps every ADR ingestable, so the graph count equals the file count', () => {
    const accepted = adrFiles.filter((f) =>
      parseAsHarnessDoes(readFileSync(join(DECISIONS_DIR, f), 'utf-8')),
    );
    expect(accepted).toHaveLength(adrFiles.length);
  });
});
