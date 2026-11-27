/**
 * Evidence pack Markdown, the per-source evidence lists (#855). Output grows
 * with the window, so the cap is tested at a size that exceeds it.
 * Fixtures are synthetic.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPack } from '../src/analysis/evidence/pack.js';
import { renderMarkdown, writePack } from '../src/analysis/evidence/render.js';
import type {
  CatalogueRow,
  EvidenceItem,
  Scope,
  SourceReport,
} from '../src/analysis/evidence/types.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

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
    expect(md).toContain('skipped a &#124; b ## Forged heading');
    expect(md.split('\n')).not.toContain('## Forged heading');
  });
});

describe('writePack', () => {
  let out: string;

  beforeEach(() => {
    out = join(mkTmp(), 'packs');
  });

  afterEach(() => rmTmp(join(out, '..')));

  const packOf = (items: EvidenceItem[]) =>
    buildPack([history(items)], SCOPE, CATALOGUE);

  const emptyPack = () => {
    const absent: SourceReport = {
      ...history([]),
      state: 'absent',
      reason: 'nothing at test-results/reports/history-v2.jsonl',
    };
    return buildPack([absent], SCOPE, CATALOGUE);
  };

  it('writes the JSON and the Markdown, and reports both paths', () => {
    const pack = packOf([runItem(1)]);
    const done = writePack(out, pack);
    const json = readFileSync(join(out, 'evidence-pack.json'), 'utf-8');
    expect(done.exit).toBe(0);
    expect(JSON.parse(json)).toEqual(pack);
    expect(json.endsWith('}\n')).toBe(true);
    expect(readFileSync(join(out, 'evidence-pack.md'), 'utf-8')).toBe(
      renderMarkdown(pack),
    );
    expect(done.lines.slice(-2)).toEqual([
      `Wrote ${out}/evidence-pack.json`,
      `Wrote ${out}/evidence-pack.md`,
    ]);
  });

  it('prints one line per control with its item count, and no warning', () => {
    const done = writePack(out, packOf([runItem(1), runItem(2)]));
    expect(done.lines[0]).toBe('soc2-cc7.1  evidence: 2');
    expect(done.lines.join('\n')).not.toContain('Abstained');
    expect(done.lines.join('\n')).not.toContain('source history');
  });

  it('names each source that is not read, with its reason', () => {
    const done = writePack(out, emptyPack());
    expect(done.lines).toContain('soc2-cc7.1  NO EVIDENCE');
    expect(done.lines).toContain(
      'source history: absent (nothing at test-results/reports/history-v2.jsonl)',
    );
  });

  it('warns with the cause and the first step when no source produced an item (criterion 9)', () => {
    const done = writePack(out, emptyPack());
    const warning = done.lines.find((line) => line.includes('Abstained'));
    expect(done.exit).toBe(0);
    expect(warning).toContain('No source produced an item in the window');
    expect(warning).toContain('(history absent)');
    expect(warning).toContain('First step: record a run with');
    expect(done.lines.join('\n')).not.toContain('evidence: ');
    expect(readFileSync(join(out, 'evidence-pack.md'), 'utf-8')).toContain(
      'NO EVIDENCE',
    );
  });

  it('replaces the previous pack in the same directory (criterion 10)', () => {
    writePack(out, packOf([runItem(1)]));
    writePack(out, packOf([runItem(2)]));
    const json = readFileSync(join(out, 'evidence-pack.json'), 'utf-8');
    const md = readFileSync(join(out, 'evidence-pack.md'), 'utf-8');
    expect(json).toContain('"r2"');
    expect(json).not.toContain('"r1"');
    expect(md).not.toContain('`r1`');
  });

  it('exits 1 naming the directory and the errno when it cannot write', () => {
    const blocker = join(out, '..', 'blocker');
    writeFileSync(blocker, 'a file where the directory should go');
    const done = writePack(join(blocker, 'packs'), packOf([runItem(1)]));
    expect(done.exit).toBe(1);
    expect(done.lines).toHaveLength(1);
    expect(done.lines[0]).toContain(join(blocker, 'packs'));
    expect(done.lines[0]).toMatch(/ENOTDIR|EEXIST/);
  });
});
