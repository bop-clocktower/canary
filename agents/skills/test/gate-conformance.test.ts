/**
 * Gate-abstention conformance suite -- SKILL layer (#508, no-silent-abstention
 * D5).
 *
 * The engine registry lives in `ts/test/gate-conformance.test.ts` and the npm
 * registry in `npm/scripts/__tests__/gate-conformance.test.js`; this file is the
 * skill half. It cannot live with either: skill CLIs are deliberately
 * self-contained `.mjs` entry points that import no engine code, so they honour
 * the doctrine by CONVENTION (a hand-written `ABSTAINED_LINE` matching
 * `gateOutcome`'s wording) rather than by calling the helper. This registry is
 * the mechanism that holds them to that convention -- without it, "by
 * convention" means "by nobody".
 *
 * Each row collapses a CLI's denominator to zero and asserts the loud outcome,
 * plus the absence of the success copy it used to print.
 *
 * Skill CLIs are ADVISORY by default (D3): they exit 0 unless `--strict` is
 * passed. Under `--strict` they carry an exit-code contract, so a collapsed
 * denominator inherits EXIT_ABSTAINED (3) -- distinct from 1, which means
 * "found something real".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, afterEach } from 'vitest';

import { main as blackhawkMain } from '../claude-code/canary-blackhawk/scripts/cli.mjs';
import { main as savantMain } from '../claude-code/canary-savant/scripts/cli.mjs';
import { main as katanaMain } from '../claude-code/canary-katana/scripts/cli.mjs';
import { main as cassandraMain } from '../claude-code/canary-cassandra/scripts/cli.mjs';

/** Exit code reserved CLI-wide for "abstained" (D4, mirrors gate-result.ts). */
const EXIT_ABSTAINED = 3;

const tmps: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-skill-conf-'));
  tmps.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) {
    fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  }
});

/** Run a skill `main`, capturing everything it logs. */
function run(
  main: (argv: string[]) => number,
  argv: string[],
): { code: number; stdout: string } {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  const code = main(argv);
  return { code, stdout: out.join('\n') };
}

interface SkillGateRow {
  command: string;
  /** Success copy that must NEVER appear on a zero denominator. */
  forbid: string[];
  /** Build the zero-denominator fixture and run the real CLI (advisory). */
  run: (base: string) => { code: number; stdout: string };
  /** The same fixture under `--strict`, which must inherit exit 3. */
  strict: (base: string) => { code: number; stdout: string };
}

const ROWS: SkillGateRow[] = [
  {
    command: 'canary-blackhawk (zero scanned files)',
    forbid: ['No temporal-dependency findings'],
    run: (base) => run(blackhawkMain, [base]),
    strict: (base) => run(blackhawkMain, [base, '--strict']),
  },
  {
    command: 'canary-savant (zero scanned files)',
    forbid: ['No order-dependence'],
    run: (base) => run(savantMain, [base]),
    strict: (base) => run(savantMain, [base, '--strict']),
  },
  {
    command: 'canary-cassandra (zero tests read)',
    forbid: ['Advisory by default'],
    run: (base) => run(cassandraMain, [base]),
    strict: (base) => run(cassandraMain, [base, '--strict']),
  },
  {
    command: 'canary-katana (empty diff)',
    forbid: ['0 deletion(s) captured'],
    run: (base) =>
      run(katanaMain, ['--repo', base, '--diff-file', emptyDiff(base)]),
    strict: (base) =>
      run(katanaMain, [
        '--repo',
        base,
        '--diff-file',
        emptyDiff(base),
        '--strict',
      ]),
  },
];

/** An existing but empty diff file: `loadDiff` succeeds and returns nothing. */
function emptyDiff(base: string): string {
  const file = path.join(base, 'empty.diff');
  fs.writeFileSync(file, '', 'utf-8');
  return file;
}

describe('gate conformance registry -- skill layer (#508)', () => {
  for (const row of ROWS) {
    it(`${row.command} is loud on a zero denominator`, () => {
      const res = row.run(tmp());
      expect(res.stdout.toLowerCase()).toContain('abstained');
      for (const text of row.forbid) {
        expect(res.stdout).not.toContain(text);
      }
      // Advisory by default: the line is loud, the exit is not (D3).
      expect(res.code).toBe(0);
    });

    it(`${row.command} inherits exit 3 under --strict`, () => {
      const res = row.strict(tmp());
      expect(res.code).toBe(EXIT_ABSTAINED);
    });
  }
});
