/**
 * An `edited` event on a PR that is no longer open, whose head commit no OPEN
 * PR shares, skips the scan, and the required check still reports a pass
 * (#1582).
 *
 * leak-gate.yml listens for `edited` so that retargeting a PR to another base
 * re-runs the gate. GitHub also sends `edited` for a title or body edit, and
 * for edits to a PR that has already merged or closed. That run scanned the
 * PR's old head against today's denylist, and could go red on a PR nobody can
 * change any more.
 *
 * Every `edited` event on an OPEN PR still scans, base change or not: a skip
 * there would record a passing run for a head whose last real scan may have
 * been red, and a title/body edit would then turn the required check green
 * without a scan.
 *
 * The payload's `pull_request.state` is not enough on its own. The check run
 * attaches to the head COMMIT, and another open PR can share that commit
 * (open PR B from red PR A's branch, close B, edit B). A re-run of an old skip
 * run also replays its original payload after the PR was reopened. So before
 * skipping, the step asks the live API which PRs contain the head commit, and
 * skips only on a readable answer of zero open PRs. Any API error or
 * unreadable answer scans.
 *
 * The fix gates at STEP level, never with a job-level `if:`. A skipped job
 * reports "skipped" rather than "success", and the job is the only producer
 * of the required context `No removed-symbol or proprietary leaks`. A first
 * step decides `skip`, and the fetch and scan steps run only when it is not
 * `'true'`, so the job still finishes green and the context is never missing.
 *
 * The decision tests execute the decide step's own script under bash with a
 * stub event and a stub `gh` on PATH, so they check what the step does, not
 * what its text looks like.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'leak-gate.yml');

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  'continue-on-error'?: unknown;
}
interface Job {
  name?: string;
  if?: string;
  steps?: Step[];
}
interface Workflow {
  jobs: Record<string, Job>;
  concurrency?: unknown;
}

const workflow = (): Workflow =>
  loadYaml(readFileSync(WORKFLOW, 'utf8')) as Workflow;
const job = (): Job => {
  const jobs = Object.values(workflow().jobs);
  expect(jobs).toHaveLength(1);
  return jobs[0]!;
};
const steps = (): Step[] => job().steps ?? [];

const decideStep = (): Step => {
  const found = steps().filter((s) => s.id === 'decide');
  expect(found).toHaveLength(1);
  return found[0]!;
};
const fetchStep = (): Step => {
  const found = steps().filter((s) => /git fetch\b/.test(s.run ?? ''));
  expect(found).toHaveLength(1);
  return found[0]!;
};
const scanStep = (): Step => {
  const found = steps().filter((s) =>
    (s.run ?? '').includes('check_removed_symbols.mjs'),
  );
  expect(found).toHaveLength(1);
  return found[0]!;
};

/** The guard every stale-sensitive step must carry. */
const GUARD = "steps.decide.outputs.skip != 'true'";

const SHA = 'a'.repeat(40);

interface Event {
  EVENT_NAME: string;
  EVENT_ACTION?: string;
  PR_STATE?: string;
  HEAD_SHA?: string;
}

/** What the stub `gh` prints (already past its `--jq`) and how it exits. */
interface GhStub {
  out?: string;
  exit?: number;
}

/** A closed PR's `edited` event: the only shape that may skip. */
const closedEdit: Event = {
  EVENT_NAME: 'pull_request_target',
  EVENT_ACTION: 'edited',
  PR_STATE: 'closed',
  HEAD_SHA: SHA,
};

describe('the decide step classifies each event (#1582)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Run the decide step's script for one event; return status and `skip`. */
  function decide(event: Event, gh: GhStub = { out: '0\n', exit: 0 }) {
    dir = mkdtempSync(join(tmpdir(), 'leak-decide-'));
    const out = join(dir, 'github_output');
    const calls = join(dir, 'gh-calls');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const stub = join(bin, 'gh');
    writeFileSync(
      stub,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$GH_STUB_CALLS"',
        'printf "%s" "$GH_STUB_OUT"',
        'exit "$GH_STUB_EXIT"',
        '',
      ].join('\n'),
    );
    chmodSync(stub, 0o755);
    const res = spawnSync('bash', ['-e', '-c', decideStep().run!], {
      cwd: dir,
      encoding: 'utf8',
      // Unset keys arrive empty, as GitHub renders a missing property.
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: out,
        GH_STUB_CALLS: calls,
        GH_STUB_OUT: gh.out ?? '',
        GH_STUB_EXIT: String(gh.exit ?? 0),
        GH_TOKEN: 'stub-token',
        REPO: 'owner/repo',
        EVENT_ACTION: '',
        PR_STATE: '',
        HEAD_SHA: '',
        ...event,
      },
    });
    let output = '';
    try {
      output = readFileSync(out, 'utf8');
    } catch {
      // No output file: the assertions below report it as a missing value.
    }
    const values = output.match(/^skip=(.*)$/gm) ?? [];
    return {
      status: res.status,
      log: `${res.stdout}${res.stderr}`,
      values,
      skip: values.length === 1 ? values[0]!.slice('skip='.length) : undefined,
      ghCalls: existsSync(calls)
        ? readFileSync(calls, 'utf8').trim().split('\n')
        : [],
    };
  }

  it('(1) an edit to a closed PR whose head no open PR shares skips', () => {
    const r = decide(closedEdit, { out: '0\n', exit: 0 });
    expect(r.status, r.log).toBe(0);
    expect(r.values).toHaveLength(1);
    expect(r.skip).toBe('true');
    // A skip says why in the log, so a green run is not a silent abstention.
    expect(r.log).toMatch(/skip/i);
    // It asked the live API about the head COMMIT, not the PR.
    expect(r.ghCalls).toHaveLength(1);
    expect(r.ghCalls[0]).toContain(`repos/owner/repo/commits/${SHA}/pulls`);
    expect(r.ghCalls[0]).toContain('--paginate');
  });

  it('(1a) a closed PR whose head an open PR shares still scans', () => {
    // Open PR B from red PR A's branch, close B, edit B: A must not go green.
    const r = decide(closedEdit, { out: '1\n', exit: 0 });
    expect(r.status, r.log).toBe(0);
    expect(r.skip).toBe('false');
  });

  it('(1b) open PRs counted on a later page still scan', () => {
    // `--paginate` prints one count per page; any non-zero page means open.
    const r = decide(closedEdit, { out: '0\n2\n', exit: 0 });
    expect(r.skip).toBe('false');
  });

  it('(1c) an API error scans', () => {
    const r = decide(closedEdit, { out: '', exit: 1 });
    expect(r.status, r.log).toBe(0);
    expect(r.skip).toBe('false');
  });

  it('(1d) an empty or unreadable API answer scans', () => {
    for (const out of ['', '\n', 'null\n', 'zero\n', '0 1\n', '-1\n', '{}\n']) {
      const r = decide(closedEdit, { out, exit: 0 });
      expect(r.status, `${JSON.stringify(out)}: ${r.log}`).toBe(0);
      expect(r.skip, JSON.stringify(out)).toBe('false');
    }
  });

  it('(1e) a missing or malformed head SHA scans without calling the API', () => {
    for (const HEAD_SHA of ['', 'abc', `${'g'.repeat(40)}`, `${SHA}a`]) {
      const r = decide({ ...closedEdit, HEAD_SHA });
      expect(r.status, `${HEAD_SHA}: ${r.log}`).toBe(0);
      expect(r.skip, HEAD_SHA).toBe('false');
      expect(r.ghCalls, HEAD_SHA).toEqual([]);
    }
  });

  it('(2) a title/body edit on an open PR (no base change) still scans', () => {
    // A skip here could green-wash a head whose last real scan was red.
    const r = decide({ ...closedEdit, PR_STATE: 'open' });
    expect(r.status, r.log).toBe(0);
    expect(r.skip).toBe('false');
    // An open PR never needs the lookup.
    expect(r.ghCalls).toEqual([]);
  });

  it('(3) the skip turns on PR state and the live lookup, not on any base-change field', () => {
    // A retarget of an open PR scans by (2). The decision must not read
    // `changes.base`, or a body edit and a retarget could diverge again.
    expect(decideStep().run).not.toMatch(/BASE_REF|changes\.base/);
  });

  it('(4) opened, synchronize, reopened and push still scan', () => {
    const events: Event[] = [
      ...['opened', 'synchronize', 'reopened'].map((EVENT_ACTION) => ({
        EVENT_NAME: 'pull_request_target',
        EVENT_ACTION,
        PR_STATE: 'open',
        HEAD_SHA: SHA,
      })),
      { EVENT_NAME: 'push' },
    ];
    // Non-empty by construction: a zero-event loop would prove nothing.
    expect(events).toHaveLength(4);
    for (const e of events) {
      const r = decide(e);
      expect(r.status, `${e.EVENT_NAME}/${e.EVENT_ACTION}: ${r.log}`).toBe(0);
      expect(r.skip, `${e.EVENT_NAME}/${e.EVENT_ACTION}`).toBe('false');
      expect(r.ghCalls, `${e.EVENT_NAME}/${e.EVENT_ACTION}`).toEqual([]);
    }
  });
});

describe('a skip still reports the required check as passing (#1582)', () => {
  it('gates at step level: the job itself has no if', () => {
    // A job-level `if:` would report "skipped", not "success", for the only
    // producer of a required context.
    expect(job().if).toBeUndefined();
  });

  it('the decide step sits at index 0, is unconditional, and cannot be ignored', () => {
    const d = decideStep();
    expect(steps()[0]?.id).toBe('decide');
    expect(d.if).toBeUndefined();
    expect(d['continue-on-error']).toBeUndefined();
  });

  it('(1) the fetch and scan steps are gated on the decision', () => {
    expect(fetchStep().if).toContain(GUARD);
    // The fetch keeps its own PR-only guard.
    expect(fetchStep().if).toContain(
      "github.event_name == 'pull_request_target'",
    );
    expect(scanStep().if).toBe(GUARD);
  });

  it('only stale-sensitive steps are gated (base checkout and setup still run)', () => {
    const gated = steps().filter((s) => (s.if ?? '').includes('steps.decide'));
    expect(gated.map((s) => s.name)).toEqual([
      fetchStep().name,
      scanStep().name,
    ]);
  });
});

describe('runs for one PR serialize (#1582)', () => {
  it('has a concurrency group keyed per PR that never cancels a running scan', () => {
    const c = workflow().concurrency as
      { group?: string; 'cancel-in-progress'?: unknown } | undefined;
    expect(c).toBeDefined();
    expect(c!.group).toContain('github.event.pull_request.number');
    // Pushes are keyed per commit so main's runs never queue behind each
    // other and get cancelled while pending.
    expect(c!.group).toContain('github.sha');
    expect(c!['cancel-in-progress']).toBe(false);
  });
});

describe('new event values reach the shell only through env (#1582)', () => {
  it('(5) the decide step reads the event via env, never ${{ }} in run', () => {
    const d = decideStep();
    expect(d.run).not.toContain('${{');
    expect(d.env).toEqual({
      EVENT_NAME: '${{ github.event_name }}',
      EVENT_ACTION: '${{ github.event.action }}',
      PR_STATE: '${{ github.event.pull_request.state }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
      REPO: '${{ github.repository }}',
      GH_TOKEN: '${{ github.token }}',
    });
    for (const name of Object.keys(d.env!)) {
      if (name === 'GH_TOKEN') continue; // read by gh itself, not the script
      expect(d.run, name).toContain(`$${name}`);
    }
  });

  it('(5) the decide step holds no secret and never echoes the token', () => {
    expect(JSON.stringify(decideStep())).not.toContain('secrets.');
    expect(decideStep().run).not.toMatch(/\$\{?GH_TOKEN/);
  });
});
