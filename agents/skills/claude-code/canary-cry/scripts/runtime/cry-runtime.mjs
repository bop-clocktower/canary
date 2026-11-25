// canary-cry runtime entry (#608 P3; spec "Codegen and runtime"). Loaded only
// by the specs codegen writes into a run dir:
//
//   test(id, ({ browser }, info) => runScenario(browser, scenario, info))
//
// so it is declared in harness.config.json's entropy and performance
// entryPoints (nothing in this repo imports it). Codegen copies runtime/ and
// ../verdict.mjs into the run dir with the same relative layout, so the
// spec + this runtime + the seed ARE the repro: each spec re-runs standalone
// with `npx playwright test -c <run>/playwright.config.mjs <spec>` (SC12).
//
// Per scenario: observer contexts take the BEFORE probes; the pattern runs
// in its own locked-down context; in-flight requests settle; the declared
// symptom selectors are read; the AFTER probes run; the verdict is judged
// here, written to observations/<scenario>.json, and a corrupted scenario
// fails its Playwright test, so the spec is also a regression test.

import fs from 'node:fs';

import { abstained, checkExpect, scenarioVerdict } from '../verdict.mjs';
import { inject } from './abuse.mjs';
import { readProbe } from './probes.mjs';
import { createSession } from './session.mjs';

const OBSERVATIONS = new URL('../observations/', import.meta.url);

async function measure(observers, invariants) {
  const values = new Map();
  for (const o of observers) {
    for (const inv of invariants) {
      const id = o.key === 'A' ? inv.id : `${inv.id}@${o.key}`;
      values.set(id, {
        inv,
        reading: await readProbe(inv, o.request, o.resolve),
      });
    }
  }
  return values;
}

/** One checked invariant: before/after values and whether it was breached. */
function judge(id, before, after) {
  const { inv } = before;
  const base = { id, expect: inv.expect };
  const failed = before.reading.error ?? after.reading.error;
  if (failed !== undefined) return { ...base, error: failed };
  const b = before.reading.value;
  const a = after.reading.value;
  return { ...base, before: b, after: a, ...checkExpect(inv.expect, b, a) };
}

/** Deep-redact a recorded value: no account value reaches an artifact. */
function scrub(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, redact));
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value).map(([k, v]) => [k, scrub(v, redact)]);
  return Object.fromEntries(entries);
}

/** Drive the scenario: `{brokenAt, invariants}`, or a runtime error thrown. */
async function drive(s, scenario) {
  try {
    const observers = await s.observers();
    const before = await measure(observers, scenario.invariants);
    await inject(s);
    await s.settle();
    for (const page of s.pages) await s.symptoms(page);
    const after = await measure(observers, scenario.invariants);
    const invariants = [...before].map(([id, b]) =>
      judge(id, b, after.get(id)),
    );
    return { brokenAt: null, invariants };
  } catch (exc) {
    if (exc.brokenAt === undefined) throw exc;
    return { brokenAt: exc.brokenAt, invariants: [] };
  }
}

async function evaluate(s, scenario) {
  try {
    const run = await drive(s, scenario);
    const v = scenarioVerdict({ ...scenario, ...run, signals: s.signals });
    return { ...v, invariants: run.invariants, error: null };
  } catch (exc) {
    return {
      ...abstained('runtime-error'),
      invariants: [],
      error: exc.message,
    };
  } finally {
    await s.close();
  }
}

/**
 * @param {object} browser the Playwright `browser` fixture
 * @param {object} scenario the inline scenario of a generated spec
 * @param {object} [info] Playwright's TestInfo, for the verdict annotation
 */
export async function runScenario(browser, scenario, info) {
  const s = createSession(browser, scenario, process.env);
  const result = await evaluate(s, scenario);
  const observation = scrub(
    {
      id: scenario.id,
      ...result,
      signals: s.signals,
      blockedEgress: [...s.blocked].sort(),
    },
    s.redact,
  );
  fs.mkdirSync(OBSERVATIONS, { recursive: true });
  const file = new URL(`${scenario.file}.json`, OBSERVATIONS);
  fs.writeFileSync(file, `${JSON.stringify(observation, null, 2)}\n`);
  const label = [result.verdict, result.reason, ...result.fingerprints];
  info?.annotations.push({
    type: 'canary-cry',
    description: label.filter(Boolean).join(' '),
  });
  if (result.verdict === 'corrupted') {
    throw new Error(`canary-cry: corrupted: ${result.fingerprints.join(', ')}`);
  }
}
