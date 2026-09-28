/** Text rendering for `canary history gaps` (#610). */
import { describe, expect, it } from 'vitest';

import type { GapReport } from '../src/analysis/clocktower/gaps.js';
import {
  renderAbstention,
  renderGapReport,
} from '../src/analysis/clocktower/render.js';

const REPORT: GapReport = {
  runs: 2,
  tests: 12,
  consumers: [
    {
      id: 'screech',
      surface: 'canary-screech, history timeline',
      status: 'fed',
      coverage: [{ field: 'branch', scope: 'run', carried: 2, applicable: 2 }],
    },
    {
      id: 'area-health',
      surface: 'analyze area-health',
      status: 'dark',
      coverage: [{ field: 'area', scope: 'test', carried: 0, applicable: 12 }],
    },
    {
      id: 'failure-categories',
      surface: 'analyze spikes',
      status: 'partial',
      coverage: [
        {
          field: 'failure_category',
          scope: 'failed-test',
          carried: 3,
          applicable: 4,
        },
      ],
    },
    {
      id: 'order-ttff',
      surface: 'canary order --report (TTFF)',
      status: 'dark',
      optIn: '--order-plan',
      coverage: [{ field: 'order', scope: 'run', carried: 0, applicable: 2 }],
    },
    {
      id: 'rewind',
      surface: 'canary rewind',
      status: 'unmeasured',
      coverage: [
        { field: 'start_index', scope: 'test', carried: 0, applicable: 0 },
      ],
    },
  ],
};

const text = renderGapReport(REPORT, { path: 'h.jsonl' });

describe('renderGapReport', () => {
  it('renders the path, run count and test count in the header', () => {
    expect(text.split('\n')[0]).toContain('h.jsonl: 2 run(s), 12 test(s)');
  });

  it('renders each requirement as carried/applicable with its scope unit', () => {
    expect(text).toContain('area: 0/12 tests');
    expect(text).toContain('failure_category: 3/4 failed tests');
    expect(text).toContain('branch: 2/2 runs');
  });

  it('renders each consumer with its status and surface', () => {
    expect(text).toMatch(/screech: fed .* canary-screech, history timeline/);
    expect(text).toMatch(/area-health: dark .* analyze area-health/);
    expect(text).toMatch(/failure-categories: partial /);
  });

  it('labels a dark opt-in consumer with the flag that feeds it', () => {
    expect(text).toContain(
      'order-ttff: dark (fed only by `history record --order-plan`)',
    );
  });

  it('labels an unmeasured consumer as having no applicable rows', () => {
    expect(text).toContain('rewind: unmeasured (no applicable rows)');
  });
});

describe('renderAbstention', () => {
  it('names the reason and every consumer dark by abstention', () => {
    const out = renderAbstention('store not found: x.jsonl', ['a', 'b']);
    expect(out).toContain('store not found: x.jsonl');
    expect(out).toContain('dark by abstention: a, b');
  });
});
