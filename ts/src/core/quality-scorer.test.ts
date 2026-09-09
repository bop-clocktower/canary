import { describe, expect, it } from 'vitest';

import { QualityScorer, isAssertionFreeTest } from './quality-scorer.js';

const scorer = new QualityScorer();

describe('isAssertionFreeTest', () => {
  it('flags a pytest test that asserts nothing', () => {
    const code = 'def test_widget():\n    w = make_widget()\n    print(w)';
    expect(isAssertionFreeTest(code, 'pytest')).toBe(true);
  });

  it('does not flag a pytest test with an assertion', () => {
    const code =
      'def test_widget():\n    w = make_widget()\n    assert w.size == 1';
    expect(isAssertionFreeTest(code, 'pytest')).toBe(false);
  });

  it('flags a vitest test that asserts nothing', () => {
    const code =
      "it('builds a widget', () => {\n  const w = makeWidget()\n  console.log(w)\n})";
    expect(isAssertionFreeTest(code, 'vitest')).toBe(true);
  });

  it('does not flag a vitest test with expect(', () => {
    const code =
      "it('builds a widget', () => {\n  expect(makeWidget()).toBe(1)\n})";
    expect(isAssertionFreeTest(code, 'vitest')).toBe(false);
  });

  it('requires a test function — helper-only code is not flagged', () => {
    const code = 'def make_widget():\n    return 1';
    expect(isAssertionFreeTest(code, 'pytest')).toBe(false);
  });

  it('does not flag a snapshot-style assertion as weak', () => {
    const code = 'def test_snap():\n    assert snapshot == golden';
    expect(isAssertionFreeTest(code, 'pytest')).toBe(false);
  });

  it('falls back to pytest patterns for an unknown framework', () => {
    const code = 'def test_x():\n    do_thing()';
    expect(isAssertionFreeTest(code, 'unknown-fw')).toBe(true);
  });

  // #419: the ASSERTIONS maps were broadened in the shipped Python; these
  // custom-helper / node:assert / chai forms must count as assertions so they
  // are NOT reported weak (they were false positives before the sync).
  it('counts a pytest custom assert* helper call as an assertion', () => {
    const code = 'def test_x():\n    assert_valid(x)';
    expect(isAssertionFreeTest(code, 'pytest')).toBe(false);
  });

  it('counts vitest node:assert `assert.equal(...)` as an assertion', () => {
    const code = "it('x', () => {\n  assert.equal(a, b)\n})";
    expect(isAssertionFreeTest(code, 'vitest')).toBe(false);
  });

  it('counts vitest chai `x.should.equal(...)` as an assertion', () => {
    const code = "it('x', () => {\n  result.should.equal(1)\n})";
    expect(isAssertionFreeTest(code, 'vitest')).toBe(false);
  });

  it('counts vitest bare `assert(...)` as an assertion', () => {
    const code = "it('x', () => {\n  assert(a === b)\n})";
    expect(isAssertionFreeTest(code, 'vitest')).toBe(false);
  });

  // #738. `assert*`-named helpers counted for pytest but the JS/TS naming
  // convention for the same thing is `expect*`, and it had no counterpart — so
  // a Playwright suite that factors its assertions into `expectRouteTestId()`
  // helpers (the pattern Playwright's own docs recommend) had every added test
  // reported as asserting nothing. The rationale on the pytest line is
  // language-agnostic; only its spelling was not.
  it('counts a playwright expect* helper call as an assertion', () => {
    const code =
      "test('renders', async ({ page }) => {\n" +
      "  await gotoAppRoute(page, '/app/benefits/1')\n" +
      "  await expectRouteTestId(page, 'benefit-detail')\n" +
      '})';
    expect(isAssertionFreeTest(code, 'playwright')).toBe(false);
  });

  it('counts a vitest expect* helper call as an assertion', () => {
    const code = "it('x', () => {\n  expectValidWidget(makeWidget())\n})";
    expect(isAssertionFreeTest(code, 'vitest')).toBe(false);
  });

  it('still matches a plain expect( — the widening is additive', () => {
    // `\w*` is zero-width-matchable, so nothing that counted before stops
    // counting. Asserted rather than assumed, because a regex edit that
    // silently narrowed this would turn every correct test into a finding.
    const code = "test('x', async ({ page }) => {\n  await expect(el)\n})";
    expect(isAssertionFreeTest(code, 'playwright')).toBe(false);
  });

  it('still flags a playwright test that really asserts nothing', () => {
    // The precision cost is bounded: widening the NAME pattern must not make
    // the rule unable to fire. A test that only navigates is still weak.
    const code =
      "test('renders', async ({ page }) => {\n  await page.goto('/')\n})";
    expect(isAssertionFreeTest(code, 'playwright')).toBe(true);
  });
});

describe('QualityScorer edge branches', () => {
  it('k6 uses the "check" label and check-based counting', () => {
    const code = `
      export default function () {
        check(res, { 'status is 200': (r) => r.status === 200 });
        check(res, { 'body ok': (r) => r.body.length > 0 });
      }`;
    const r = scorer.score(code, 'k6');
    expect(r.details[0]).toMatch(/check/);
  });

  it('flags random and timestamp flakiness signals', () => {
    const code = `def test_x():\n    v = random.random()\n    t = datetime.now()\n    assert v < t`;
    const r = scorer.score(code, 'pytest');
    expect(r.details).toContain('Non-deterministic random values detected');
    expect(r.details).toContain('Timestamp-dependent assertions detected');
    expect(r.flakiness_risk).toBe(75); // 100 - 15 - 10
  });

  it('caps hardcoded-wait deduction at 40', () => {
    const code = `def test_x():\n    time.sleep(1)\n    time.sleep(2)\n    time.sleep(3)\n    assert True`;
    const r = scorer.score(code, 'pytest');
    expect(r.flakiness_risk).toBe(60); // 100 - min(40, 3*20)
  });

  it('reports no flakiness signals when clean', () => {
    const code = `def test_x():\n    assert 1 + 1 == 2`;
    const r = scorer.score(code, 'pytest');
    expect(r.details).toContain('No flakiness signals detected');
    expect(r.flakiness_risk).toBe(100);
  });

  it('detects magic numbers, caps findings at 10, and penalises the score', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `x${i} = ${i + 3000}`);
    const code = `def test_many():\n    ` + lines.join('\n    ');
    const r = scorer.score(code, 'pytest');
    expect(r.magic_numbers).toBe(10); // capped
    expect(r.details.some((d) => d.includes('magic number'))).toBe(true);
  });

  it('grades an empty suite as F', () => {
    const r = scorer.score('# nothing here\n', 'pytest');
    expect(r.grade).toBe('F');
    expect(r.coverage_breadth).toBe(0);
  });

  it('allows HTTP status codes and small ints as non-magic', () => {
    const code = `def test_ok():\n    assert resp.status == 404\n    assert len(items) == 2`;
    const r = scorer.score(code, 'pytest');
    expect(r.magic_numbers).toBe(0);
  });
});
