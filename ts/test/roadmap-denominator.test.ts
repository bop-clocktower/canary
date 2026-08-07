/**
 * Contract tests for `scripts/roadmap-denominator-check.mjs` (#595).
 *
 * The bug this closes: `harness roadmap sync` filters the tracker by label, so
 * it examined **2 of 30** open issues and said so plainly in its own output —
 * a real number nobody read. It did not fail. It abstained and reported a pass.
 *
 * The check makes that structural blindness loud. The invariant is exact rather
 * than a ratio: **every roadmap row that carries an `External-ID` must point at
 * an issue carrying the tracker label**, because that label is precisely what
 * decides whether sync can see the issue at all. A linked-but-unlabelled row is
 * a row sync will treat as needing a ticket it already has.
 *
 * A ratio was the obvious alternative and is the wrong shape: most open issues
 * are ordinary bug reports that are not roadmap rows, so a coverage floor would
 * either sit low enough to miss the 2-of-30 case or fire constantly. The ratio
 * is still reported, as context rather than as a gate.
 *
 * Exit codes follow the repo's gate convention (#508):
 *   0 = verified — every linked row is visible to sync
 *   2 = error
 *   3 = ABSTENTION — blind rows found, or the tracker could not be read at all
 *
 * `GH_BIN` drives a stub, so these run offline and never touch the network.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'roadmap-denominator-check.mjs');

/** A roadmap row, linked to `issue` when given. */
function row(name: string, issue?: number): string {
  const link =
    issue === undefined
      ? ''
      : `- **External-ID:** github:bop-clocktower/canary#${issue}\n`;
  return `### ${name}\n\n- **Status:** backlog\n- **Summary:** s\n${link}\n`;
}

describe('roadmap-denominator-check', () => {
  let dir: string;
  let roadmap: string;
  let ghStub: string;

  /** A fake `gh` returning `issues` as the JSON list the check asks for. */
  function writeGhStub(
    issues: { number: number; state: string; labels: string[] }[],
  ): void {
    const payload = issues.map((i) => ({
      number: i.number,
      state: i.state,
      labels: i.labels.map((name) => ({ name })),
    }));
    writeFileSync(
      ghStub,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
        JSON.stringify(payload),
      )});\n`,
    );
    chmodSync(ghStub, 0o755);
  }

  /** A fake `gh` that fails, standing in for no auth / no network / no gh. */
  function writeFailingGhStub(): void {
    writeFileSync(
      ghStub,
      '#!/usr/bin/env node\nprocess.stderr.write("gh: not authenticated");\nprocess.exit(1);\n',
    );
    chmodSync(ghStub, 0o755);
  }

  const run = (): { status: number; output: string } => {
    const r = spawnSync(process.execPath, [SCRIPT, '--roadmap', roadmap], {
      encoding: 'utf-8',
      env: { ...process.env, GH_BIN: ghStub },
    });
    return { status: r.status ?? 2, output: `${r.stdout}${r.stderr}` };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'denom-'));
    roadmap = join(dir, 'roadmap.md');
    ghStub = join(dir, 'gh-stub.js');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes when every linked row is labelled', () => {
    writeFileSync(roadmap, row('A', 601) + row('B', 602));
    writeGhStub([
      { number: 601, state: 'OPEN', labels: ['harness-managed'] },
      { number: 602, state: 'OPEN', labels: ['harness-managed', 'bug'] },
    ]);

    const { status } = run();

    expect(status).toBe(0);
  });

  it('fails with exit 3 when a linked row is invisible to sync', () => {
    writeFileSync(roadmap, row('A', 601) + row('B', 602));
    writeGhStub([
      { number: 601, state: 'OPEN', labels: ['harness-managed'] },
      { number: 602, state: 'OPEN', labels: ['bug'] },
    ]);

    const { status } = run();

    expect(status).toBe(3);
  });

  it('names the blind rows rather than only counting them', () => {
    // "2 rows are invisible" sends the reader back to the tracker by hand.
    writeFileSync(roadmap, row('A', 601) + row('B', 602));
    writeGhStub([
      { number: 601, state: 'OPEN', labels: [] },
      { number: 602, state: 'OPEN', labels: ['harness-managed'] },
    ]);

    const { output } = run();

    expect(output).toContain('#601');
    expect(output).not.toContain('#602');
  });

  it('reproduces the filed 1-of-30 case as a failure', () => {
    // The exact shape #595 was opened on: one labelled issue against a tracker
    // full of unlabelled ones. This is the regression test for the bug itself.
    const rows = Array.from({ length: 30 }, (_, i) => row(`R${i}`, 100 + i));
    writeFileSync(roadmap, rows.join(''));
    writeGhStub(
      Array.from({ length: 30 }, (_, i) => ({
        number: 100 + i,
        state: 'OPEN',
        labels: i === 0 ? ['harness-managed'] : ['bug'],
      })),
    );

    const { status, output } = run();

    expect(status).toBe(3);
    expect(output).toContain('29');
  });

  it('treats an unreadable tracker as a finding, not a skip', () => {
    // "Cannot verify" must not exit 0. A check that abstains silently is the
    // failure this whole issue is about.
    writeFileSync(roadmap, row('A', 601));
    writeFailingGhStub();

    const { status, output } = run();

    expect(status).toBe(3);
    expect(output).toMatch(/cannot verify/i);
  });

  it('treats a roadmap with no linked rows as a zero denominator', () => {
    // Nothing to check is not the same as everything checking out.
    writeFileSync(roadmap, row('A') + row('B'));
    writeGhStub([]);

    const { status, output } = run();

    expect(status).toBe(3);
    expect(output).toMatch(/no linked rows|zero/i);
  });

  it('reports the counts it checked, in both directions', () => {
    // The original bug was a true number nobody read, so the check states its
    // own denominator instead of only its verdict.
    writeFileSync(roadmap, row('A', 601) + row('B', 602));
    writeGhStub([
      { number: 601, state: 'OPEN', labels: ['harness-managed'] },
      { number: 602, state: 'CLOSED', labels: ['harness-managed'] },
      { number: 700, state: 'OPEN', labels: ['bug'] },
    ]);

    const { output } = run();

    expect(output).toContain('2');
    expect(output).toMatch(/open/i);
  });

  it('is wired into the sync wrapper', () => {
    // The check only protects anything if the sanctioned path runs it. Source
    // text, because the wrapper's own spawn is stubbed out in its tests.
    const wrapper = join(REPO_ROOT, 'scripts', 'roadmap-sync.mjs');
    const text = spawnSync('cat', [wrapper], { encoding: 'utf-8' }).stdout;

    expect(text).toContain('roadmap-denominator-check.mjs');
  });
});
