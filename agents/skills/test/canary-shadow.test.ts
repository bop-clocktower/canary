/**
 * canary-shadow regressions (#479).
 *
 * shadow shipped before the family had a shared CLI contract and quietly
 * diverged from all of it. Two of those divergences were not cosmetic:
 *
 *   - `accept` was read off a plain object parsed from JSON, so a case labelled
 *     `toString` resolved to Object.prototype.toString and was reported
 *     `accept` instead of DIVERGE -- a parity tool suppressing a parity
 *     failure.
 *   - `main()` called process.exit() directly and was never exported, so
 *     nothing could test it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, afterEach } from 'vitest';

import { main } from '../claude-code/canary-shadow/scripts/cli.mjs';

const tmps: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-shadow-'));
  tmps.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** A cases file whose single case genuinely diverges (different exit codes). */
function casesFile(label: string, accept: Record<string, string> = {}): string {
  const dir = tmp();
  const file = path.join(dir, 'cases.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      baseline: ['node', '-e', 'process.stdout.write("A"); process.exit(0)'],
      candidate: ['node', '-e', 'process.stdout.write("B"); process.exit(1)'],
      accept,
      cases: [{ label, argv: [] }],
    }),
  );
  return file;
}

function run(argv: string[]): { code: number; stdout: string } {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation(
    (...a: unknown[]) => void out.push(a.join(' ')),
  );
  const code = main(argv);
  vi.restoreAllMocks();
  return { code, stdout: out.join('') };
}

describe('accept map', () => {
  it('reports a genuinely diverging case as DIVERGE', () => {
    const r = run(['--cases', casesFile('plain-case')]);
    expect(r.stdout).toContain('DIVERGE plain-case');
    expect(r.code).toBe(1);
  });

  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty'])(
    'does not silently accept a diverging case labelled %s',
    (label) => {
      // The bug: every inherited key resolved truthy, so a case with one of
      // these labels reported `accept` and the run exited 0 -- a parity
      // failure suppressed by the tool whose only job is finding them.
      const r = run(['--cases', casesFile(label)]);
      expect(r.stdout).toContain(`DIVERGE ${label}`);
      expect(r.stdout).not.toContain(`accept ${label}`);
      expect(r.code).toBe(1);
    },
  );

  it('still honours a genuine accept entry', () => {
    const r = run(['--cases', casesFile('known', { known: 'documented gap' })]);
    expect(r.stdout).toContain('accept known');
    expect(r.stdout).toContain('documented gap');
    expect(r.code).toBe(0);
  });
});

describe('exit contract', () => {
  it('returns a code instead of calling process.exit', () => {
    // main() used to be unexported and to exit the process, which is why none
    // of this file could have been written before.
    const r = run(['--cases', casesFile('plain-case')]);
    expect(typeof r.code).toBe('number');
  });
});
