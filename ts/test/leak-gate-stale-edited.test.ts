/**
 * An `edited` event that cannot change the scan's answer skips the scan, and
 * the required check still reports a pass (#1582).
 *
 * leak-gate.yml listens for `edited` so that retargeting a PR to another base
 * re-runs the gate. GitHub also sends `edited` for a title or body edit, and
 * for edits to a PR that has already merged or closed. That run scanned the
 * PR's old head against today's denylist, and could go red on a PR nobody can
 * change any more.
 *
 * The fix gates at STEP level, never with a job-level `if:`. A skipped job
 * reports "skipped" rather than "success", and the job is the only producer
 * of the required context `No removed-symbol or proprietary leaks`. A first
 * step decides `skip`, and the fetch and scan steps run only when it is not
 * `'true'`, so the job still finishes green and the context is never missing.
 *
 * The decision tests execute the decide step's own script under bash with a
 * stub event, so they check what the step does, not what its text looks like.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const job = (): Job => {
  const wf = loadYaml(readFileSync(WORKFLOW, 'utf8')) as {
    jobs: Record<string, Job>;
  };
  const jobs = Object.values(wf.jobs);
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

interface Event {
  EVENT_NAME: string;
  EVENT_ACTION?: string;
  PR_STATE?: string;
  BASE_REF_FROM?: string;
}

describe('the decide step classifies each event (#1582)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Run the decide step's script for one event; return status and `skip`. */
  function decide(event: Event) {
    dir = mkdtempSync(join(tmpdir(), 'leak-decide-'));
    const out = join(dir, 'github_output');
    const res = spawnSync('bash', ['-e', '-c', decideStep().run!], {
      cwd: dir,
      encoding: 'utf8',
      // Unset keys arrive empty, as GitHub renders a missing property.
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: out,
        EVENT_ACTION: '',
        PR_STATE: '',
        BASE_REF_FROM: '',
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
    };
  }

  it('(1) an edit to a merged or closed PR skips the scan and exits 0', () => {
    for (const BASE_REF_FROM of ['', 'release/1.x']) {
      const r = decide({
        EVENT_NAME: 'pull_request_target',
        EVENT_ACTION: 'edited',
        PR_STATE: 'closed',
        BASE_REF_FROM,
      });
      expect(r.status, r.log).toBe(0);
      expect(r.values).toHaveLength(1);
      expect(r.skip).toBe('true');
      // A skip says why in the log, so a green run is not a silent abstention.
      expect(r.log).toMatch(/skip/i);
    }
  });

  it('(2) a title/body edit on an open PR (no base change) skips', () => {
    const r = decide({
      EVENT_NAME: 'pull_request_target',
      EVENT_ACTION: 'edited',
      PR_STATE: 'open',
    });
    expect(r.status, r.log).toBe(0);
    expect(r.skip).toBe('true');
  });

  it('(3) retargeting an open PR to another base still scans', () => {
    const r = decide({
      EVENT_NAME: 'pull_request_target',
      EVENT_ACTION: 'edited',
      PR_STATE: 'open',
      BASE_REF_FROM: 'release/1.x',
    });
    expect(r.status, r.log).toBe(0);
    expect(r.skip).toBe('false');
  });

  it('(4) opened, synchronize, reopened and push still scan', () => {
    const events: Event[] = [
      ...['opened', 'synchronize', 'reopened'].map((EVENT_ACTION) => ({
        EVENT_NAME: 'pull_request_target',
        EVENT_ACTION,
        PR_STATE: 'open',
      })),
      { EVENT_NAME: 'push' },
    ];
    // Non-empty by construction: a zero-event loop would prove nothing.
    expect(events).toHaveLength(4);
    for (const e of events) {
      const r = decide(e);
      expect(r.status, `${e.EVENT_NAME}/${e.EVENT_ACTION}: ${r.log}`).toBe(0);
      expect(r.skip, `${e.EVENT_NAME}/${e.EVENT_ACTION}`).toBe('false');
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

describe('new event values reach the shell only through env (#1582)', () => {
  it('(5) the decide step reads the event via env, never ${{ }} in run', () => {
    const d = decideStep();
    expect(d.run).not.toContain('${{');
    expect(d.env).toEqual({
      EVENT_NAME: '${{ github.event_name }}',
      EVENT_ACTION: '${{ github.event.action }}',
      PR_STATE: '${{ github.event.pull_request.state }}',
      BASE_REF_FROM: '${{ github.event.changes.base.ref.from }}',
    });
    for (const name of Object.keys(d.env!)) {
      expect(d.run, name).toContain(`$${name}`);
    }
  });

  it('(5) the decide step holds no secret', () => {
    expect(JSON.stringify(decideStep())).not.toContain('secrets.');
  });
});
