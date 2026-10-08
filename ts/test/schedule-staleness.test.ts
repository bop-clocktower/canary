/**
 * Contract tests for `scripts/schedule-staleness.mjs`, the weekly-cron watchdog.
 *
 * Two Monday crons (`harness-architecture.yml`, `arch-snapshot.yml`) stopped
 * firing after 2026-09-07 and nothing went red for four weeks. A schedule that
 * never fires never fails, so a missing run makes no sound at all. This
 * watchdog makes that absence a red job.
 *
 * Exit codes follow the repo's gate convention (#508, ADR 0009):
 *   0 = every watched schedule fired within the window
 *   1 = at least one is stale or disabled
 *   2 = usage error
 *   3 = ABSTAINED — no schedule run on record, the API was unreachable, or
 *       nothing was checked. Never reported as fresh.
 *
 * The GitHub API is injected, so no test reaches the network. The API-error
 * path is also exercised with a binary that does not exist, so the real
 * `gh`-spawning seam is covered and not only the stub.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'schedule-staleness.mjs');

type Verdict = 'fresh' | 'stale' | 'abstain';
interface Result {
  workflow: string;
  verdict: Verdict;
  reason: string;
  lastRunAt?: string;
}
type Api = (path: string) => unknown;
interface Module {
  assessSchedule: (args: {
    workflow: string;
    state: unknown;
    runs: unknown;
    now: Date;
    maxAgeDays: number;
  }) => Result;
  checkSchedules: (args: {
    repo: string;
    workflows: string[];
    maxAgeDays: number;
    now: Date;
    api: Api;
  }) => Result[];
  exitCode: (results: Result[]) => number;
  render: (results: Result[], maxAgeDays: number) => string;
  ghApi: (path: string, bin?: string) => unknown;
}

const mod = (await import(pathToFileURL(SCRIPT).href)) as Module;

const NOW = new Date('2026-10-08T12:00:00Z');
const REPO = 'acme/widgets';
const run = (created_at: string) => ({
  id: 1,
  created_at,
  html_url: `https://github.com/${REPO}/actions/runs/1`,
});

/** A fake GitHub API keyed by workflow file. */
function fakeApi(
  table: Record<string, { state?: string; runs?: unknown[] } | Error>,
): Api {
  return (path: string) => {
    const file = Object.keys(table).find((f) => path.includes(`/${f}`));
    const entry = file === undefined ? undefined : table[file];
    if (entry === undefined) throw new Error(`HTTP 404: Not Found (${path})`);
    if (entry instanceof Error) throw entry;
    if (path.includes('/runs?')) {
      const runs = entry.runs ?? [];
      return { total_count: runs.length, workflow_runs: runs };
    }
    return { state: entry.state ?? 'active' };
  };
}

describe('assessSchedule', () => {
  const base = { workflow: 'w.yml', state: 'active', now: NOW, maxAgeDays: 8 };

  it('is fresh when the last schedule run is inside the window', () => {
    const r = mod.assessSchedule({
      ...base,
      runs: [run('2026-10-05T14:59:12Z')],
    });
    expect(r.verdict).toBe('fresh');
    expect(r.lastRunAt).toBe('2026-10-05T14:59:12Z');
  });

  it('is stale when the last schedule run is older than the window', () => {
    // The real incident: last run 2026-09-07, checked a month later.
    const r = mod.assessSchedule({
      ...base,
      runs: [run('2026-09-07T11:27:00Z')],
    });
    expect(r.verdict).toBe('stale');
    expect(r.reason).toMatch(/31\.0 days ago/);
    expect(r.reason).toMatch(/max 8/);
  });

  it('treats exactly the threshold as fresh and one second past as stale', () => {
    const edge = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();
    const past = new Date(NOW.getTime() - 8 * 86_400_000 - 1000).toISOString();
    expect(mod.assessSchedule({ ...base, runs: [run(edge)] }).verdict).toBe(
      'fresh',
    );
    expect(mod.assessSchedule({ ...base, runs: [run(past)] }).verdict).toBe(
      'stale',
    );
  });

  it('abstains, never passes, when there is no schedule run on record', () => {
    const r = mod.assessSchedule({ ...base, runs: [] });
    expect(r.verdict).toBe('abstain');
    expect(r.reason).toMatch(/no schedule-event run/);
  });

  it('abstains when the runs payload is not a list', () => {
    expect(mod.assessSchedule({ ...base, runs: undefined }).verdict).toBe(
      'abstain',
    );
  });

  it('abstains on an unreadable run timestamp rather than guessing', () => {
    const r = mod.assessSchedule({ ...base, runs: [run('not-a-date')] });
    expect(r.verdict).toBe('abstain');
    expect(r.reason).toMatch(/timestamp/);
  });

  it('is stale when the workflow is disabled, however recent its last run', () => {
    const r = mod.assessSchedule({
      ...base,
      state: 'disabled_inactivity',
      runs: [run('2026-10-07T09:00:00Z')],
    });
    expect(r.verdict).toBe('stale');
    expect(r.reason).toMatch(/disabled_inactivity/);
  });
});

describe('checkSchedules', () => {
  const args = { repo: REPO, maxAgeDays: 8, now: NOW };

  it('reports each workflow with its own verdict', () => {
    const results = mod.checkSchedules({
      ...args,
      workflows: ['fresh.yml', 'stale.yml'],
      api: fakeApi({
        'fresh.yml': { runs: [run('2026-10-05T14:59:12Z')] },
        'stale.yml': { runs: [run('2026-09-07T13:04:47Z')] },
      }),
    });
    expect(results.map((r) => [r.workflow, r.verdict])).toEqual([
      ['fresh.yml', 'fresh'],
      ['stale.yml', 'stale'],
    ]);
  });

  it('queries only schedule-event runs, so a push run cannot mask a dead cron', () => {
    const seen: string[] = [];
    mod.checkSchedules({
      ...args,
      workflows: ['w.yml'],
      api: (path) => {
        seen.push(path);
        return fakeApi({ 'w.yml': { runs: [] } })(path);
      },
    });
    const runsPath = seen.find((p) => p.includes('/runs'));
    expect(runsPath).toBe(
      `repos/${REPO}/actions/workflows/w.yml/runs?event=schedule&per_page=1`,
    );
  });

  it('abstains with the API message when the API errors', () => {
    const [r] = mod.checkSchedules({
      ...args,
      workflows: ['w.yml'],
      api: fakeApi({ 'w.yml': new Error('HTTP 403: Resource not accessible') }),
    });
    expect(r!.verdict).toBe('abstain');
    expect(r!.reason).toMatch(/HTTP 403: Resource not accessible/);
  });

  it('abstains when the gh binary itself cannot be run', () => {
    const [r] = mod.checkSchedules({
      ...args,
      workflows: ['w.yml'],
      api: (path) => mod.ghApi(path, 'canary-no-such-gh-binary'),
    });
    expect(r!.verdict).toBe('abstain');
    expect(r!.reason).toMatch(/GitHub API/);
  });
});

describe('exitCode', () => {
  const r = (verdict: Verdict): Result => ({
    workflow: 'w',
    verdict,
    reason: '',
  });

  it('is 0 only when every workflow is fresh', () => {
    expect(mod.exitCode([r('fresh'), r('fresh')])).toBe(0);
  });

  it('is 1 when anything is stale, even alongside an abstention', () => {
    expect(mod.exitCode([r('fresh'), r('stale'), r('abstain')])).toBe(1);
  });

  it('is 3 when something abstained and nothing is stale', () => {
    expect(mod.exitCode([r('fresh'), r('abstain')])).toBe(3);
  });

  it('is 3 for a zero denominator — checking nothing is not a pass', () => {
    expect(mod.exitCode([])).toBe(3);
  });
});

describe('render', () => {
  it('states the denominator and names each verdict', () => {
    const out = mod.render(
      [
        { workflow: 'a.yml', verdict: 'fresh', reason: 'ok' },
        { workflow: 'b.yml', verdict: 'stale', reason: 'old' },
        { workflow: 'c.yml', verdict: 'abstain', reason: 'none' },
      ],
      8,
    );
    expect(out).toMatch(/checked 3 workflow/);
    expect(out).toMatch(/1 fresh, 1 stale, 1 abstained/);
    expect(out).toMatch(/STALE\s+b\.yml/);
    expect(out).toMatch(/ABSTAINED\s+c\.yml/);
  });

  it('says ABSTAINED and gives the first fix step when nothing was checked', () => {
    const out = mod.render([], 8);
    expect(out).toMatch(/ABSTAINED/);
    expect(out).toMatch(/Fix:/);
  });
});

describe('CLI', () => {
  it('exits 2 with usage when no workflow is named', () => {
    const r = runCapture(process.execPath, [SCRIPT, '--repo', REPO]);
    expect(r.status).toBe(2);
    expect(r.output).toMatch(/usage:/);
  });

  it('exits 2 on a non-positive max age', () => {
    const r = runCapture(process.execPath, [
      SCRIPT,
      '--repo',
      REPO,
      '--max-age-days',
      '0',
      'w.yml',
    ]);
    expect(r.status).toBe(2);
    expect(r.output).toMatch(/usage:/);
  });

  it('exits 2 when no repo is given and GITHUB_REPOSITORY is unset', () => {
    const env = { ...process.env };
    delete env['GITHUB_REPOSITORY'];
    const r = runCapture(process.execPath, [SCRIPT, 'w.yml'], { env });
    expect(r.status).toBe(2);
  });
});

/**
 * The watchdog is only worth having if it cannot go dark with what it watches.
 * These pin the wiring, so the next edit to the workflow cannot quietly put it
 * back on the scheduler alone.
 */
describe('schedule-watchdog.yml wiring', () => {
  const WORKFLOWS = join(REPO_ROOT, '.github', 'workflows');
  const WATCHDOG = 'schedule-watchdog.yml';
  type Job = { steps?: { run?: string }[] };
  type Wf = {
    on?: Record<string, unknown>;
    true?: Record<string, unknown>;
    jobs?: Record<string, Job>;
  };
  const read = (f: string) =>
    loadYaml(readFileSync(join(WORKFLOWS, f), 'utf8')) as Wf;
  // js-yaml may read a bare `on:` key as boolean true (YAML 1.1).
  const triggers = (wf: Wf) => wf.on ?? wf.true ?? {};
  const cronsOf = (wf: Wf) =>
    ((triggers(wf)['schedule'] ?? []) as { cron: string }[]).map((s) => s.cron);

  const watchdog = read(WATCHDOG);
  const command = Object.values(watchdog.jobs ?? {})
    .flatMap((j) => j.steps ?? [])
    .map((s) => s.run ?? '')
    .find((r) => r.includes('schedule-staleness.mjs'));

  /** Every workflow in the tree that declares a cron, derived, not listed. */
  const scheduled = readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((file) => ({ file, crons: cronsOf(read(file)) }))
    .filter((s) => s.crons.length > 0);
  const watched = scheduled.filter((s) => s.file !== WATCHDOG);

  it('runs on push to main, which does not go through the cron scheduler', () => {
    const push = triggers(watchdog)['push'] as
      { branches?: string[] } | undefined;
    expect(push?.branches).toContain('main');
  });

  it('has no pull-request trigger, so a scheduler fault cannot block a PR', () => {
    expect(triggers(watchdog)['pull_request']).toBeUndefined();
    expect(triggers(watchdog)['pull_request_target']).toBeUndefined();
  });

  it('watches every other workflow that declares a cron', () => {
    expect(command).toBeDefined();
    // Zero denominator guard: the incident's own two crons must be found.
    expect(watched.map((s) => s.file)).toEqual(
      expect.arrayContaining(['harness-architecture.yml', 'arch-snapshot.yml']),
    );
    for (const { file } of watched) expect(command).toContain(file);
  });

  it('keeps every schedule in the repo off the top of the hour', () => {
    const crons = scheduled.flatMap((s) => s.crons);
    expect(crons.length).toBeGreaterThan(watched.length - 1);
    for (const cron of crons) expect(cron.split(/\s+/)[0]).not.toBe('0');
  });

  it('keeps the arch snapshot after the validation run', () => {
    const at = (file: string) => {
      const [min, hour] = watched
        .find((s) => s.file === file)!
        .crons[0]!.split(/\s+/)
        .map(Number);
      return hour! * 60 + min!;
    };
    expect(at('arch-snapshot.yml')).toBeGreaterThan(
      at('harness-architecture.yml'),
    );
  });
});
