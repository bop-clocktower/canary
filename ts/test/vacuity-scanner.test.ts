/**
 * canary-cassandra — vacuous-test detection (#612).
 *
 * A vacuous test is one that PASSES WITHOUT PROVING ANYTHING: it has
 * assertions, it goes green, and it goes green identically against the bug it
 * was written to catch. Three shipped examples are recorded in #486, and all
 * three cleared every gate this repo had.
 *
 * The issue's accepted risk is the one that shapes this module: a test's
 * "declared target" is not declared anywhere, so inferring it is exactly the
 * heuristic tier STRATEGY.md distrusts. So the target rule carries an explicit
 * fidelity ladder — `annotated` (`@covers Symbol`) over `import-inferred` — and
 * a test whose target cannot be resolved at either tier is recorded as a SKIP
 * with its reason, never scanned-and-passed.
 *
 * The denominator contract is the point of the whole module, so it is asserted
 * first: a scan of zero tests must abstain, and a scan that found nothing must
 * still be able to say how many tests it read.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { gateOutcome } from '../src/core/gate-result.js';
import {
  scanVacuity,
  type VacuityFinding,
} from '../src/core/vacuity-scanner.js';
import { makeProject, type TempProject } from './scanner-testkit.js';

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function scan(name: string, content: string) {
  project = makeProject({ [name]: content });
  return scanVacuity(`${project.root}/${name}`);
}

function rules(findings: readonly VacuityFinding[]): string[] {
  return findings.map((f) => f.rule);
}

const IMPORTS = `import { it, expect } from 'vitest';\nimport { save, load } from './store.js';\n`;

describe('the denominator', () => {
  it('abstains on a file with no tests at all', () => {
    // The whole class this module exists to detect is "green means nothing", so
    // it must not be able to produce a green from an empty read. `checked: 0`
    // routes through `gateOutcome`, which structurally refuses a pass line.
    const result = scan('a.test.ts', 'export const helper = 1;\n');
    expect(result.checked).toBe(0);
    const outcome = gateOutcome(result, 'advisory');
    expect(outcome.abstained).toBe(true);
    expect(outcome.summaryLine).toContain('this is not a pass');
  });

  it('abstains on an empty file', () => {
    const result = scan('a.test.ts', '');
    expect(result.checked).toBe(0);
    expect(gateOutcome(result, 'advisory').abstained).toBe(true);
  });

  it('reports the count of tests it read, not just the findings', () => {
    const result = scan(
      'a.test.ts',
      IMPORTS +
        `it('saves', () => { expect(save(1)).toBe(1); });\n` +
        `it('loads', () => { expect(load(1)).toBe(1); });\n`,
    );
    expect(result.checked).toBe(2);
    expect(result.findings).toEqual([]);
    expect(gateOutcome(result, 'advisory').abstained).toBe(false);
  });

  it('refuses to guess a framework it cannot parse', () => {
    // Same contract `frameworkForPath` already enforces: a guess that cannot be
    // told apart from a clean result is a false green. Zero findings from a
    // scanner that could not read the input is an abstention.
    const result = scan('notes.md', '# not a test file\n');
    expect(result.checked).toBe(0);
    expect(result.skipped?.[0]?.reason).toMatch(/no ruleset|cannot/i);
    expect(gateOutcome(result, 'advisory').abstained).toBe(true);
  });

  // A path that cannot be READ is the third zero, and the worst-shaped one: the
  // first cut let `readFileSync` throw, so the CLI printed a raw ENOENT stack
  // and — because the throw escaped the command handler rather than the exit
  // contract — exited **0**. A gate that cannot open its input and reports
  // success is the exact false-green this batch exists to remove.
  it('abstains on a path it cannot read, instead of throwing', () => {
    project = makeProject({ 'a.test.ts': '' });
    const result = scanVacuity(`${project.root}/missing.test.ts`);
    expect(result.checked).toBe(0);
    expect(result.skipped?.[0]?.reason).toMatch(
      /could not be read|ENOENT|read/i,
    );
    expect(gateOutcome(result, 'advisory').abstained).toBe(true);
  });

  it('abstains on a directory passed where a file was expected', () => {
    project = makeProject({ 'a.test.ts': '' });
    const result = scanVacuity(project.root);
    expect(result.checked).toBe(0);
    expect(result.skipped?.length).toBeGreaterThan(0);
  });

  it.each(['mjs', 'cjs', 'mts', 'cts'])(
    'reads a .%s suite rather than reporting zero tests',
    (ext) => {
      const result = scan(
        `a.test.${ext}`,
        IMPORTS + `it('saves', () => { expect(save(1)).toBe(1); });\n`,
      );
      expect(result.checked).toBe(1);
    },
  );
});

describe('VAC-001 — tautological assertion', () => {
  it.each([
    `expect(true).toBe(true);`,
    `expect(1).toBe(1);`,
    `expect('x').toBe('x');`,
    `expect(count).toBe(count);`,
    `expect([]).toEqual([]);`,
  ])('flags %s', (line) => {
    const r = scan(
      'a.test.ts',
      IMPORTS + `it('proves nothing', () => {\n  save(1);\n  ${line}\n});\n`,
    );
    expect(rules(r.findings)).toContain('VAC-001');
  });

  it.each(['assert True', 'assert 1 == 1', 'assert value == value'])(
    'flags the pytest form %s',
    (line) => {
      const r = scan(
        'test_a.py',
        `from store import save\n\ndef test_proves_nothing():\n    save(1)\n    ${line}\n`,
      );
      expect(rules(r.findings)).toContain('VAC-001');
    },
  );

  it('does not flag `assert False` — a deliberate unreachable marker', () => {
    const r = scan(
      'test_a.py',
      `from store import save\n\ndef test_raises():\n    try:\n        save(None)\n        assert False\n    except ValueError:\n        assert True\n`,
    );
    // `assert True` in the except branch is still a tautology and still flagged;
    // the point is that `assert False` alone must not be, since it can only
    // ever fail.
    const lines = r.findings
      .filter((f) => f.rule === 'VAC-001')
      .map((f) => f.line);
    expect(lines).toEqual([8]);
  });

  it('does not flag a real comparison', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS + `it('saves', () => { expect(save(1)).toBe(2); });\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-001');
  });

  it('does not read a tautology out of fixture data', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `it('lints', () => {\n` +
        '  const src = `expect(true).toBe(true);`;\n' +
        `  expect(scan(src).length).toBe(1);\n` +
        `});\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-001');
  });
});

describe('VAC-002 — the declared target is never invoked', () => {
  it('flags a test that references no imported symbol', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `it('claims to save', () => {\n  const row = { id: 1 };\n  expect(row.id).toBe(1);\n});\n`,
    );
    const f = r.findings.filter((x) => x.rule === 'VAC-002');
    expect(f).toHaveLength(1);
    expect(f[0]!.fidelity).toBe('import-inferred');
  });

  it('does not flag a test that calls its target', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS + `it('saves', () => { expect(save(1)).toBe(1); });\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-002');
  });

  // The issue's stated failure mode, made a test rather than a hope: "it will
  // confidently flag a correct integration test as vacuous when the call sits
  // several frames deeper". One hop of local closure kills the common case — a
  // test that goes through a helper defined in the same file.
  it('does not flag a target reached through a local helper', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `function roundTrip(v) { return load(save(v)); }\n` +
        `it('round-trips', () => { expect(roundTrip(1)).toBe(1); });\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-002');
  });

  it('follows a chain of local helpers to a fixpoint', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `const inner = (v) => save(v);\n` +
        `const outer = (v) => inner(v);\n` +
        `it('round-trips', () => { expect(outer(1)).toBe(1); });\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-002');
  });

  // Measured on canary's own suite: the largest single source of VAC-002/003
  // false positives was the testkit idiom `const { findings, write } =
  // kitFor(dir)`. `kitFor` is the imported target, `findings()` reaches it, and
  // a binding regex that only understood `const x =` saw none of that — so
  // every test in `doc-links.test.ts` read as touching nothing.
  it('tracks a target reached through a destructured binding', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `const { get, put } = save(1);\n` +
        `it('round-trips', () => { expect(get()).toBe(1); });\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-002');
  });

  // The declare-then-assign-in-beforeEach idiom, which is what `doc-links.test.ts`
  // actually uses: `let findings: Kit['findings']` at module scope, then
  // `({ write, findings } = kitFor(root))` inside a hook. There is no declarator
  // on the line that does the binding, so a declaration-only pattern misses it
  // and every test in the file reads as touching nothing.
  it('tracks a destructuring assignment with no declarator', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `let get;\n` +
        `beforeEach(() => {\n  ({ get } = save(1));\n});\n` +
        `it('round-trips', () => { expect(get()).toBe(1); });\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-002');
  });

  it('tracks a destructured binding through a chain', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `const kit = { run: () => save(1) };\n` +
        `const { run } = kit;\n` +
        `it('round-trips', () => { expect(run()).toBe(1); });\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-002');
  });

  it('prefers an explicit @covers annotation over the inference', () => {
    // The graph-verified rung of the ladder: when the author states the target,
    // the rule checks THAT and reports the higher fidelity, instead of guessing
    // from the import list.
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `// @covers migrate\n` +
        `it('claims to migrate', () => { expect(save(1)).toBe(1); });\n`,
    );
    const f = r.findings.filter((x) => x.rule === 'VAC-002');
    expect(f).toHaveLength(1);
    expect(f[0]!.fidelity).toBe('annotated');
    expect(f[0]!.message).toContain('migrate');
  });

  it('clears an annotated target that IS invoked', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `// @covers save\n` +
        `it('saves', () => { expect(save(1)).toBe(1); });\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-002');
  });

  it('skips — loudly — a file with no target signal at either tier', () => {
    // No relative imports and no annotation: the target genuinely cannot be
    // resolved. That is "cannot verify", which is a finding about the scan, not
    // a clean result for the test. It must land in `skipped`, and the tests it
    // covers must NOT count toward `checked`.
    const r = scan(
      'a.test.ts',
      `import { it, expect } from 'vitest';\n` +
        `it('adds', () => { expect(1 + 1).toBe(2); });\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-002');
    expect(r.skipped?.some((s) => s.name.includes('VAC-002'))).toBe(true);
    expect(r.skipped?.[0]?.reason).toMatch(/no @covers|relative import/i);
  });
});

describe('VAC-003 — every assertion asserts absence', () => {
  // The canary-katana case from #486: `expect(existsSync(ledger)).toBe(false)`
  // was free, because the buggy code exited before the write. An all-absence
  // test passes identically when the code under test never ran at all.
  it('flags a test whose only assertion is an absence', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `it('does not write the ledger', () => {\n` +
        `  save(['--help']);\n` +
        `  expect(existsSync(ledger)).toBe(false);\n` +
        `});\n`,
    );
    const f = r.findings.filter((x) => x.rule === 'VAC-003');
    expect(f).toHaveLength(1);
    expect(f[0]!.suggestion).toMatch(/actually ran|exit code|positive/i);
  });

  it.each([
    'expect(res.err).toBeNull();',
    'expect(res.err).toBeUndefined();',
    'expect(res.warnings).toHaveLength(0);',
    'expect(res.warnings).toEqual([]);',
    'expect(res.ok).toBeFalsy();',
    'expect(res.err).not.toBeDefined();',
  ])('recognises %s as an absence assertion', (line) => {
    const r = scan(
      'a.test.ts',
      IMPORTS + `it('is quiet', () => {\n  save(1);\n  ${line}\n});\n`,
    );
    expect(rules(r.findings)).toContain('VAC-003');
  });

  // Measured, and it moved the rule: the first cut reported 254 findings over
  // canary's own 2154 tests, and the overwhelming majority were plain negative
  // tests of the form `expect(isCI()).toBe(false)`. Those are not vacuous at
  // all — the assertion observes the TARGET'S OWN RETURN VALUE, so the target
  // provably ran and the `false` is load-bearing.
  //
  // The katana defect from #486 is the other shape: the absence is observed
  // somewhere ELSE (the filesystem), so nothing in the test proves the operation
  // ran, and the buggy code satisfied it by exiting early. That distinction —
  // does the absence assertion invoke the target, or watch a bystander — is what
  // VAC-003 actually keys on.
  it('does not flag a negative assertion on the target’s own return value', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `it('is false for an empty env', () => {\n  expect(save('')).toBe(false);\n});\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-003');
  });

  it('skips VAC-003 too when no target can be resolved', () => {
    // Without a target set the rule cannot ask its central question, so the
    // honest outcome is a recorded skip — not a quiet pass, and not a guess.
    const r = scan(
      'a.test.ts',
      `import { it, expect } from 'vitest';\n` +
        `it('is quiet', () => { expect(readFileSync('x')).toBeNull(); });\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-003');
    expect(r.skipped?.some((s) => s.name.includes('VAC-003'))).toBe(true);
  });

  it('clears a test that also asserts a positive precondition', () => {
    // One assertion proving the operation RAN is the whole fix: with it, the
    // absence assertion is load-bearing rather than free.
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `it('does not write the ledger', () => {\n` +
        `  const res = save(['--help']);\n` +
        `  expect(res.exitCode).toBe(0);\n` +
        `  expect(existsSync(ledger)).toBe(false);\n` +
        `});\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-003');
  });

  it('flags the pytest form', () => {
    const r = scan(
      'test_a.py',
      `from store import save\n\ndef test_is_quiet():\n    save(1)\n    assert result.err is None\n`,
    );
    expect(rules(r.findings)).toContain('VAC-003');
  });

  it('does not flag an assertion-free test — that is LINT-006 territory', () => {
    // Overlap is the enemy: a test with zero assertions is already reported by
    // the static linter, and reporting it twice makes an author dismiss both.
    const r = scan(
      'a.test.ts',
      IMPORTS + `it('does nothing', () => {\n  save(1);\n});\n`,
    );
    expect(rules(r.findings)).not.toContain('VAC-003');
  });
});

describe('severity reflects confidence, not appetite', () => {
  it('rates the deterministic rule critical and the inferred ones warning', () => {
    const r = scan(
      'a.test.ts',
      IMPORTS +
        `it('a', () => { save(1); expect(true).toBe(true); });\n` +
        `it('b', () => { const row = {}; expect(row).toEqual({}); });\n`,
    );
    const sev = new Map(r.findings.map((f) => [f.rule, f.severity]));
    expect(sev.get('VAC-001')).toBe('critical');
    expect(sev.get('VAC-002')).toBe('warning');
  });
});
