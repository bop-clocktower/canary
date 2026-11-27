/**
 * Evidence pack assembly (#855). The first rule pinned here is the one an
 * auditor is most exposed to: a control with no evidence is still listed.
 * Fixtures are synthetic.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DISCLAIMER, buildPack } from '../src/analysis/evidence/pack.js';
import { renderMarkdown } from '../src/analysis/evidence/render.js';
import type {
  CatalogueRow,
  EvidenceItem,
  Scope,
  SourceId,
  SourceReport,
} from '../src/analysis/evidence/types.js';

const CATALOGUE = (
  JSON.parse(
    readFileSync(
      new URL('../src/data/evidence/controls.json', import.meta.url),
      'utf-8',
    ),
  ) as { controls: CatalogueRow[] }
).controls;

const SOURCE_IDS: SourceId[] = ['batwoman', 'katana', 'history', 'ci-ready'];

const SCOPE: Scope = {
  since: '2026-01-01T00:00:00.000Z',
  until: '2026-06-15T12:00:00.000Z',
  root: '/repo',
  out: '/repo/out',
  at: '2026-06-15T12:00:00.000Z',
  commit: 'a'.repeat(40),
};

function absent(id: SourceId): SourceReport {
  return {
    id,
    path: `.canary/${id}`,
    state: 'absent',
    reason: `nothing at .canary/${id}`,
    read: 0,
    inWindow: 0,
    undated: 0,
    items: [],
  };
}

function withItems(id: SourceId, items: EvidenceItem[]): SourceReport {
  return {
    id,
    path: `.canary/${id}`,
    state: 'read',
    read: items.length,
    inWindow: items.length,
    undated: 0,
    items,
  };
}

function item(source: SourceId, at: string, id: string): EvidenceItem {
  return { source, at, summary: `${source} ${id}`, ref: { kind: 'run', id } };
}

/** Every key at any depth, so a graded field cannot hide in a nested object. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
}

describe('evidence pack with every source empty (criterion 1)', () => {
  const pack = buildPack(SOURCE_IDS.map(absent), SCOPE, CATALOGUE);

  it('lists all six controls as no-evidence in the JSON', () => {
    expect(CATALOGUE).toHaveLength(6);
    expect(pack.controls.map((c) => c.id)).toEqual(CATALOGUE.map((c) => c.id));
    for (const control of pack.controls) {
      expect(control).toMatchObject({ status: 'no-evidence', items: 0 });
    }
  });

  it('prints NO EVIDENCE for all six controls in the Markdown', () => {
    const md = renderMarkdown(pack);
    for (const control of CATALOGUE) {
      const row = md.split('\n').find((l) => l.startsWith(`| ${control.id} |`));
      expect(row, control.id).toContain('NO EVIDENCE');
    }
  });

  it('names each mapped source and its state beside an empty control', () => {
    const md = renderMarkdown(pack);
    const row = md.split('\n').find((l) => l.startsWith('| soc2-cc8.1 |'));
    expect(row).toContain('history: absent (0)');
    expect(row).toContain('katana: absent (0)');
    expect(row).toContain('ci-ready: absent (0)');
  });

  it('lists every source with its state and reason', () => {
    expect(pack.sources.map((s) => s.id)).toEqual(SOURCE_IDS);
    const md = renderMarkdown(pack);
    for (const id of SOURCE_IDS) {
      expect(md).toContain(`| ${id} (.canary/${id}) | absent | 0 | 0 |`);
      expect(md).toContain(`nothing at .canary/${id}`);
    }
  });
});

describe('evidence pack with items', () => {
  const sources = [
    absent('batwoman'),
    withItems('katana', [item('katana', '2026-03-01T00:00:00.000Z', 'k1')]),
    withItems('history', [
      item('history', '2026-02-01T00:00:00.000Z', 'r1'),
      item('history', '2026-04-01T00:00:00.000Z', 'r2'),
    ]),
    absent('ci-ready'),
  ];
  const pack = buildPack(sources, SCOPE, CATALOGUE);

  it('maps each item to the controls its source supports', () => {
    const katana = pack.items.find((i) => i.source === 'katana');
    expect(katana?.controls).toEqual(['soc2-cc8.1']);
    const history = pack.items.find((i) => i.ref.id === 'r1');
    expect(history?.controls).toEqual([
      'nist-800-40r4-2.3.4',
      'iso-27001-2022-a.8.8',
      'soc2-cc7.1',
      'soc2-cc8.1',
    ]);
  });

  it('counts items per control and keeps the empty ones', () => {
    const byId = new Map(pack.controls.map((c) => [c.id, c]));
    expect(byId.get('soc2-cc8.1')).toMatchObject({
      status: 'evidence',
      items: 3,
    });
    expect(byId.get('soc2-cc7.1')).toMatchObject({
      status: 'evidence',
      items: 2,
    });
    expect(byId.get('cis-v8-7')).toMatchObject({
      status: 'no-evidence',
      items: 0,
    });
    expect(renderMarkdown(pack)).toContain('| 3 item(s) |');
  });

  it('orders items newest first, whatever order the sources came in', () => {
    const reversed = buildPack([...sources].reverse(), SCOPE, CATALOGUE);
    const ids = ['r2', 'k1', 'r1'];
    expect(pack.items.map((i) => i.ref.id)).toEqual(ids);
    expect(reversed.items.map((i) => i.ref.id)).toEqual(ids);
  });

  it('carries the disclaimer in both formats (criterion 5)', () => {
    expect(DISCLAIMER).toContain('an aid, not an attestation');
    expect(pack.disclaimer).toBe(DISCLAIMER);
    expect(renderMarkdown(pack)).toContain(`> ${DISCLAIMER}`);
  });

  it('stamps the window, export time and commit from the scope', () => {
    expect(pack).toMatchObject({
      schema: 'canary-evidence-pack/1',
      generated_at: SCOPE.at,
      window: { since: SCOPE.since, until: SCOPE.until },
      commit: SCOPE.commit,
    });
    expect(Object.keys(pack.sources[0] ?? {})).not.toContain('items');
  });

  it('has no graded field anywhere in the pack (criterion 11)', () => {
    const keys = keysOf(pack);
    expect(keys.length).toBeGreaterThan(20);
    for (const graded of ['passed', 'score', 'compliant']) {
      expect(keys).not.toContain(graded);
    }
  });
});
