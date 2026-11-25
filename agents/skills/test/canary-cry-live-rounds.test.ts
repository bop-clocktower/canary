/**
 * `run --live <t> --amplitude shout|scream --confirm <sha> [--max-wall D]`
 * end to end through main() with Playwright stubbed (#608 P4). The real
 * browser half is the cry-e2e suite; this proves the wiring offline:
 *
 * - shout runs i1 and i2, scream runs rounds until convergence (SC17): one
 *   Playwright run per scenario, each selecting exactly its own spec
 * - checkpoint.json is rewritten after EVERY scenario (SC18)
 * - --max-wall elapsing (an injected clock) stops between scenarios with
 *   `PARTIAL: n/m — resume with --resume <run-id>` (SC18); malformed is exit 2
 * - a crash keeps what completed before it; results.json merges the reports
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLEAN,
  type Seen,
  cleanup,
  confirmed,
  confirmedDir,
  cry,
  fakePw,
  findings,
  observation,
  project,
  testClock,
} from './fixtures/cry-run/harness.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const I1 = ['checkout.multi-submit.i1.spay', 'checkout.duplicate-tab.i1.spay'];
const I2 = I1.map((stem) => stem.replace('.i1.', '.i2.'));

const checkpointOf = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));

describe('shout and scream run their rounds (SC17)', () => {
  it('shout runs i1 then i2, one Playwright run per scenario', async () => {
    const p = project();
    const seen: Seen = { calls: [] };
    const r = await confirmed(p, fakePw(seen, CLEAN), ['--amplitude', 'shout']);
    expect(r.code, r.stderr).toBe(0);
    expect(seen.calls.map((c) => c.stem)).toEqual([...I1, ...I2]);
    for (const c of seen.calls) {
      expect(c.spec).toMatch(new RegExp(`${c.stem.replaceAll('.', '\\\\.')}`));
    }
    expect(r.stdout).not.toContain('converged');
    expect(findings(p.runs).scenarios).toHaveLength(4);
  });

  it('scream over a clean app converges after round 2: i3 never launches', async () => {
    const p = project();
    const seen: Seen = { calls: [] };
    const r = await confirmed(p, fakePw(seen, CLEAN), [
      '--amplitude',
      'scream',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(seen.calls.map((c) => c.stem)).toEqual([...I1, ...I2]);
    expect(r.stdout.split('\n')).toContain('converged after round 2');
    const doc = findings(p.runs);
    expect(doc.stop).toEqual({
      reason: 'converged',
      line: 'converged after round 2',
    });
    expect(doc.rounds.map((x: any) => x.barren)).toEqual([true, true]);
    // The manifest still listed i3: the worst case is what was confirmed.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(confirmedDir(p.runs), 'manifest.json'), 'utf8'),
    );
    expect(
      manifest.scenarios.filter((s: any) => s.intensity === 3),
    ).toHaveLength(2);
  });

  it('a fresh fingerprint in round 2 runs round 3 too, to the ceiling', async () => {
    const p = project();
    const seen: Seen = { calls: [] };
    const breach = observation('corrupted', {
      invariants: [{ id: 'one-order', before: 0, after: 2, breached: true }],
    });
    const obs = (stem: string) => (stem === I2[0] ? breach : CLEAN);
    const r = await confirmed(p, fakePw(seen, obs), ['--amplitude', 'scream']);
    expect(seen.calls).toHaveLength(6);
    expect(r.stdout).toContain(
      'not converged: stopped at the intensity ceiling after round 3',
    );
  });
});

describe('checkpoints (SC18)', () => {
  it('rewrites checkpoint.json after every scenario, holding no account value', async () => {
    const p = project();
    const seen: Seen = { calls: [] };
    await confirmed(p, fakePw(seen, CLEAN), ['--amplitude', 'shout']);
    expect(seen.calls.map((c) => c.checkpointed)).toEqual([0, 1, 2, 3]);
    const cp = checkpointOf(confirmedDir(p.runs));
    expect(cp.format).toBe('canary.cry-checkpoint/1');
    expect(cp.total).toBe(6 - 2);
    expect(cp.results.map((x: any) => x.verdict)).toEqual(
      Array(4).fill('clean'),
    );
    const text = JSON.stringify(cp);
    expect(text).not.toContain('pw-planted-5150');
    expect(text).not.toContain('a@x.test');
  });

  it('merges every scenario report into results.json', async () => {
    const p = project();
    await confirmed(p, fakePw({ calls: [] }, CLEAN), ['--amplitude', 'shout']);
    const merged = JSON.parse(
      fs.readFileSync(path.join(confirmedDir(p.runs), 'results.json'), 'utf8'),
    );
    expect(merged.suites.map((s: any) => s.title)).toEqual([...I1, ...I2]);
  });
});

describe('--max-wall (SC18)', () => {
  it('stops between scenarios once the wall elapses: PARTIAL n/m, resumable', async () => {
    const p = project();
    const clock = testClock();
    const seen: Seen = { calls: [] };
    const pw = fakePw(seen, CLEAN, true, () => clock.advance(60_000));
    const extra = ['--amplitude', 'scream', '--max-wall', '90s', '--strict'];
    const r = await confirmed(p, pw, extra, clock.now);
    // 0 s and 60 s start a scenario; at 120 s the 90 s wall has elapsed.
    expect(seen.calls).toHaveLength(2);
    const dir = confirmedDir(p.runs);
    const id = path.basename(dir);
    expect(r.stdout.split('\n')).toContain(
      `PARTIAL: 2/6 — resume with --resume ${id}`,
    );
    expect(r.code).toBe(3);
    expect(checkpointOf(dir).results).toHaveLength(2);
    const doc = findings(p.runs);
    expect(doc.status).toBe('partial');
    expect(doc.scenarios).toHaveLength(2);
  });

  it('a corruption found before the wall still fails --strict with 1', async () => {
    const p = project();
    const clock = testClock();
    const breach = observation('corrupted', {
      invariants: [{ id: 'one-order', before: 0, after: 2, breached: true }],
    });
    const pw = fakePw({ calls: [] }, breach, true, () => clock.advance(60_000));
    const extra = ['--amplitude', 'shout', '--max-wall', '1m', '--strict'];
    expect((await confirmed(p, pw, extra, clock.now)).code).toBe(1);
  });

  it.each(['90', '1d', '0s', '1h1h', '5m30m'])(
    'a malformed duration (%j) is exit 2, before anything is written',
    async (d) => {
      const p = project();
      const r = await cry([
        'run',
        '--live',
        'local',
        ...p.args,
        '--max-wall',
        d,
      ]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`--max-wall: malformed duration '${d}'`);
      expect(fs.existsSync(p.runs)).toBe(false);
    },
  );
});

describe('a crash mid-run', () => {
  it('stops, keeping and reporting what completed before it', async () => {
    const p = project();
    const seen: Seen = { calls: [] };
    const good = fakePw(seen, CLEAN);
    const bad = fakePw(seen, null, false);
    let n = 0;
    const pw = {
      ...good,
      run: (args: any) => ((n += 1) === 2 ? bad.run(args) : good.run(args)),
    };
    const r = await confirmed(p, pw, ['--amplitude', 'shout', '--strict']);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('ABSTAINED: playwright crashed (exit 1)');
    const doc = findings(p.runs);
    expect(doc.scenarios.map((s: any) => s.id)).toEqual([
      'checkout:multi-submit:i1:spay',
    ]);
    expect(checkpointOf(confirmedDir(p.runs)).results).toHaveLength(1);
  });
});
