/**
 * The generated-test soundness rules (#605).
 *
 * Canary generates tests; nothing checked that the generated ones were SOUND —
 * that they pin only values a correct implementation is obliged to produce. A
 * generated test that pins a UUID, a pid, or a float it compares with exact
 * equality passes on the machine that made it and is a scheduled failure
 * everywhere else. Those tests still have assertions and still go green, so
 * every existing signal in this repo reads them as healthy.
 *
 * Rules are added to `static-linter.ts` in place rather than as a new scanner:
 * the issue's own accepted risk was that `static_linter` and `quality_scorer`
 * already overlap, and a third half-enforcer would be the actual defect.
 *
 * All three are `warning` severity on purpose — `review-test` exits 1 only on
 * `critical`, so a brand-new detector cannot turn an existing repo's gate red
 * the day it lands. Soundness BLOCKS only at the promotion boundary
 * (`promotion-verdict.ts`, #477), which is opt-in and only ever sees generated
 * tests.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { StaticLinter, type LintFinding } from '../src/core/static-linter.js';
import { makeProject, type TempProject } from './scanner-testkit.js';

let project: TempProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function lint(name: string, content: string): LintFinding[] {
  project = makeProject({ [name]: content });
  return new StaticLinter().lint(`${project.root}/${name}`);
}

function soundness(name: string, content: string): LintFinding[] {
  return lint(name, content).filter((f) => f.rule.startsWith('SOUND-'));
}

function rules(findings: LintFinding[]): string[] {
  return findings.map((f) => f.rule);
}

describe('SOUND-001 — non-deterministic value pinned into an assertion', () => {
  it.each([
    ['crypto.randomUUID()', 'expect(row.id).toBe(crypto.randomUUID());'],
    ['randomUUID()', 'expect(row.id).toEqual(randomUUID());'],
    ['nanoid()', 'expect(row.slug).toBe(nanoid());'],
    ['process.pid', 'expect(meta.owner).toBe(process.pid);'],
    ['performance.now()', 'expect(span.start).toBe(performance.now());'],
    ['os.hostname()', 'expect(meta.host).toBe(os.hostname());'],
    ['mkdtempSync', 'expect(cfg.dir).toBe(mkdtempSync("/tmp/x"));'],
  ])('flags %s asserted directly', (_label, line) => {
    const findings = soundness(
      'a.test.ts',
      `import { it, expect } from 'vitest';\nit('pins it', () => {\n  ${line}\n});\n`,
    );
    expect(rules(findings)).toContain('SOUND-001');
  });

  it.each([
    ['uuid.uuid4()', 'assert row.id == uuid.uuid4()'],
    ['os.getpid()', 'assert meta.owner == os.getpid()'],
    ['socket.gethostname()', 'assert meta.host == socket.gethostname()'],
    ['time.monotonic()', 'assert span.start == time.monotonic()'],
  ])('flags %s asserted directly in pytest', (_label, line) => {
    const findings = soundness(
      'test_a.py',
      `def test_pins_it():\n    ${line}\n`,
    );
    expect(rules(findings)).toContain('SOUND-001');
  });

  // The mode FLAKE-003/004 structurally cannot see: the assertion line itself
  // is clean, and the non-determinism entered two lines earlier. This is the
  // shape a generator actually emits — capture "now", pass it in, assert it
  // came back — and it is the reason the rule needs a second pass rather than
  // another line regex.
  it('flags a value tainted by Date.now() and asserted later', () => {
    const findings = soundness(
      'a.test.ts',
      [
        `import { it, expect } from 'vitest';`,
        `it('round-trips the stamp', () => {`,
        `  const stamp = Date.now();`,
        `  const row = save({ createdAt: stamp });`,
        `  expect(row.createdAt).toBe(stamp);`,
        `});`,
        ``,
      ].join('\n'),
    );
    const tainted = findings.filter((f) => f.rule === 'SOUND-001');
    expect(tainted).toHaveLength(1);
    expect(tainted[0]!.message).toContain('stamp');
    // Reported where the value is PINNED, not where it was born — that is the
    // line an author has to change.
    expect(tainted[0]!.line).toBe(5);
  });

  it('flags a value tainted by Math.random() and asserted later', () => {
    const findings = soundness(
      'a.test.ts',
      [
        `import { it, expect } from 'vitest';`,
        `it('round-trips the pick', () => {`,
        `  const pick = Math.random();`,
        `  expect(choose(pick)).toEqual(pick);`,
        `});`,
        ``,
      ].join('\n'),
    );
    expect(rules(findings)).toContain('SOUND-001');
  });

  it('flags a python variable tainted by datetime.now()', () => {
    const findings = soundness(
      'test_a.py',
      [
        `def test_round_trips():`,
        `    stamp = datetime.now()`,
        `    row = save(created_at=stamp)`,
        `    assert row.created_at == stamp`,
        ``,
      ].join('\n'),
    );
    expect(rules(findings)).toContain('SOUND-001');
  });

  it('does not flag a tainted value that is never asserted', () => {
    // A random seed used only as INPUT is fine; the defect is pinning it as an
    // EXPECTATION. Flagging every use would make the rule unactionable in any
    // test that legitimately needs a unique fixture name.
    const findings = soundness(
      'a.test.ts',
      [
        `import { it, expect } from 'vitest';`,
        `it('writes to a unique dir', () => {`,
        `  const dir = mkdtempSync('/tmp/x');`,
        `  writeFileSync(dir + '/a', 'hi');`,
        `  expect(readFileSync(dir + '/a', 'utf-8')).toBe('hi');`,
        `});`,
        ``,
      ].join('\n'),
    );
    expect(rules(findings)).not.toContain('SOUND-001');
  });

  it('does not read a non-deterministic call out of string data', () => {
    // The linter's own suites carry the patterns they test as fixture strings.
    // Every rule in this file has hit this; SOUND-001 must not reintroduce it.
    const findings = soundness(
      'a.test.ts',
      [
        `import { it, expect } from 'vitest';`,
        `it('lints a fixture', () => {`,
        `  const src = 'expect(x).toBe(crypto.randomUUID());';`,
        `  expect(lint(src)).toHaveLength(1);`,
        `});`,
        ``,
      ].join('\n'),
    );
    expect(rules(findings)).not.toContain('SOUND-001');
  });

  // Measured, not theorised: pointing the first cut of this rule at canary's own
  // suite produced 3 findings of exactly this shape (`fs-glob.test.ts`,
  // `leak-gate-denominator.test.ts`, `main-deps-defaults.test.ts`) and all 3
  // were wrong. A temp directory is non-deterministic BY DESIGN and the
  // assertion is about the relationship between input and output, not about the
  // path's value -- so the path family is a direct-mode source only. Pinning
  // `toBe(mkdtempSync(...))` is still nonsense and still caught.
  it.each(['mkdtempSync(join(tmpdir(), "x"))', 'os.tmpdir()'])(
    'does not taint through %s — a temp path is relational, not an answer',
    (source) => {
      const findings = soundness(
        'a.test.ts',
        [
          `import { it, expect } from 'vitest';`,
          `it('resolves under the root', () => {`,
          `  const tmp = ${source};`,
          `  expect(globDirs(tmp, '*')).toEqual([join(tmp, 'apps')]);`,
          `});`,
          ``,
        ].join('\n'),
      );
      expect(rules(findings)).not.toContain('SOUND-001');
    },
  );

  // Also measured: the first cut reported 6 findings inside THIS file, because
  // `blankStrings` only ever knew `'` and `"`. Every fixture here is a backtick
  // template literal, so the linter read its own test data as live code -- the
  // exact "data must never act as code" defect the module's own docstring cites
  // (#499, #495). Any suite that carries the patterns it tests as template
  // literals has it, which in a modern TS repo is most of them.
  it('does not read a non-deterministic call out of a template literal', () => {
    const findings = soundness(
      'a.test.ts',
      [
        `import { it, expect } from 'vitest';`,
        `it('lints a fixture', () => {`,
        '  const src = `const stamp = Date.now();`;',
        '  const pinned = `expect(row.at).toBe(stamp);`;',
        `  expect(lint(src + pinned)).toHaveLength(1);`,
        `});`,
        ``,
      ].join('\n'),
    );
    expect(rules(findings)).not.toContain('SOUND-001');
  });

  it('still reads code out of a template literal substitution', () => {
    // Blanking must not go so far that `${...}` -- which IS live code -- goes
    // dark. Over-blanking is the abstention shape one layer inside the linter.
    const findings = soundness(
      'a.test.ts',
      [
        `import { it, expect } from 'vitest';`,
        `it('pins a stamp', () => {`,
        `  const stamp = Date.now();`,
        '  expect(row.label).toBe(`at ${stamp}`);',
        `});`,
        ``,
      ].join('\n'),
    );
    expect(rules(findings)).toContain('SOUND-001');
  });

  it('does not flag a pinned, deterministic value', () => {
    const findings = soundness(
      'a.test.ts',
      [
        `import { it, expect } from 'vitest';`,
        `it('round-trips a fixed stamp', () => {`,
        `  const stamp = new Date('2024-01-01T00:00:00Z').getTime();`,
        `  expect(save({ at: stamp }).at).toBe(stamp);`,
        `});`,
        ``,
      ].join('\n'),
    );
    expect(rules(findings)).not.toContain('SOUND-001');
  });
});

describe('SOUND-002 — exact equality against an inexact fractional literal', () => {
  it.each([
    'expect(rate).toBe(0.1);',
    'expect(rate).toEqual(1.1);',
    'expect(rate).toStrictEqual(33.3);',
  ])('flags %s', (line) => {
    const findings = soundness(
      'a.test.ts',
      `import { it, expect } from 'vitest';\nit('rate', () => {\n  ${line}\n});\n`,
    );
    expect(rules(findings)).toContain('SOUND-002');
  });

  it('flags pytest exact equality on an inexact float', () => {
    const findings = soundness(
      'test_a.py',
      `def test_rate():\n    assert rate == 0.3\n`,
    );
    expect(rules(findings)).toContain('SOUND-002');
  });

  // The discrimination that makes this rule usable rather than noise. A binary
  // float can represent 0.5 and 0.25 exactly, so `toBe(0.5)` is a legitimate
  // contract and flagging it would train readers to ignore the rule. 0.1 and
  // 0.3 have no exact binary form, so exact equality on them is a bet on the
  // arithmetic path that produced the value.
  it.each(['0.5', '0.25', '0.75', '2.5', '1.125'])(
    'exempts %s — exactly representable in binary',
    (lit) => {
      const findings = soundness(
        'a.test.ts',
        `import { it, expect } from 'vitest';\nit('rate', () => {\n  expect(rate).toBe(${lit});\n});\n`,
      );
      expect(rules(findings)).not.toContain('SOUND-002');
    },
  );

  it('exempts toBeCloseTo — the fix, not the defect', () => {
    const findings = soundness(
      'a.test.ts',
      `import { it, expect } from 'vitest';\nit('rate', () => {\n  expect(rate).toBeCloseTo(0.1);\n});\n`,
    );
    expect(rules(findings)).not.toContain('SOUND-002');
  });

  it('exempts pytest.approx', () => {
    const findings = soundness(
      'test_a.py',
      `def test_rate():\n    assert rate == pytest.approx(0.3)\n`,
    );
    expect(rules(findings)).not.toContain('SOUND-002');
  });

  it('does not flag an integer expectation', () => {
    const findings = soundness(
      'a.test.ts',
      `import { it, expect } from 'vitest';\nit('count', () => {\n  expect(count).toBe(42);\n});\n`,
    );
    expect(rules(findings)).not.toContain('SOUND-002');
  });

  it('does not read a float out of a version string', () => {
    const findings = soundness(
      'a.test.ts',
      `import { it, expect } from 'vitest';\nit('version', () => {\n  expect(v).toBe('1.1');\n});\n`,
    );
    expect(rules(findings)).not.toContain('SOUND-002');
  });
});

describe('SOUND-003 — a ratio pinned to an integer leaves the contract unpinned', () => {
  it('flags a division asserted equal to an integer', () => {
    const findings = soundness(
      'a.test.ts',
      [
        `import { it, expect } from 'vitest';`,
        `it('averages', () => {`,
        `  expect(total / count).toBe(2);`,
        `});`,
        ``,
      ].join('\n'),
    );
    const f = findings.filter((x) => x.rule === 'SOUND-003');
    expect(f).toHaveLength(1);
    expect(f[0]!.suggestion).toMatch(/fractional/i);
  });

  it('flags the pytest form', () => {
    const findings = soundness(
      'test_a.py',
      `def test_averages():\n    assert total / count == 2\n`,
    );
    expect(rules(findings)).toContain('SOUND-003');
  });

  it('does not flag a ratio pinned to a fractional expectation', () => {
    // Pinning `2.5` states the contract: the operation does NOT floor. That is
    // exactly the decision SOUND-003 asks for, so it must go quiet.
    const findings = soundness(
      'a.test.ts',
      `import { it, expect } from 'vitest';\nit('averages', () => {\n  expect(total / count).toBeCloseTo(2.5);\n});\n`,
    );
    expect(rules(findings)).not.toContain('SOUND-003');
  });

  it('does not read a division out of a path or a regex', () => {
    const findings = soundness(
      'a.test.ts',
      [
        `import { it, expect } from 'vitest';`,
        `it('resolves', () => {`,
        `  expect(resolve('a/b/c')).toBe(3);`,
        `  expect(count).toBe(3);`,
        `});`,
        ``,
      ].join('\n'),
    );
    expect(rules(findings)).not.toContain('SOUND-003');
  });
});

describe('soundness scanning cannot silently abstain', () => {
  // The rules are new, so the "did they run at all" question has no history to
  // lean on. An empty file must produce zero SOUND findings AND zero of
  // everything else — i.e. the honest empty answer — while a file with a known
  // planted defect per rule must produce exactly that rule. Asserting only the
  // first half is how a scanner that matches nothing looks clean.
  it('finds nothing in an empty test file', () => {
    expect(soundness('a.test.ts', '')).toEqual([]);
  });

  it.each([
    ['SOUND-001', `it('a', () => { expect(x).toBe(crypto.randomUUID()); });`],
    ['SOUND-002', `it('a', () => { expect(x).toBe(0.1); });`],
    ['SOUND-003', `it('a', () => { expect(a / b).toBe(2); });`],
  ])('plants a known %s offender and finds it', (rule, body) => {
    expect(rules(soundness('a.test.ts', `${body}\n`))).toContain(rule);
  });

  it('keeps every soundness rule at warning severity', () => {
    // Landing advisory is a deliberate contract, not an oversight: `review-test`
    // exits 1 only on `critical`, so a repo's gate cannot go red the day these
    // rules ship. Promotion (#477) is where soundness blocks.
    const findings = soundness(
      'a.test.ts',
      [
        `it('a', () => { expect(x).toBe(crypto.randomUUID()); });`,
        `it('b', () => { expect(y).toBe(0.1); });`,
        `it('c', () => { expect(a / b).toBe(2); });`,
        ``,
      ].join('\n'),
    );
    expect(findings.length).toBeGreaterThanOrEqual(3);
    for (const f of findings) expect(f.severity).toBe('warning');
  });
});
