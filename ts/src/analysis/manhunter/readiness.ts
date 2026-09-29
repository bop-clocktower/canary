/**
 * CI-readiness section (#611): runs the same pure scorer as `canary ci-ready`
 * over the same three inputs, so the dossier and the command cannot disagree.
 *
 * DARK only when ci-ready itself abstains (no check had an input). An
 * `incomplete` ci-ready verdict is fed -- some checks scored -- but raised as
 * worth your eyes, because skipped checks are not passed checks.
 */

import { scoreCiReady } from '../../core/ci-ready.js';
import {
  parseCriticalAreas,
  parseInventory,
} from '../../core/inventory-checks.js';
import { NdjsonHistoryStore } from '../../history/ndjson-store.js';
import type { RunRecord } from '../../history/record.js';
import { readSource, sourceRef, type SourceRead } from './sources.js';
import { darkSection, fedSection, type Section } from './types.js';

export interface ReadinessPaths {
  historyPath: string;
  inventoryPath: string;
  criticalAreasPath: string;
}

function textOf(read: SourceRead): string | null {
  return read.kind === 'ok' ? read.text : null;
}

/** Stored runs, or null when absent or unreadable (the history section names why). */
function runsOf(read: SourceRead, path: string): RunRecord[] | null {
  if (read.kind !== 'ok') return null;
  try {
    return new NdjsonHistoryStore(path).readAll();
  } catch {
    return null;
  }
}

export function readinessSection(paths: ReadinessPaths): Section {
  const history = readSource(paths.historyPath);
  const inventory = readSource(paths.inventoryPath);
  const critical = readSource(paths.criticalAreasPath);
  const sources = [history, inventory, critical].map(sourceRef);
  const report = scoreCiReady({
    runs: runsOf(history, paths.historyPath),
    historyPath: paths.historyPath,
    inventory: parseInventory(textOf(inventory)),
    criticalAreas: parseCriticalAreas(textOf(critical)),
  });
  if (report.verdict === 'abstained') {
    return darkSection(
      'ci-readiness',
      sources,
      'ci-ready abstained: no check had an input to score',
    );
  }
  const skipped = report.checks.length - report.checked;
  const eyes = report.checks
    .filter((c) => c.verdict === 'fail' || c.verdict === 'warn')
    .map((c) => `${c.name} ${c.verdict}: ${c.reason}`);
  if (report.verdict === 'incomplete') {
    eyes.push(
      `ci-ready is incomplete: ${skipped} of ${report.checks.length} checks skipped for missing inputs`,
    );
  }
  return fedSection('ci-readiness', {
    sources,
    denominator: `${report.checked} of ${report.checks.length} checks scored`,
    facts: [
      `ci-ready verdict: ${report.verdict}`,
      ...report.checks.map((c) => `${c.verdict} ${c.name}: ${c.reason}`),
    ],
    eyes,
  });
}
