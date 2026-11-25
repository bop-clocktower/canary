/**
 * `canary-cry run --live <t> --confirm <sha>` end to end through main() with
 * Playwright stubbed (#608 P3). The real browser half is the cry-e2e suite
 * (test/e2e/); this proves the executor's contract offline:
 *
 * - a matching sha now EXECUTES: codegen writes config, specs and the
 *   runtime copy, the target's Playwright is launched, findings.json is
 *   written from the runtime's observations
 * - SC15 no @playwright/test in the target, or nothing probed -> ABSTAINED,
 *   --strict exits 3
 * - SC16 --strict: symptom only exits 0, >= 1 corrupted exits 1
 * - SC22 the preflight GET baseURL fails (a closed port) -> ABSTAINED: target
 *   unreachable and no scenario runs
 * - no results.json -> ABSTAINED: playwright crashed + the last 20 stderr lines
 * - SC10 no account value in any file the run dir now gets
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeRun } from '../claude-code/canary-cry/scripts/execute.mjs';
import {
  ACCOUNT,
  PAY,
  SECRET,
  STEM,
  type Seen,
  cleanup,
  confirmed,
  confirmedDir,
  fakePw,
  findings,
  observation,
  project,
} from './fixtures/cry-run/harness.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('a matching --confirm executes', () => {
  it('generates the run dir, launches the target Playwright, writes findings.json', async () => {
    const p = project();
    const seen: Seen = { calls: [] };
    const obs = observation('clean', {
      invariants: [{ id: 'one-order', before: 0, after: 1, breached: false }],
    });
    const r = await confirmed(p, fakePw(seen, obs));
    expect(r.code).toBe(0);
    const dir = confirmedDir(p.runs);
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].config).toBe(path.join(dir, 'playwright.config.mjs'));
    expect(seen.calls[0].env.CRY_A).toBe(ACCOUNT);
    for (const f of [
      'manifest.json',
      'matrix.json',
      'playwright.config.mjs',
      `specs/${STEM}.spec.mjs`,
      'runtime/cry-runtime.mjs',
      'verdict.mjs',
    ]) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    }
    const doc = findings(p.runs);
    expect(doc.format).toBe('canary.cry-findings/1');
    expect(doc.status).toBe('ok');
    expect(doc.run.manifestSha).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.scenarios[0]).toEqual(
      expect.objectContaining({ id: PAY, verdict: 'clean' }),
    );
    expect(r.stdout).toContain(`clean (state-verified)  ${PAY}`);
  });

  it('never writes an account value into any run artifact (SC10)', async () => {
    const p = project();
    await confirmed(p, fakePw({ calls: [] }, observation('clean')));
    const text = fs
      .readdirSync(confirmedDir(p.runs), {
        recursive: true,
        withFileTypes: true,
      })
      .filter((e) => e.isFile())
      .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
      .join('\n');
    expect(text).toContain('CRY_A');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('a@x.test');
  });

  it('a scheduled scenario with no observation abstains, never vanishes', async () => {
    const p = project();
    const r = await confirmed(p, fakePw({ calls: [] }, null), ['--strict']);
    expect(findings(p.runs).scenarios[0].reason).toBe('no-observation');
    expect(r.code).toBe(3);
  });
});

describe('--strict over verdicts (SC16)', () => {
  it.each<[string, object, number]>([
    ['symptom only exits 0', observation('symptom'), 0],
    [
      'one corrupted exits 1',
      observation('corrupted', {
        fingerprints: ['checkout:multi-submit:one-order'],
        invariants: [
          {
            id: 'one-order',
            before: 0,
            after: 2,
            breached: true,
            expect: { delta: 1 },
          },
        ],
      }),
      1,
    ],
  ])('%s', async (_, obs, code) => {
    const p = project();
    const r = await confirmed(p, fakePw({ calls: [] }, obs), ['--strict']);
    expect(r.code).toBe(code);
  });

  it('prints a corruption with its before/after values', async () => {
    const obs = observation('corrupted', {
      fingerprints: ['checkout:multi-submit:one-order'],
      invariants: [
        {
          id: 'one-order',
          before: 0,
          after: 2,
          breached: true,
          expect: { delta: 1 },
        },
      ],
    });
    const r = await confirmed(project(), fakePw({ calls: [] }, obs));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`corrupted (state-verified)  ${PAY}`);
    expect(r.stdout).toContain(
      'one-order: before 0 -> after 2 (expect {"delta":1})',
    );
  });
});

describe('ABSTAINED runs (SC15, SC22)', () => {
  it('no @playwright/test in the target: matrix still emitted, nothing run', async () => {
    const p = project();
    const r = await confirmed(p, undefined, ['--strict']);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('ABSTAINED: no @playwright/test in target');
    const dir = confirmedDir(p.runs);
    expect(fs.existsSync(path.join(dir, 'matrix.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'specs'))).toBe(false);
    expect(findings(p.runs).status).toBe('abstained');
  });

  it('every scenario abstaining is ABSTAINED with the reasons counted', async () => {
    const p = project();
    const obs = observation('abstain', { reason: 'no-probes', fidelity: null });
    const r = await confirmed(p, fakePw({ calls: [] }, obs), ['--strict']);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain(
      'ABSTAINED: every scenario abstained (no-probes 1)',
    );
  });

  it('a closed port fails the preflight: target unreachable, zero scenarios', async () => {
    const port = await closedPort();
    const p = project(`http://127.0.0.1:${port}`);
    const seen: Seen = { calls: [] };
    const { preflight: _real, ...pw } = fakePw(seen, observation('clean'));
    const r = await confirmed(p, pw, ['--strict']);
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/ABSTAINED: target unreachable \(ECONNREFUSED\)/);
    expect(seen.calls).toHaveLength(0);
    expect(findings(p.runs).scenarios).toEqual([]);
  });

  it('no results.json is a crash: ABSTAINED with the last 20 stderr lines', async () => {
    const p = project();
    const r = await confirmed(p, fakePw({ calls: [] }, null, false), [
      '--strict',
    ]);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('ABSTAINED: playwright crashed (exit 1)');
    expect(r.stderr.split('\n')).toEqual(
      Array.from({ length: 20 }, (_, i) => `err ${i}`),
    );
  });
});

/** A port nothing listens on: bind one, then close it. */
function closedPort(): Promise<number> {
  return new Promise((done) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => done(port));
    });
  });
}

describe('executeRun guards', () => {
  it('an unexpected exception exits 1 with its message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await executeRun({
      opts: { strict: false },
      plan: { manifest: null as any, matrix: {}, sha: 'x' },
      dir: '/nonexistent',
      env: {},
      now: () => new Date(),
    });
    expect(code).toBe(1);
    expect(String(err.mock.calls[0])).toMatch(/^canary-cry: /);
  });
});
