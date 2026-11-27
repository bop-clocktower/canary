/** Builds the evidence pack (#855). `buildPack` is pure given a catalogue; `exportPack` reads the sources and writes the files. */

import type { CiReadyReport } from '../../core/ci-ready.js';
import { plain, writePack } from './render.js';
import {
  loadCatalogue,
  noItems,
  oneItem,
  readBatwoman,
  readHistory,
  readLedger,
  typo,
} from './sources.js';
import type {
  CatalogueRow,
  EvidencePack,
  Outcome,
  Scope,
  SourceReport,
} from './types.js';

export const DISCLAIMER =
  'This mapping is an aid, not an attestation. Canary cannot certify ' +
  'compliance. A listed item shows that a check ran and what it recorded; ' +
  'it does not show that a control is met.';

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Header values and item times are printed, so they are checked, not trusted. */
function malformed(scope: Scope, times: string[] = []): string | null {
  const all = [scope.since, scope.until, scope.at, ...times];
  const bad = all.find((time) => !INSTANT.test(time));
  if (bad !== undefined) return `${bad} is not an ISO 8601 instant`;
  const ok = scope.commit === null || /^[0-9a-f]{7,64}$/.test(scope.commit);
  return ok ? null : `commit ${scope.commit} is not a hex SHA`;
}

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
  const bad = malformed(
    scope,
    items.map((i) => i.at),
  );
  if (bad !== null) throw new TypeError(plain(`evidence: ${bad}`));
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

/** D10: one item, dated at the export and linked to HEAD; a score that scored nothing is no item. */
function ciReadySource(scope: Scope, score: () => CiReadyReport) {
  const src = { id: 'ci-ready' as const, path: '.', scope };
  const { at, commit } = scope;
  // Closed at `until`: the default window ends at the export time itself.
  const outside = at < scope.since || at > scope.until;
  if (outside) return noItems(src, 'out-of-window', `scored at ${at}`);
  if (commit === null) return noItems(src, 'unreadable', 'no HEAD commit');
  const report = score();
  if (report.checked === 0) return noItems(src, 'absent', 'no check scored');
  const checks = report.checks.map((c) => `${c.name} ${c.verdict}`).join(', ');
  const summary = `ci-ready ${report.verdict}: ${report.checked} of ${report.checks.length} checks scored (${checks})`;
  const ref = { kind: 'commit' as const, id: commit };
  return oneItem(src, { date: at, summary, ref });
}

export function exportPack(scope: Scope, score: () => CiReadyReport): Outcome {
  const problem = typo(scope) ?? malformed(scope);
  if (problem !== null)
    return { exit: 2, lines: [plain(`evidence: ${problem}`)] };
  const sources = [
    readBatwoman(scope),
    readLedger(scope),
    readHistory(scope),
    ciReadySource(scope, score),
  ];
  const out = scope.out ?? `${scope.root}/.canary/evidence`;
  return writePack(out, buildPack(sources, scope));
}
