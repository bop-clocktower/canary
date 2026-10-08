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
 * No test reaches the network. The pure functions take an injected API. The
 * real `gh`-spawning seam in `ghApi` and the CLI's exit codes are driven
 * through a stub `gh` placed first on PATH, plus a binary that does not exist,
 * so the stub is not the only thing under test.
 */

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'schedule-staleness.mjs');

type Verdict = 'fresh' | 'stale' | 'abstain';
interface Result {
  workflow: string;
  verdict: Verdict;
  reason: string;
  lastRunAt?: string;
  lastRunUrl?: string;
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

/**
 * One canned answer per workflow file for the stub `gh`. `workflow` replaces
 * the workflow payload (default `{state: 'active'}`), `raw` is printed verbatim
 * for both endpoints, and a file missing from the table answers like a 404.
 */
type StubTable = Record<
  string,
  { workflow?: unknown; runs?: unknown[]; raw?: string }
>;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Writes an executable `gh` into a fresh temp dir that answers `gh api <path>`
 * from `table`, and returns that dir. This exercises the real spawn seam in
 * `ghApi` and `main()` end to end, without the network. The stub is a node
 * script with a shebang, so these tests are POSIX-only.
 */
function stubGh(table: StubTable): string {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-staleness-gh-'));
  tempDirs.push(dir);
  const tablePath = join(dir, 'table.json');
  writeFileSync(tablePath, JSON.stringify(table));
  const bin = join(dir, 'gh');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const table = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(tablePath)}, 'utf8'));
const path = process.argv[3] ?? '';
const m = /actions\\/workflows\\/([^/?]+)(\\/runs)?/.exec(path);
const entry = m ? table[m[1]] : undefined;
if (entry === undefined) {
  process.stderr.write('gh: Not Found (HTTP 404) ' + path + '\\n');
  process.exit(1);
}
if (typeof entry.raw === 'string') {
  process.stdout.write(entry.raw);
} else if (m[2]) {
  const runs = entry.runs ?? [];
  process.stdout.write(JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
} else {
  process.stdout.write(JSON.stringify('workflow' in entry ? entry.workflow : { state: 'active' }));
}
`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

const POSIX = process.platform !== 'win32';

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

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 1],
  ])(
    'abstains, not stale, when the workflow state is %s (an unreadable payload)',
    (_label, state) => {
      const r = mod.assessSchedule({
        ...base,
        state,
        runs: [run('2026-10-07T09:00:00Z')],
      });
      expect(r.verdict).toBe('abstain');
      expect(r.reason).toMatch(/unreadable workflow payload: no string state/);
      expect(r.reason).not.toMatch(/disabled/);
    },
  );
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
    expect(r!.reason).toMatch(
      /GitHub API unreachable or refused: GitHub API call failed for repos\/acme\/widgets\/actions\/workflows\/w\.yml: spawnSync canary-no-such-gh-binary /,
    );
  });

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a redirect notice', { message: 'Moved Permanently' }],
  ])(
    'abstains, not stale, when the workflow payload is %s',
    (_label, payload) => {
      const [r] = mod.checkSchedules({
        ...args,
        workflows: ['w.yml'],
        api: (path) =>
          path.includes('/runs?')
            ? { workflow_runs: [run('2026-10-07T09:00:00Z')] }
            : payload,
      });
      expect(r!.verdict).toBe('abstain');
      expect(r!.reason).toMatch(/unreadable workflow payload: no string state/);
    },
  );
});

describe.skipIf(!POSIX)('ghApi against a stub gh', () => {
  const PATH = 'repos/acme/widgets/actions/workflows/w.yml';

  it('returns the parsed payload on success', () => {
    const bin = join(stubGh({ 'w.yml': {} }), 'gh');
    expect(mod.ghApi(PATH, bin)).toEqual({ state: 'active' });
  });

  it('names the path and the API failure on a nonzero exit', () => {
    const bin = join(stubGh({}), 'gh');
    expect(() => mod.ghApi(PATH, bin)).toThrow(
      /GitHub API call failed for repos\/acme\/widgets\/actions\/workflows\/w\.yml: gh: Not Found \(HTTP 404\)/,
    );
  });

  it('abstains with an unreadable-payload label, not "unreachable", on non-JSON output', () => {
    const bin = join(
      stubGh({ 'w.yml': { raw: '<html>rate limited</html>' } }),
      'gh',
    );
    const [r] = mod.checkSchedules({
      repo: REPO,
      maxAgeDays: 8,
      now: NOW,
      workflows: ['w.yml'],
      api: (path) => mod.ghApi(path, bin),
    });
    expect(r!.verdict).toBe('abstain');
    expect(r!.reason).toMatch(
      /^unreadable payload for repos\/acme\/widgets\/actions\/workflows\/w\.yml: /,
    );
    expect(r!.reason).not.toMatch(/unreachable/);
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

  it('labels a fresh run FRESH with its run URL, and gives no fix step', () => {
    const url = `https://github.com/${REPO}/actions/runs/42`;
    const out = mod.render(
      [{ workflow: 'a.yml', verdict: 'fresh', reason: 'ok', lastRunUrl: url }],
      8,
    );
    expect(out).toMatch(/FRESH\s+a\.yml: ok/);
    expect(out).toContain(url);
    expect(out).not.toMatch(/Fix:/);
  });

  it('gives no abstention fix step when the only finding is stale', () => {
    const out = mod.render(
      [{ workflow: 'b.yml', verdict: 'stale', reason: 'old' }],
      8,
    );
    expect(out).toMatch(/STALE\s+b\.yml: old/);
    expect(out).not.toMatch(/Fix:/);
  });
});

/**
 * Runs the CLI with a stub `gh` first on PATH and GITHUB_REPOSITORY unset.
 * Every CLI test goes through this, so even a regression that skips argument
 * validation reaches the stub rather than the real GitHub API.
 */
function cli(args: string[], table: StubTable = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stubGh(table)}${delimiter}${process.env['PATH'] ?? ''}`,
  };
  delete env['GITHUB_REPOSITORY'];
  return runCapture(process.execPath, [SCRIPT, ...args], { env });
}

/** The CLI's exit code, end to end through main() and a stub `gh`. */
describe.skipIf(!POSIX)('CLI exit codes', () => {
  const runAt = (created_at: string) => ({
    runs: [
      {
        id: 7,
        created_at,
        html_url: `https://github.com/${REPO}/actions/runs/7`,
      },
    ],
  });
  const check = (table: StubTable, extra: string[] = []) =>
    cli(
      ['--repo', REPO, '--max-age-days', '8', ...extra, ...Object.keys(table)],
      table,
    );

  it('exits 0 when every schedule fired inside the window', () => {
    const fresh = new Date().toISOString();
    const r = check({ 'a.yml': runAt(fresh), 'b.yml': runAt(fresh) });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /checked 2 workflow\(s\).*2 fresh, 0 stale, 0 abstained/,
    );
  });

  it('exits 1 when the last schedule run is years old', () => {
    const r = check({ 'a.yml': runAt('2000-01-01T00:00:00Z') });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /STALE\s+a\.yml: last schedule run 2000-01-01T00:00:00Z/,
    );
  });

  it('exits 3, not 0, when there is no schedule run on record', () => {
    const r = check({ 'a.yml': { runs: [] } });
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/ABSTAINED\s+a\.yml: no schedule-event run/);
  });

  it('exits 3 for a workflow the API does not know (a 404)', () => {
    const r = cli(['--repo', REPO, '--max-age-days', '8', 'nope.yml']);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(
      /ABSTAINED\s+nope\.yml: GitHub API unreachable or refused: .*HTTP 404/,
    );
  });

  describe('--json', () => {
    const json = (table: StubTable) => {
      const r = check(table, ['--json']);
      return {
        status: r.status,
        body: JSON.parse(r.stdout) as { checked: number; abstained: boolean },
      };
    };

    it('reports abstained:true and the denominator on an abstention', () => {
      const { status, body } = json({
        'a.yml': { runs: [] },
        'b.yml': { runs: [] },
      });
      expect(status).toBe(3);
      expect(body).toMatchObject({ checked: 2, abstained: true });
    });

    it('reports abstained:false on a stale finding', () => {
      const { status, body } = json({ 'a.yml': runAt('2000-01-01T00:00:00Z') });
      expect(status).toBe(1);
      expect(body).toMatchObject({ checked: 1, abstained: false });
    });

    it('reports abstained:false when everything is fresh', () => {
      const { status, body } = json({
        'a.yml': runAt(new Date().toISOString()),
      });
      expect(status).toBe(0);
      expect(body).toMatchObject({ checked: 1, abstained: false });
    });
  });
});

describe('CLI usage errors', () => {
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

  // Every other argument is valid, so only the repo check can produce exit 2.
  // `cli()` unsets GITHUB_REPOSITORY and fronts PATH with a stub `gh`.
  it.skipIf(!POSIX)(
    'exits 2 when no repo is given and GITHUB_REPOSITORY is unset',
    () => {
      const r = cli(['--max-age-days', '8', 'w.yml']);
      expect(r.status).toBe(2);
      expect(r.output).toMatch(/repo \(OWNER\/NAME\) is required/);
    },
  );

  it.skipIf(!POSIX)('exits 2 on a malformed --repo', () => {
    const r = cli(['--repo', 'not-a-repo', '--max-age-days', '8', 'w.yml']);
    expect(r.status).toBe(2);
    expect(r.output).toMatch(/repo \(OWNER\/NAME\) is required/);
  });
});

/**
 * Whether a cron minute field can fire at minute 0, the slot GitHub's
 * scheduler drops first under load. Each comma-separated part is `*`, `n`,
 * `a-b`, or any of those with `/step`. Steps count up from the start of the
 * range, so a part reaches 0 exactly when it starts at 0 or is `*`. Anything
 * unparseable counts as reaching 0, so an odd field fails loudly, not quietly.
 */
function canMatchMinuteZero(field: string): boolean {
  return field.split(',').some((part) => {
    const range = part.split('/')[0] ?? '';
    if (range === '*') return true;
    const start = range.split('-')[0] ?? '';
    return !/^\d+$/.test(start) || Number(start) === 0;
  });
}

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
    // Exact tokens, not substrings: `snapshot.yml` must not pass for
    // `arch-snapshot.yml`.
    const tokens = (command ?? '').split(/\s+/);
    for (const { file } of watched) expect(tokens).toContain(file);
  });

  // The watchdog applies one 8-day window to every file it watches. That is
  // only right for a schedule that fires at least weekly; a monthly cron would
  // read as stale for three weeks of every four.
  it('watches only crons that fire weekly or more often', () => {
    const tooRare = watched.flatMap(({ file, crons }) =>
      crons
        .filter((cron) => {
          const [, , dom, month, dow] = cron.split(/\s+/);
          return (
            dom !== '*' || month !== '*' || !/^(\*|[0-7])$/.test(dow ?? '')
          );
        })
        .map((cron) => `${file}: '${cron}'`),
    );
    expect(
      tooRare,
      'a watched cron fires less often than weekly; the single --max-age-days 8 ' +
        'window would call it stale between runs, so per-workflow windows are needed first',
    ).toEqual([]);
  });

  describe('off the top of the hour', () => {
    it.each([
      ['0', true],
      ['00', true],
      ['*', true],
      ['*/15', true],
      ['5,0', true],
      ['0-10', true],
      ['0/20', true],
      ['x', true],
      ['30', false],
      ['5-10', false],
      ['17/20', false],
      ['19,43', false],
    ])('minute field %s can match :00 -> %s', (field, expected) => {
      expect(canMatchMinuteZero(field)).toBe(expected);
    });

    it('keeps every schedule in the repo, the watchdog included, off :00', () => {
      const crons = scheduled.flatMap((s) => s.crons);
      // Every watched cron plus the watchdog's own daily one.
      expect(scheduled.map((s) => s.file)).toContain(WATCHDOG);
      expect(crons.length).toBeGreaterThanOrEqual(watched.length + 1);
      const onTheHour = crons.filter((c) =>
        canMatchMinuteZero(c.split(/\s+/)[0] ?? ''),
      );
      expect(onTheHour).toEqual([]);
    });
  });

  // GitHub runs a `run:` step with no `shell:` as `bash -e`. Without `set +e`,
  // a red script exit kills the step before the report and the summary are
  // written: the one time the summary matters. This runs the real step body
  // under that shell with `node` stubbed to fail.
  it.skipIf(!POSIX).each([1, 3])(
    'still prints the report and writes the summary when the script exits %i',
    (exitWith) => {
      const dir = mkdtempSync(join(tmpdir(), 'schedule-watchdog-step-'));
      tempDirs.push(dir);
      const node = join(dir, 'node');
      writeFileSync(
        node,
        `#!/bin/sh\necho "STUB REPORT $*"\nexit ${exitWith}\n`,
      );
      chmodSync(node, 0o755);
      const summary = join(dir, 'summary.md');
      const r = runCapture(
        'bash',
        ['--noprofile', '--norc', '-e', '-c', command ?? 'exit 99'],
        {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}`,
            GITHUB_REPOSITORY: REPO,
            GITHUB_STEP_SUMMARY: summary,
          },
        },
      );
      expect(r.status).toBe(exitWith);
      expect(r.stdout).toMatch(/STUB REPORT .*schedule-staleness\.mjs/);
      const written = readFileSync(summary, 'utf8');
      expect(written).toMatch(/## Schedule watchdog/);
      expect(written).toMatch(/STUB REPORT/);
    },
  );

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
