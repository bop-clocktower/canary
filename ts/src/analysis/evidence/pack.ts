/** Builds the evidence pack from source reports (#855). Pure given a catalogue. */

import { loadCatalogue } from './sources.js';
import type {
  CatalogueRow,
  EvidencePack,
  Scope,
  SourceReport,
} from './types.js';

export const DISCLAIMER =
  'This mapping is an aid, not an attestation. Canary cannot certify ' +
  'compliance. A listed item shows that a check ran and what it recorded; ' +
  'it does not show that a control is met.';

function withoutItems(source: SourceReport): Omit<SourceReport, 'items'> {
  const { items: _items, ...rest } = source;
  return rest;
}

export function buildPack(
  sources: SourceReport[],
  scope: Scope,
  catalogue: CatalogueRow[] = loadCatalogue(),
): EvidencePack {
  const controlsFor = (source: SourceReport['id']): string[] =>
    catalogue.filter((c) => c.sources.includes(source)).map((c) => c.id);
  // Newest first; source and id break ties, so the same files give the same order.
  const key = (i: SourceReport['items'][number]): string =>
    `${i.at} ${i.source} ${i.ref.id}`;
  const items = sources
    .flatMap((s) => s.items)
    .sort((a, b) => key(b).localeCompare(key(a)))
    .map((item) => ({ ...item, controls: controlsFor(item.source) }));
  // Every catalogue row is kept: dropping an empty one would hide the gap (D5).
  const controls = catalogue.map((row) => {
    const count = items.filter((i) => i.controls.includes(row.id)).length;
    const status = count > 0 ? ('evidence' as const) : ('no-evidence' as const);
    return { ...row, status, items: count };
  });
  return {
    schema: 'canary-evidence-pack/1',
    disclaimer: DISCLAIMER,
    generated_at: scope.at,
    window: { since: scope.since, until: scope.until },
    commit: scope.commit,
    sources: sources.map(withoutItems),
    controls,
    items,
  };
}
