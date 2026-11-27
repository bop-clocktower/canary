/**
 * Evidence pack Markdown, the per-source evidence lists (#855). Output grows
 * with the window, so the cap is tested at a size that exceeds it.
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest';

import { buildPack } from '../src/analysis/evidence/pack.js';
import { renderMarkdown } from '../src/analysis/evidence/render.js';
import type {
  CatalogueRow,
  EvidenceItem,
  Scope,
  SourceReport,
} from '../src/analysis/evidence/types.js';

const CATALOGUE: CatalogueRow[] = [
  {
    id: 'soc2-cc7.1',
    framework: 'SOC 2',
    reference: 'CC7.1, detection and monitoring',
    supports: 'Test runs ran',
    sources: ['history'],
  },
];

const SCOPE: Scope = {
  since: '2026-01-01T00:00:00.000Z',
  until: '2026-06-15T12:00:00.000Z',
  root: '/repo',
  out: '/repo/out',
  at: '2026-06-15T12:00:00.000Z',
  commit: null,
};

const START = Date.parse('2026-02-01T00:00:00.000Z');

/** Run `n`, one minute after run `n - 1`, so a higher number is newer. */
function runItem(n: number): EvidenceItem {
  return {
    source: 'history',
    at: new Date(START + n * 60_000).toISOString(),
    summary: `run r${n} (api): 3 passed, 0 failed, 0 flaky of 3`,
    ref: { kind: 'run', id: `r${n}`, commit: 'a'.repeat(40) },
  };
}

function history(items: EvidenceItem[]): SourceReport {
  return {
    id: 'history',
    path: 'test-results/reports/history-v2.jsonl',
    state: 'read',
    read: items.length,
    inWindow: items.length,
    undated: 0,
    items,
  };
}

function render(items: EvidenceItem[]): string {
  return renderMarkdown(buildPack([history(items)], SCOPE, CATALOGUE));
}

const itemLines = (md: string): string[] =>
  md.split('\n').filter((line) => line.startsWith('- 2026-02-'));

describe('evidence by source', () => {
  it('lists 25 of 500 runs, newest first, and says 475 more are in the JSON (criterion 8)', () => {
    const items = Array.from({ length: 500 }, (_, n) => runItem(n));
    const pack = buildPack([history(items)], SCOPE, CATALOGUE);
    const lines = itemLines(renderMarkdown(pack));
    expect(pack.items).toHaveLength(500);
    expect(lines).toHaveLength(25);
    expect(lines[0]).toContain('`r499`');
    expect(lines[24]).toContain('`r475`');
    expect(renderMarkdown(pack)).toContain(
      '475 more item(s) are in evidence-pack.json.',
    );
  });

  it('lists exactly 25 items without a remainder line', () => {
    const md = render(Array.from({ length: 25 }, (_, n) => runItem(n)));
    expect(itemLines(md)).toHaveLength(25);
    expect(md).not.toContain('more item(s)');
  });

  it('says so when a source has no item in the window', () => {
    const md = render([]);
    expect(md).toContain('### history\n\nNo items in the window.');
    expect(md).not.toContain('more item(s)');
  });

  it('prints the time, summary, link kind, id and commit of an item', () => {
    const [line] = itemLines(render([runItem(1)]));
    expect(line).toBe(
      '- 2026-02-01T00:01:00.000Z: run r1 (api): 3 passed, 0 failed, 0 flaky of 3 ' +
        `(run \`r1\`, commit \`${'a'.repeat(40)}\`)`,
    );
  });

  it('adds a commit link only when the item carries a URL', () => {
    const url = `https://github.com/acme/widgets/commit/${'a'.repeat(40)}`;
    const linked = { ...runItem(1), ref: { ...runItem(1).ref, url } };
    expect(itemLines(render([linked]))[0]).toContain(`([commit](${url}))`);
    expect(render([runItem(1)])).not.toContain('[commit]');
  });

  it('keeps hostile source text on one line and out of table syntax', () => {
    const hostile = {
      ...runItem(1),
      summary: 'skipped a | b\n## Forged heading',
    };
    const md = render([hostile]);
    expect(md).toContain('skipped a \\| b ## Forged heading');
    expect(md.split('\n')).not.toContain('## Forged heading');
  });
});
