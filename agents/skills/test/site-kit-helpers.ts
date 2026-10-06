// Builders for site-kit tests (#1151 phase 3). Every builder produces a record
// the contract validator accepts (asserted in site-kit-model.test.ts), so a
// panel test never passes on a feed no producer could write.

export const SCOPE = { id: 'canary', env: 'ci' };
export const NOW = Date.parse('2026-10-06T12:00:00Z');
export const DAY = 86_400_000;
export const iso = (ms: number) => new Date(ms).toISOString();

const STATUSES = [
  'passed',
  'failed',
  'flaky',
  'skipped',
  'timed_out',
  'interrupted',
] as const;

type Result = Record<string, unknown> & { status: string };
type Totals = Record<(typeof STATUSES)[number] | 'total', number>;

export const result = (over: Record<string, unknown> = {}): Result => ({
  title: 't',
  file: 'test/a.test.ts',
  status: 'passed',
  duration_ms: 1,
  retries: 0,
  area: null,
  tags: [],
  error: null,
  ...over,
});

const totalsOf = (list: Result[]): Totals => ({
  ...(Object.fromEntries(
    STATUSES.map((s) => [s, list.filter((r) => r.status === s).length]),
  ) as Record<(typeof STATUSES)[number], number>),
  total: list.length,
});

interface RunOver {
  id?: string;
  suite?: string;
  scope?: { id: string; env: string };
  finished?: string;
  status?: 'passed' | 'failed' | 'cancelled';
  shard?: { index: number; total: number } | null;
  totals?: Partial<Totals>;
  results?: Result[] | null;
}

/** A canary.run/1 record; totals derive from `results` when it is a list. */
export function runRecord(over: RunOver = {}) {
  const finished = over.finished ?? iso(NOW - DAY);
  const results = over.results ?? null;
  const totals = results
    ? totalsOf(results)
    : {
        passed: 1,
        failed: 0,
        flaky: 0,
        skipped: 0,
        timed_out: 0,
        interrupted: 0,
        total: 1,
        ...over.totals,
      };
  return {
    contract: 'canary.run/1',
    scope: over.scope ?? SCOPE,
    producer: { name: 'test', version: '0', channel: 'ci' },
    run: {
      id: over.id ?? 'r1',
      suite: over.suite ?? 'ts-engine',
      branch: 'main',
      commit_sha: null,
      started_at: iso(Date.parse(finished) - 60_000),
      finished_at: finished,
      ci_url: null,
      status: over.status ?? 'passed',
      shard: over.shard ?? null,
    },
    totals,
    results,
    collected: null,
  };
}

export const assessment = (over: Record<string, unknown> = {}) => ({
  contract: 'canary.assessment/1',
  scope: SCOPE,
  source: 'canary.ci-ready',
  metric: 'flakiness',
  status: 'healthy',
  value: 0.012,
  unit: 'ratio',
  reason: null,
  evidence: { tier: 'heuristic', denominator: 30 },
  observed_at: iso(NOW - DAY),
  sources: ['history-v2.jsonl'],
  verified_by: null,
  verified_at: null,
  ...over,
});

export const registerRow = (over: Record<string, unknown> = {}) => ({
  scope: SCOPE,
  title: 't',
  file: 'test/a.test.ts',
  kind: 'skipped',
  reason: 'flaky on CI',
  recorded_at: iso(NOW - 10 * DAY),
  commit: 'abc1234',
  cause: null,
  issue: null,
  ...over,
});

export const siteFeed = (over: Record<string, unknown> = {}) => ({
  contract: 'canary.site/1',
  generated_at: iso(NOW - 3_600_000),
  scopes: [SCOPE],
  suites: null,
  runs: [],
  flaky: [],
  assessments: [],
  register: [],
  ...over,
});

let tags = 0;
type Mounted = HTMLElement & { now: () => number; feed: unknown };

/**
 * Defines `cls` under a fresh tag (one constructor cannot back two tags, so it
 * is subclassed), mounts it with a pinned clock, and sets `feed` unless it is
 * undefined. Returns the panel's shadow root.
 */
export function mount(
  cls: CustomElementConstructor,
  feed?: unknown,
  now = NOW,
): ShadowRoot {
  const tag = `test-panel-${++tags}`;
  customElements.define(tag, class extends cls {});
  const node = document.createElement(tag) as Mounted;
  node.now = () => now;
  document.body.append(node);
  if (feed !== undefined) node.feed = feed;
  return node.shadowRoot!;
}

/** The panel's live region text: where every abstention must land. */
export const live = (root: ShadowRoot) =>
  root.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? '';
