/**
 * CI-readiness section (#611): runs the same pure scorer as `canary ci-ready`
 * over the same three inputs, so the dossier and the command cannot disagree.
 *
 * `historyPath` is always the default store under the root -- the one
 * `canary ci-ready` reads -- never `--history`, so the two cannot score
 * different runs. A store that exists but cannot be read (EISDIR, EACCES, ...)
 * is ci-ready's own skip with a reason on both history checks (#1132), consumed
 * here as-is -- never scored as absent. A store ci-ready would still throw on
 * (corrupt JSON, unsupported schema) is DARK here, not scored as absent.
 *
 * DARK when ci-ready itself abstains (no check had an input); the reason
 * carries every distinct skip reason, so an unreadable input is named. An
 * `incomplete` ci-ready verdict is fed -- some checks scored -- but raised as
 * worth your eyes, because skipped checks are not passed checks.
 */

import {
  scoreCiReady,
  type CiReadyReport,
  type RunsInput,
} from '../../core/ci-ready.js';
import {
  parseCriticalAreas,
  parseInventory,
} from '../../core/inventory-checks.js';
import { NdjsonHistoryStore } from '../../history/ndjson-store.js';
import { readSource, sourceRef, type SourceRead } from './sources.js';
import {
  darkSection,
  fedSection,
  type Section,
  type SourceRef,
} from './types.js';

export interface ReadinessPaths {
  historyPath: string;
  inventoryPath: string;
  criticalAreasPath: string;
}

/**
 * A read through ci-ready's parser. Missing is the parser's own "no file"
 * case; unreadable (EISDIR, EACCES, ...) is an unusable input in exactly the
 * wording `canary ci-ready` uses, never reported as absent (#1129 follow-up).
 */
function inputOf<T>(
  read: SourceRead,
  parse: (text: string | null) => T,
): T | { ok: false; reason: string } {
  if (read.kind === 'unreadable') {
    const name = `.canary/${read.path.split(/[\\/]/).pop() ?? read.path}`;
    return { ok: false, reason: `${name} could not be read (${read.reason})` };
  }
  return parse(read.kind === 'ok' ? read.text : null);
}

/**
 * ci-ready's runs input: stored runs, null when absent, the unreadable reason
 * in ci-ready's wording (#1132), or the error ci-ready itself would throw.
 */
function runsOf(read: SourceRead, path: string): RunsInput | Error {
  if (read.kind === 'missing') return null;
  if (read.kind === 'unreadable') {
    return { ok: false, reason: `${path} could not be read (${read.reason})` };
  }
  try {
    return new NdjsonHistoryStore(path).readAll();
  } catch (err) {
    return err as Error;
  }
}

/** A scored ci-ready report as a fed section; skipped checks are raised, not passed. */
function fedReadiness(report: CiReadyReport, sources: SourceRef[]): Section {
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

export function readinessSection(paths: ReadinessPaths): Section {
  const history = readSource(paths.historyPath);
  const inventory = readSource(paths.inventoryPath);
  const critical = readSource(paths.criticalAreasPath);
  const sources = [history, inventory, critical].map(sourceRef);
  const runs = runsOf(history, paths.historyPath);
  if (runs instanceof Error) {
    return darkSection(
      'ci-readiness',
      sources,
      `ci-ready cannot read ${paths.historyPath} (${runs.message})`,
    );
  }
  const report = scoreCiReady({
    runs,
    historyPath: paths.historyPath,
    inventory: inputOf(inventory, parseInventory),
    criticalAreas: inputOf(critical, parseCriticalAreas),
  });
  if (report.verdict === 'abstained') {
    const why = [...new Set(report.checks.map((c) => c.reason))].join('; ');
    return darkSection(
      'ci-readiness',
      sources,
      `ci-ready abstained: no check had an input to score (${why})`,
    );
  }
  return fedReadiness(report, sources);
}
