// #1558: katana ignored the map `canary critical-areas` writes unless
// `--critical-areas` was passed, so the documented two-step setup (generate,
// then run katana) silently stayed recording-only.
//
// With no flag, katana now reads `<repo>/.canary/critical-areas.json` when it
// exists and names the file on stderr. An explicit flag still wins, a repo
// without the file degrades exactly as before, and a discovered map that is
// stale abstains the same way a passed one does (#1325, #1739).

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../claude-code/canary-katana/scripts/cli.mjs';

const NOW = new Date('2026-11-25T00:00:00Z');
const now = () => NOW;

const tmps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

// Deletes the last test naming the points service: a real CRITICAL alarm when
// a map marks the service high-risk.
const LAST_COVERAGE = `diff --git a/tests/test_points.py b/tests/test_points.py
--- a/tests/test_points.py
+++ b/tests/test_points.py
@@ -1,3 +1,1 @@
-def test_points_service_earns():
-    assert True
 x = 1
`;

const POINTS = [{ path: 'src/loyalty/points.service.ts', risk_score: 0.92 }];
// Below the high-risk line, and nothing the diff ties to: scoring it can
// neither alarm nor abstain, so it isolates which map was read.
const UNRELATED = [{ path: 'src/billing/invoice.ts', risk_score: 0.3 }];

function scratchRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-discover-'));
  tmps.push(tmp);
  fs.mkdirSync(path.join(tmp, 'tests'));
  fs.writeFileSync(path.join(tmp, 'tests', 'test_points.py'), 'x = 1\n');
  const diffPath = path.join(tmp, 'changes.diff');
  fs.writeFileSync(diffPath, LAST_COVERAGE);
  return {
    tmp,
    argv: ['--repo', tmp, '--diff-file', diffPath, '--no-write'],
  };
}

function writeMap(file: string, areas: unknown[], generated: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ generated, areas }));
}

const defaultMap = (tmp: string) =>
  path.join(tmp, '.canary', 'critical-areas.json');

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
    out.push(String(s));
  });
  vi.spyOn(console, 'error').mockImplementation((s?: unknown) => {
    err.push(String(s));
  });
  const code = main(argv, { now });
  vi.restoreAllMocks();
  return { code, text: out.join('\n'), err: err.join('\n') };
}

describe('critical-areas map discovery (#1558)', () => {
  it('reads the generated map at <repo>/.canary/critical-areas.json and names it on stderr', () => {
    const { tmp, argv } = scratchRepo();
    writeMap(defaultMap(tmp), POINTS, '2026-11-20T00:00:00Z');

    const { code, text, err } = run([...argv, '--strict']);
    expect(code).toBe(1); // the alarm fired: the map was actually scored
    expect(text).toContain('test_points_service_earns');
    expect(text).not.toContain('critical-area data unavailable');
    expect(err).toContain(`canary-katana: using ${defaultMap(tmp)}`);
  });

  it('an explicit --critical-areas wins over the discovered map, and nothing is announced', () => {
    const { tmp, argv } = scratchRepo();
    // The default map would alarm; the explicit one names an unrelated area.
    writeMap(defaultMap(tmp), POINTS, '2026-11-20T00:00:00Z');
    const explicit = path.join(tmp, 'other-areas.json');
    writeMap(explicit, UNRELATED, '2026-11-20T00:00:00Z');

    const { code, err } = run([
      ...argv,
      '--critical-areas',
      explicit,
      '--strict',
    ]);
    expect(code).toBe(0);
    expect(err).not.toContain('using');
  });

  it('with no map at the default path, the run degrades exactly as before', () => {
    const { argv } = scratchRepo();
    const { code, text, err } = run([...argv, '--strict']);
    expect(code).toBe(0);
    expect(text).toContain('critical-area data unavailable');
    expect(err).not.toContain('using');
  });

  it('a stale discovered map warns and --strict abstains, as a passed one does', () => {
    const { tmp, argv } = scratchRepo();
    // An unrelated area so no alarm outranks the abstention.
    writeMap(defaultMap(tmp), UNRELATED, '2026-09-01T00:00:00Z');
    const { code, text } = run([...argv, '--strict']);
    expect(code).toBe(3);
    expect(text).toContain('critical-areas map is stale');
  });
});
