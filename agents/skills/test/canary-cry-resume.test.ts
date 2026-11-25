/**
 * `run --resume <run-id> --confirm <sha>` end to end through main() with
 * Playwright stubbed (#608 P4; SC18, spec "CLI and exit codes", "Failure
 * modes"). A resume is a second confirmed run, so it is held to the same
 * gate: the manifest is REBUILT from the files with the parameters the run
 * recorded, and must match both --confirm and the sha the checkpoint was
 * written for, or nothing is sent.
 *
 * - a PARTIAL run resumes, skipping completed ids, and finishes in place
 * - a flows edit since the run started: exit 4, no Playwright launch
 * - an unknown or malformed run-id, a damaged checkpoint, a hand-edited one,
 *   --live alongside, or no --confirm: exit 2
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLEAN,
  type Project,
  type Seen,
  cleanup,
  confirmedDir,
  cry,
  fakePw,
  findings,
  project,
  readSha,
  testClock,
} from './fixtures/cry-run/harness.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const SHOUT = ['--amplitude', 'shout'];
const SHA = /manifest-sha: ([0-9a-f]{64})/;

const WALL = ['--max-wall', '90s'];

/** A shout run stopped PARTIAL after 2 of its 4 scenarios. */
async function stoppedRun() {
  const p = project();
  const clock = testClock();
  const seen: Seen = { calls: [] };
  const pw = fakePw(seen, CLEAN, true, () => clock.advance(60_000));
  const sha = await readSha(p, [...SHOUT, ...WALL]);
  const live = ['run', '--live', 'local', ...p.args, '--confirm', sha];
  const r = await cry([...live, ...SHOUT, ...WALL], pw, clock.now);
  expect(r.stdout).toContain('PARTIAL: 2/4');
  const dir = confirmedDir(p.runs);
  return { p, dir, id: path.basename(dir), sha, first: seen.calls };
}

/** The sha a fresh `run --live` prints for the same inputs. */
async function shaOf(p: Project) {
  const r = await cry(['run', '--live', 'local', ...p.args, ...SHOUT]);
  return SHA.exec(r.stdout)![1]!;
}

const resume = (p: Project, id: string, sha: string, pw?: object) =>
  cry(['run', '--resume', id, '--confirm', sha, ...p.args], pw);

describe('resuming a PARTIAL run (SC18)', () => {
  it('skips the completed ids and finishes the run in its own dir', async () => {
    const run = await stoppedRun();
    const seen: Seen = { calls: [] };
    const r = await resume(run.p, run.id, run.sha, fakePw(seen, CLEAN));
    expect(r.code, r.stderr).toBe(0);
    const done = run.first.map((c) => c.stem);
    expect(seen.calls.map((c) => c.stem)).toEqual([
      'checkout.multi-submit.i2.spay',
      'checkout.duplicate-tab.i2.spay',
    ]);
    expect(done).toEqual([
      'checkout.multi-submit.i1.spay',
      'checkout.duplicate-tab.i1.spay',
    ]);
    expect(seen.calls[0].checkpointed).toBe(2);
    expect(r.stdout).not.toContain('PARTIAL');
    const doc = findings(run.p.runs);
    expect(doc.run.id).toBe(run.id);
    expect(doc.status).toBe('ok');
    expect(doc.scenarios).toHaveLength(4);
  });

  it('a resume can stop PARTIAL again, and the next one finishes it', async () => {
    const run = await stoppedRun();
    const clock = testClock();
    const pw = fakePw({ calls: [] }, CLEAN, true, () => clock.advance(60_000));
    const again = ['run', '--resume', run.id, '--confirm', run.sha];
    const r = await cry(
      [...again, ...run.p.args, '--max-wall', '30s'],
      pw,
      clock.now,
    );
    expect(r.stdout).toContain(`PARTIAL: 3/4 — resume with --resume ${run.id}`);
    const last = await resume(
      run.p,
      run.id,
      run.sha,
      fakePw({ calls: [] }, CLEAN),
    );
    expect(last.code).toBe(0);
    expect(findings(run.p.runs).scenarios).toHaveLength(4);
  });
});

describe('a resume the gate refuses (exit 4)', () => {
  it('a flows edit since the run started: the rebuilt manifest differs', async () => {
    const run = await stoppedRun();
    const flows = JSON.parse(fs.readFileSync(run.p.flows, 'utf8'));
    flows.flows[0].risk = 4;
    fs.writeFileSync(run.p.flows, JSON.stringify(flows));
    const seen: Seen = { calls: [] };
    const fresh = await shaOf(run.p);
    // Confirming the new sha does not help: the checkpoint is the old one's.
    for (const sha of [run.sha, fresh]) {
      const r = await resume(run.p, run.id, sha, fakePw(seen, CLEAN));
      expect(r.code, sha).toBe(4);
      expect(r.stderr).toMatch(/canary-cry: refused: manifest/);
    }
    expect(seen.calls).toEqual([]);
  });

  it('a --confirm that is not the run sha', async () => {
    const run = await stoppedRun();
    const r = await resume(run.p, run.id, 'f'.repeat(64));
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('manifest-sha mismatch');
  });
});

describe('a resume that is a usage error (exit 2)', () => {
  it.each(['20261125T000000Z-00000000', '../../etc', 'latest'])(
    'an unknown or malformed run-id (%j)',
    async (id) => {
      const run = await stoppedRun();
      const r = await resume(run.p, id, run.sha);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`--resume: unknown run-id: ${id}`);
    },
  );

  it('a damaged checkpoint.json', async () => {
    const run = await stoppedRun();
    fs.writeFileSync(path.join(run.dir, 'checkpoint.json'), '{"format":');
    const r = await resume(run.p, run.id, run.sha);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is not canary.cry-checkpoint/1');
  });

  it('a hand-edited checkpoint that marks an unrun scenario done', async () => {
    const run = await stoppedRun();
    const file = path.join(run.dir, 'checkpoint.json');
    const cp = JSON.parse(fs.readFileSync(file, 'utf8'));
    cp.results.push({
      id: 'checkout:nope:i2:spay',
      verdict: 'clean',
      fingerprints: [],
    });
    fs.writeFileSync(file, JSON.stringify(cp));
    const r = await resume(run.p, run.id, run.sha);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('not in the rebuilt matrix');
  });

  it('a damaged manifest.json (nothing to rebuild with)', async () => {
    const run = await stoppedRun();
    fs.writeFileSync(path.join(run.dir, 'manifest.json'), '[]');
    const r = await resume(run.p, run.id, run.sha);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      `run ${run.id}: manifest.json is missing or damaged`,
    );
  });

  it.each<[string, string[], RegExp]>([
    ['--live alongside', ['--live', 'local'], /drop --live/],
    ['no --confirm', [], /needs --confirm SHA/],
  ])('%s', async (_, extra, message) => {
    const run = await stoppedRun();
    const argv = ['run', '--resume', run.id, ...extra, ...run.p.args];
    const r = await cry(argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
  });
});
