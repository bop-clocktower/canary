// canary-misfit -- per-flow verdicts (#592).
//
// Two inputs meet here: the flows read out of the Playwright JSON report
// (flows.mjs) and the injection ledger the route fixture appends to (which
// faults actually fired, against which request). Neither alone can produce a
// verdict: results without a ledger cannot tell a resilient flow from an
// untouched one, and a ledger without results cannot tell survival from
// collapse.
//
// The verdict is advisory. The one thing this module refuses to do is count a
// flow nothing was injected into as evidence of resilience -- those are
// `unexercised` and are excluded from the denominator (#508).

import fs from 'node:fs';

import { isObject } from './flows.mjs';

/** Verdicts, ordered worst-first for reporting. */
export const VERDICTS = ['shattered', 'degraded', 'graceful', 'unexercised'];

/** One ledger line, or null when the line is not a usable row. */
function ledgerRow(line) {
  const text = line.trim();
  if (!text) return null;
  try {
    const row = JSON.parse(text);
    if (isObject(row) && typeof row.test_id === 'string') return row;
  } catch {
    // A truncated final line is what a killed run leaves behind; one
    // unparseable row must not discard the rows that did survive.
  }
  return null;
}

/** Read the JSONL injection ledger the route fixture wrote. */
export function readLedger(ledgerPath) {
  if (!ledgerPath || !fs.existsSync(ledgerPath)) return [];
  const rows = [];
  for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
    const row = ledgerRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

/** Group the ledger by flow, keyed by test id and falling back to the title. */
function injectionsByFlow(ledger) {
  const byKey = new Map();
  for (const row of ledger) {
    for (const key of [row.test_id, row.test_title]) {
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(row);
    }
  }
  return byKey;
}

/** Latency this flow was deliberately made to absorb, in ms. */
function injectedDelayMs(injections) {
  let total = 0;
  for (const row of injections) total += Number(row.delay_ms) || 0;
  return total;
}

/**
 * The budget a passing flow has to stay inside to count as graceful. The
 * profile states it; absent that, twice the injected delay, which at least
 * scales with what the flow was asked to survive (proposal D8). Null means
 * "unstated and underivable", and an unstated budget is never breached.
 */
export function budgetFor(profile, injections) {
  if (profile && profile.budget_ms) return profile.budget_ms;
  const injected = injectedDelayMs(injections);
  if (injected > 0) return injected * 2;
  return null;
}

const PASSING = new Set(['passed', 'expected']);

function overBudget(flow, injections, profile) {
  const budget = budgetFor(profile, injections);
  if (budget === null) return null;
  if (flow.duration_ms <= budget) return null;
  return `passed in ${Math.round(flow.duration_ms)}ms, over the ${Math.round(budget)}ms budget`;
}

/** Classify one flow. Pure: no filesystem, no clock. */
export function classifyFlow(flow, injections, profile) {
  if (injections.length === 0) {
    return {
      verdict: 'unexercised',
      why: 'no fault was injected into this flow',
    };
  }
  if (!PASSING.has(flow.status)) {
    return {
      verdict: 'shattered',
      why: `flow ${flow.status} under injected faults`,
    };
  }
  if (flow.retries > 0) {
    return {
      verdict: 'degraded',
      why: `passed only after ${flow.retries} retry/retries`,
    };
  }
  const slow = overBudget(flow, injections, profile);
  if (slow) return { verdict: 'degraded', why: slow };
  return {
    verdict: 'graceful',
    why: 'passed within budget with faults applied',
  };
}

function faultsOf(injections) {
  const ids = new Set();
  for (const row of injections) {
    if (row.fault_id) ids.add(row.fault_id);
  }
  return [...ids].sort();
}

function worstFirst(a, b) {
  const byVerdict = VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict);
  if (byVerdict !== 0) return byVerdict;
  return a.title.localeCompare(b.title);
}

/**
 * Assess a whole run.
 *
 * `exercised` is the denominator. Zero exercised flows is an ABSTENTION, never
 * a clean bill of health -- that is the distinction this return shape exists to
 * keep visible to the caller.
 */
export function assessRun({ flows, ledger, profile }) {
  const grouped = injectionsByFlow(ledger);
  const counts = Object.fromEntries(VERDICTS.map((name) => [name, 0]));

  const assessed = flows.map((flow) => {
    const injections = grouped.get(flow.id) || grouped.get(flow.title) || [];
    const { verdict, why } = classifyFlow(flow, injections, profile);
    counts[verdict] += 1;
    return {
      ...flow,
      verdict,
      why,
      injections: injections.length,
      faults: faultsOf(injections),
    };
  });

  const exercised = assessed.length - counts.unexercised;
  return {
    flows: assessed.sort(worstFirst),
    counts,
    exercised,
    abstained: exercised === 0,
  };
}
