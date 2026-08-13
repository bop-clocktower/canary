/**
 * Gate `canary-promote-test` on a structured verdict (#477).
 *
 * ## Why this is unblocked
 *
 * The issue says "blocked on the emit side" and "do not schedule this until the
 * upstream emit lands", because `harness:test-craft` runs an 8-axis per-test LLM
 * critique with no machine-readable output for a consumer to gate on. That is
 * still true, and this change does not wait for it: #605 and #612 now emit
 * exactly the structured per-test verdicts the gate needed, and they are
 * DETERMINISTIC. Building the consumer against them is not building it twice —
 * the LLM critique was never going to be the thing that blocks.
 *
 * ## The three decisions the issue asked for, answered
 *
 * 1. **Which axes gate.** Deterministic defects gate: soundness (`SOUND-*`),
 *    zero assertions (`LINT-006`), critical flakiness (`FLAKE-001/002`), and
 *    vacuity at a fidelity that can carry it. Style and maintainability
 *    (`LINT-001/002/003/005`) report. An 8-axis gate would block every
 *    promotion, which is the failure the issue predicted.
 * 2. **What happens with no verdict.** `abstain`, exit 3, loudly — promotion
 *    falls back to today's manual review and says so. Never silently stricter,
 *    never silently looser.
 * 3. **Whether an LLM judgement may block.** No. Everything that gates in this
 *    repo is deterministic and this change does not break that. The decision is
 *    structural rather than a comment: `source` admits one value, so there is no
 *    field for an LLM verdict to arrive in and quietly acquire authority.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { promotionVerdict } from '../src/core/promotion-verdict.js';
import { makeProject, type TempProject } from './scanner-testkit.js';

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function verdict(name: string, content: string) {
  project = makeProject({ [name]: content });
  return promotionVerdict(`${project.root}/${name}`);
}

const HEAD = `import { it, expect } from 'vitest';\nimport { save } from './store.js';\n`;

const CLEAN = `${HEAD}it('saves and returns the row id', () => {\n  expect(save({ id: 7 })).toBe(7);\n});\n`;

describe('a clean generated test promotes', () => {
  it('returns promote with the denominator it inspected', () => {
    const v = verdict('a.test.ts', CLEAN);
    expect(v.decision).toBe('promote');
    expect(v.checked).toBe(1);
    expect(v.blocked).toEqual([]);
    expect(v.exitCode).toBe(0);
  });

  it('names every axis it evaluated, gating or not', () => {
    // A verdict that lists only its failures cannot be told apart from a verdict
    // that only ran one check. The axes travel with the decision.
    const v = verdict('a.test.ts', CLEAN);
    const axes = v.axes.map((a) => a.axis).sort();
    expect(axes).toEqual([
      'assertions',
      'flakiness',
      'maintainability',
      'selectors',
      'soundness',
      'vacuity',
    ]);
    expect(
      v.axes
        .filter((a) => a.gating)
        .map((a) => a.axis)
        .sort(),
    ).toEqual(['assertions', 'flakiness', 'soundness', 'vacuity']);
  });

  it('reports the verdict as deterministic', () => {
    expect(verdict('a.test.ts', CLEAN).source).toBe('deterministic');
  });
});

describe('the gating axes block promotion', () => {
  it('blocks a test that pins a non-deterministic value (SOUND-001)', () => {
    const v = verdict(
      'a.test.ts',
      `${HEAD}it('saves', () => {\n  expect(save({}).id).toBe(crypto.randomUUID());\n});\n`,
    );
    expect(v.decision).toBe('block');
    expect(v.blocked).toContain('SOUND-001');
    expect(v.exitCode).toBe(1);
  });

  it('blocks a test with no assertions at all (LINT-006)', () => {
    const v = verdict(
      'a.test.ts',
      `${HEAD}it('saves', () => {\n  save({});\n});\n`,
    );
    expect(v.decision).toBe('block');
    expect(v.blocked).toContain('LINT-006');
  });

  it('blocks a tautological assertion (VAC-001)', () => {
    const v = verdict(
      'a.test.ts',
      `${HEAD}it('saves', () => {\n  save({});\n  expect(true).toBe(true);\n});\n`,
    );
    expect(v.decision).toBe('block');
    expect(v.blocked).toContain('VAC-001');
  });

  it('blocks a hardcoded sleep (FLAKE-001) — the issue’s named blocker', () => {
    const v = verdict(
      'a.test.ts',
      `${HEAD}it('saves', async () => {\n  await page.waitForTimeout(3000);\n  expect(save({})).toBe(1);\n});\n`,
    );
    expect(v.decision).toBe('block');
    expect(v.blocked).toContain('FLAKE-001');
  });
});

describe('the advisory axes report and do not block', () => {
  it('reports a brittle selector without blocking', () => {
    const v = verdict(
      'a.test.ts',
      `${HEAD}it('saves', () => {\n  page.locator('.btn');\n  expect(save({})).toBe(1);\n});\n`,
    );
    expect(v.decision).toBe('promote');
    const selectors = v.axes.find((a) => a.axis === 'selectors')!;
    expect(selectors.gating).toBe(false);
    expect(selectors.findings.map((f) => f.rule)).toContain('LINT-001');
    expect(v.blocked).toEqual([]);
  });

  it('reports a magic timing value without blocking', () => {
    const v = verdict(
      'a.test.ts',
      `${HEAD}it('saves', () => {\n  const retryDelay = 4500;\n  expect(save(retryDelay)).toBe(1);\n});\n`,
    );
    expect(v.decision).toBe('promote');
    expect(
      v.axes.find((a) => a.axis === 'maintainability')!.findings.length,
    ).toBeGreaterThan(0);
  });
});

describe('the fidelity ladder decides whether vacuity may block', () => {
  // The issue's real anxiety about this gate: making a heuristic load-bearing on
  // promotion. So the rung the finding was derived at decides its authority,
  // mirroring the guardian's `coverage-verified > graph-verified > heuristic`.
  it('does not block on an import-inferred VAC-002', () => {
    const v = verdict(
      'a.test.ts',
      `${HEAD}it('claims to save', () => {\n  const row = { id: 1 };\n  expect(row.id).toBe(1);\n});\n`,
    );
    const vacuity = v.axes.find((a) => a.axis === 'vacuity')!;
    expect(vacuity.findings.map((f) => f.rule)).toContain('VAC-002');
    expect(v.blocked).not.toContain('VAC-002');
    expect(v.decision).toBe('promote');
  });

  it('blocks on an annotated VAC-002 — the author stated the target', () => {
    const v = verdict(
      'a.test.ts',
      `${HEAD}// @covers migrate\nit('claims to migrate', () => {\n  expect(save({})).toBe(1);\n});\n`,
    );
    expect(v.blocked).toContain('VAC-002');
    expect(v.decision).toBe('block');
  });

  it('records the fidelity on the finding so a reader can audit the call', () => {
    const v = verdict(
      'a.test.ts',
      `${HEAD}it('claims to save', () => {\n  const row = { id: 1 };\n  expect(row.id).toBe(1);\n});\n`,
    );
    const vac2 = v.axes
      .find((a) => a.axis === 'vacuity')!
      .findings.find((f) => f.rule === 'VAC-002')!;
    expect(vac2.fidelity).toBe('import-inferred');
  });
});

describe('absence of a verdict degrades loudly, never silently', () => {
  it('abstains on a file no ruleset can parse', () => {
    const v = verdict('notes.md', '# not a test\n');
    expect(v.decision).toBe('abstain');
    expect(v.exitCode).toBe(EXIT_ABSTAINED);
    expect(v.checked).toBe(0);
    expect(v.summaryLine).toMatch(/not a pass/);
  });

  it('abstains on a parseable file that holds no tests', () => {
    // Promotion must not become LOOSER here. Zero tests means the verdict has no
    // subject, so there is nothing to have passed — and a `promote` on this
    // input would let an empty file into the committed suite.
    const v = verdict('a.test.ts', 'export const fixture = 1;\n');
    expect(v.decision).toBe('abstain');
    expect(v.exitCode).toBe(EXIT_ABSTAINED);
  });

  it('abstains on a path it cannot read, instead of throwing', () => {
    // The worst-shaped zero: the first cut let `readFileSync` throw out of the
    // command handler, so the CLI printed a raw ENOENT stack and exited **0** —
    // a promotion gate that could not open the draft, reporting success.
    project = makeProject({ 'a.test.ts': '' });
    const v = promotionVerdict(`${project.root}/missing.test.ts`);
    expect(v.decision).toBe('abstain');
    expect(v.exitCode).toBe(EXIT_ABSTAINED);
    expect(v.skipped[0]?.reason).toMatch(/could not be read|ENOENT|read/i);
  });

  it('tells the reader to fall back to manual review', () => {
    const v = verdict('a.test.ts', '');
    expect(v.decision).toBe('abstain');
    expect(v.remedy).toMatch(/manual|review/i);
  });

  it('never abstains when it has findings — a finding proves it ran', () => {
    // `gateOutcome`'s own precedence, preserved here: a finding outranks a
    // collapsed denominator, because it is proof that something WAS checked.
    const v = verdict(
      'a.test.ts',
      `${HEAD}it('saves', () => {\n  save({});\n});\n`,
    );
    expect(v.checked).toBe(1);
    expect(v.decision).toBe('block');
  });

  it('carries the unresolved-target skips into the verdict', () => {
    const v = verdict(
      'a.test.ts',
      `import { it, expect } from 'vitest';\nit('adds', () => {\n  expect(1 + 1).toBe(2);\n});\n`,
    );
    // The test is promotable, but the reader must be able to see that the
    // vacuity rules could not run on it.
    expect(v.decision).toBe('promote');
    expect(v.skipped.length).toBeGreaterThan(0);
    expect(v.summaryLine).toMatch(/skipped/);
  });
});

describe('no LLM judgement can acquire gating authority', () => {
  it('admits exactly one verdict source', () => {
    // Structural, not a convention: there is no field an LLM verdict could
    // arrive in. `harness:test-craft` stays what promote-test already calls it —
    // an optional deeper audit for a human — and cannot become a blocker by
    // someone wiring it into this function.
    const v = verdict('a.test.ts', CLEAN);
    expect(v.source).toBe('deterministic');
    expect(Object.keys(v)).not.toContain('llm');
    expect(JSON.stringify(v)).not.toMatch(/confidence|rationale/);
  });
});
