// report -- observed outcome counts per gate, and nothing more (#618).
//
// The floor is the guardian's own (ADR 0025): 30 adjudicated labels, real +
// noise, per gate. At n = 30 the 95% margin on an observed proportion is at
// most about +/-18 points; below it the report abstains (exit 3, ADR 0009)
// and names how many more labels each gate needs. At or above it, the counts
// print with the caveat that tuning is not built. This module never computes
// or prints a threshold, a rate or a recommendation, at any count -- that is
// the deferred half of #618, and a number here would be read as one.

import { clean, md } from './escape.mjs';

/** Mirrors PRECISION_FLOOR in ts/src/guardian/adjudication.ts (parity-tested). */
export const PRECISION_FLOOR = 30;

export const ABSTAINED_LINE =
  '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

export const CAVEAT =
  'Observed counts only. Threshold tuning is not built yet (#618), so ' +
  'nothing here proposes a gate setting.';

/** Markdown rows stop here; --json carries every gate. */
export const MAX_ROWS = 50;

const OUTCOMES = ['real', 'noise', 'intentional', 'escape'];

function emptyGate(gate) {
  return {
    gate,
    real: 0,
    noise: 0,
    intentional: 0,
    escape: 0,
    unlabelled: 0,
    overridden: 0,
  };
}

/** The latest label per finding (ledger order), and every escape. */
function effectiveLabels(labels) {
  const latest = new Map();
  const escapes = [];
  const overridden = new Map();
  for (const l of labels) {
    if (!OUTCOMES.includes(l.outcome)) continue;
    if (l.finding === null || l.outcome === 'escape') {
      escapes.push(l);
      continue;
    }
    if (latest.has(l.finding)) {
      overridden.set(l.finding, (overridden.get(l.finding) ?? 0) + 1);
    }
    latest.set(l.finding, l);
  }
  return { latest, escapes, overridden };
}

function gateOf(gates, name) {
  const key = String(name);
  if (!gates.has(key)) gates.set(key, emptyGate(key));
  return gates.get(key);
}

/** Per-gate tallies over the ledger state. */
function tally(state) {
  const gates = new Map();
  const { latest, escapes, overridden } = effectiveLabels(state.labels);
  for (const f of state.findings.values()) {
    const g = gateOf(gates, f.gate);
    const l = latest.get(f.id);
    if (l) g[l.outcome] += 1;
    else g.unlabelled += 1;
    if (overridden.has(f.id)) g.overridden += 1;
  }
  for (const e of escapes) gateOf(gates, e.gate).escape += 1;
  return [...gates.values()].sort((a, b) => (a.gate < b.gate ? -1 : 1));
}

function withFloor(g) {
  const adjudicated = g.real + g.noise;
  const needs = Math.max(0, PRECISION_FLOOR - adjudicated);
  return {
    ...g,
    gate: clean(g.gate),
    adjudicated,
    meetsFloor: needs === 0,
    needs,
  };
}

/**
 * @param {{findings: Map, runs: object[], labels: object[]}} state
 * @param {{malformed: number}} meta
 */
export function buildReport(state, { malformed }) {
  const gates = tally(state).map(withFloor);
  const abstained = !gates.some((g) => g.meetsFloor);
  let reason = null;
  if (state.labels.length === 0) {
    reason = 'no labels in the ledger; record a gate run or add a label first';
  } else if (abstained) {
    reason = `no gate has ${PRECISION_FLOOR} adjudicated (real + noise) labels yet`;
  }
  return {
    schema_version: 1,
    floor: PRECISION_FLOOR,
    checked: state.labels.length,
    abstained,
    reason,
    malformed,
    gates,
    caveat: CAVEAT,
  };
}

function row(g) {
  const status = g.meetsFloor ? 'at floor' : `needs ${g.needs} more`;
  const cells = [md(g.gate, 60), g.real, g.noise, g.intentional, g.escape];
  return `| ${[...cells, g.unlabelled, g.adjudicated, status].join(' | ')} |`;
}

/** The Markdown report. */
export function renderMarkdown(report) {
  const lines = ['# canary-hawk-dove: outcome labels', ''];
  if (report.abstained)
    lines.push(ABSTAINED_LINE, '', md(report.reason, 300), '');
  lines.push(
    `Floor: ${report.floor} adjudicated labels (real + noise) per gate ` +
      '(ADR 0025). Escapes and intentional labels are counted, not adjudicated.',
    '',
  );
  if (report.gates.length > 0) {
    lines.push(
      '| Gate | Real | Noise | Intentional | Escape | Unlabelled | Adjudicated | Status |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...report.gates.slice(0, MAX_ROWS).map(row),
      '',
    );
  }
  const hidden = report.gates.length - MAX_ROWS;
  if (hidden > 0) lines.push(`and ${hidden} more gate(s); see --json.`, '');
  if (report.malformed > 0) {
    lines.push(`${report.malformed} malformed ledger line(s) not read.`, '');
  }
  lines.push(CAVEAT);
  return lines.join('\n');
}
