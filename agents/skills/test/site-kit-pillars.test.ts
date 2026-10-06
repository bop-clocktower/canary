// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Pillars } from '../lib/site-kit/panels/pillars.js';
import { assessment, live, mount, siteFeed } from './site-kit-helpers.js';

const notAssessed = assessment({
  metric: 'coverage-depth',
  status: 'not-assessed',
  value: null,
  reason: 'no coverage report was found',
  evidence: { tier: null, denominator: null },
});

describe('<canary-pillars> (criterion 20, D6)', () => {
  it('renders a not-assessed reason as text and announces it', () => {
    const root = mount(Pillars, siteFeed({ assessments: [notAssessed] }));
    const card = root.querySelector('li[data-state="not-assessed"]')!;
    expect(card.textContent).toContain('no coverage report was found');
    expect(live(root)).toContain(
      'coverage-depth: not assessed (no coverage report was found)',
    );
  });

  it('renders a measured pillar with its value, evidence tier and denominator', () => {
    const root = mount(Pillars, siteFeed({ assessments: [assessment()] }));
    const card = root.querySelector('li[data-state="healthy"]')!;
    expect(card.textContent).toContain('1.2%');
    expect(card.textContent).toContain('evidence: heuristic over 30');
    expect(live(root)).toBe('');
  });

  it('renders an observed duration in ms and an unknown tier as —', () => {
    const a = assessment({
      metric: 'suite-runtime',
      status: 'observed',
      value: 1234.4,
      unit: 'ms',
      evidence: { tier: null, denominator: null },
    });
    const card = mount(Pillars, siteFeed({ assessments: [a] })).querySelector(
      'li',
    )!;
    expect(card.textContent).toContain('1234 ms');
    expect(card.textContent).toContain('evidence: —');
  });

  it('shows every pillar side by side and no composite (D6)', () => {
    const metrics = [
      'coverage-depth',
      'flakiness',
      'assertion-quality',
      'critical-paths',
      'suite-runtime',
    ];
    const root = mount(
      Pillars,
      siteFeed({
        assessments: metrics.map((metric) => assessment({ metric })),
      }),
    );
    expect(root.querySelectorAll('li')).toHaveLength(5);
    expect(root.textContent).not.toMatch(/score|overall|average|\/\s*10\b/i);
  });

  it('abstains with no assessments', () => {
    expect(live(mount(Pillars, siteFeed()))).toBe(
      'No assessments in the feed.',
    );
  });
});
