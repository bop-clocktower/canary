import { describe, expect, it } from 'vitest';

import { QualityScorer } from './quality-scorer.js';

const scorer = new QualityScorer();

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
