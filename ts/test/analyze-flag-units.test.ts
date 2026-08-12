/**
 * Unit-bearing flag names for `canary analyze` (#673).
 *
 * The three numeric thresholds carried silent units: the report printed
 * `window: 30 runs`, `20.0pp increase`, and `>= 10.0%`, but the flags a user
 * types said only `--window`, `--delta`, `--min-rate`. #670 fixed the same
 * defect one layer down (`windowRuns` / `deltaPp` / `minRatePct` in
 * `analysis/reports.ts`) and deliberately stopped at the CLI boundary, because
 * renaming a flag is a user-visible change.
 *
 * These tests pin the three halves of the fix:
 *   - the canonical flags name their unit, and the help text spells it out;
 *   - the pre-#673 spellings still work, as deprecated aliases with a note;
 *   - a value that cannot mean what the unit says is a usage error (exit 2),
 *     not a silently-NaN threshold that abstains without saying so.
 */

import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { createAnalyzeCommand } from '../src/analysis/cli.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

/** A temp cwd holding one run, enough for every history-backed subcommand. */
function seededCwd(): string {
  const tmp = mkTmp();
  const path = join(tmp, HISTORY_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      run_id: 'r1',
      suite: 'checkout',
      timestamp: '2026-07-02T00:00:00Z',
      passed: 1,
      failed: 1,
      flaky: 1,
      total: 3,
      tests: [
        { test_name: 'test_ok', status: 'passed' },
        { test_name: 'test_flaky', status: 'flaky', error_text: 'Timeout' },
      ],
    }) + '\n',
    'utf-8',
  );
  return tmp;
}

/**
 * `--help` text for one analyze subcommand, straight off the command tree,
 * with whitespace collapsed. Commander wraps descriptions to the terminal
 * width, so an un-collapsed assertion would break on the wrap column rather
 * than on the wording.
 */
function helpFor(sub: string): string {
  const cmd = createAnalyzeCommand({ out: () => {}, err: () => {} });
  const found = cmd.commands.find((c) => c.name() === sub);
  if (!found) throw new Error(`no analyze subcommand named ${sub}`);
  return found.helpInformation().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Naming + help text
// ---------------------------------------------------------------------------

describe('the flag name carries the unit', () => {
  it('flaky offers --window-runs and says the window counts runs', () => {
    const help = helpFor('flaky');
    expect(help).toContain('--window-runs');
    expect(help.toLowerCase()).toContain('runs');
  });

  it('flaky offers --min-rate-pct and says 10 means ten percent', () => {
    const help = helpFor('flaky');
    expect(help).toContain('--min-rate-pct');
    expect(help.toLowerCase()).toContain('percent');
    // The trap the issue calls out: 0.1 read as "10%".
    expect(help).toContain('0.1');
  });

  it('spikes offers --delta-pp and says percentage points', () => {
    const help = helpFor('spikes');
    expect(help).toContain('--delta-pp');
    expect(help.toLowerCase()).toContain('percentage-point');
  });

  it('digest offers both --window-runs and --delta-pp', () => {
    const help = helpFor('digest');
    expect(help).toContain('--window-runs');
    expect(help).toContain('--delta-pp');
  });

  it('marks each pre-#673 spelling as a deprecated alias', () => {
    expect(helpFor('flaky')).toContain('Deprecated alias for --window-runs');
    expect(helpFor('flaky')).toContain('Deprecated alias for --min-rate-pct');
    expect(helpFor('spikes')).toContain('Deprecated alias for --delta-pp');
    expect(helpFor('digest')).toContain('Deprecated alias for --window-runs');
    expect(helpFor('digest')).toContain('Deprecated alias for --delta-pp');
  });

  it('leaves no analyze option without a description', () => {
    // A blank description is how the silent unit survived: the value's meaning
    // lived only in the report it eventually printed. Enumerated from the
    // command tree so a NEW option cannot reintroduce the gap unnoticed.
    const cmd = createAnalyzeCommand({ out: () => {}, err: () => {} });
    const blank: string[] = [];
    for (const sub of cmd.commands) {
      for (const opt of sub.options) {
        if (!opt.description) blank.push(`${sub.name()} ${opt.flags}`);
      }
    }
    expect(blank).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('the pre-#673 spellings still work', () => {
  it('--window still sets the window and the report agrees', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(
        ['analyze', 'flaky', '--window', '5', '--min-rate', '0'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('window: 5 runs');
    } finally {
      rmTmp(tmp);
    }
  });

  it('--window warns on stderr and names its replacement', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(
        ['analyze', 'flaky', '--window', '5', '--min-rate', '0'],
        { cwd: tmp },
      );
      expect(res.stderr).toContain('--window is deprecated');
      expect(res.stderr).toContain('--window-runs');
      // The note must not pollute the report itself.
      expect(res.stdout).not.toContain('deprecated');
    } finally {
      rmTmp(tmp);
    }
  });

  it('--min-rate still sets the threshold the header prints', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(
        ['analyze', 'flaky', '--min-rate', '2.5'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('2.5%');
      expect(res.stderr).toContain('--min-rate-pct');
    } finally {
      rmTmp(tmp);
    }
  });

  it('--delta still sets the spike threshold', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(['analyze', 'spikes', '--delta', '35'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('35.0pp');
      expect(res.stderr).toContain('--delta-pp');
    } finally {
      rmTmp(tmp);
    }
  });

  it('digest accepts the deprecated --window / --delta pair', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(
        ['analyze', 'digest', '--window', '7', '--delta', '35'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('window: 7 runs');
      expect(res.stdout).toContain('35.0pp');
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('the canonical spellings', () => {
  it('--window-runs / --min-rate-pct drive the report', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(
        ['analyze', 'flaky', '--window-runs', '5', '--min-rate-pct', '2.5'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('window: 5 runs');
      expect(res.stdout).toContain('2.5%');
    } finally {
      rmTmp(tmp);
    }
  });

  it('emit no deprecation note', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(
        ['analyze', 'flaky', '--window-runs', '5', '--min-rate-pct', '0'],
        { cwd: tmp },
      );
      expect(res.stderr).not.toContain('deprecated');
    } finally {
      rmTmp(tmp);
    }
  });

  it('win when both spellings are given', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(
        [
          'analyze',
          'flaky',
          '--window',
          '5',
          '--window-runs',
          '9',
          '--min-rate',
          '0',
        ],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('window: 9 runs');
    } finally {
      rmTmp(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation
//
// Before #673 every one of these parsed to NaN and was handed to the query
// layer, which compared against it and found nothing -- a silent abstention
// dressed as a clean fleet.
// ---------------------------------------------------------------------------

describe('a value that cannot carry the unit is a usage error', () => {
  const cases: [string, string[]][] = [
    ['a non-numeric window', ['--window-runs', 'seven']],
    ['a zero-run window', ['--window-runs', '0']],
    ['a fractional window', ['--window-runs', '7.5']],
    ['a negative window', ['--window-runs=-7']],
    ['a non-numeric rate', ['--min-rate-pct', 'half']],
    ['a rate above 100%', ['--min-rate-pct', '150']],
    ['a negative rate', ['--min-rate-pct=-1']],
  ];

  for (const [label, args] of cases) {
    it(`rejects ${label}`, async () => {
      const tmp = seededCwd();
      try {
        const res = await invokeCanary(['analyze', 'flaky', ...args], {
          cwd: tmp,
        });
        expect(res.code).toBe(2);
      } finally {
        rmTmp(tmp);
      }
    });
  }

  it('rejects a delta above 100 percentage points', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(
        ['analyze', 'spikes', '--delta-pp', '150'],
        { cwd: tmp },
      );
      expect(res.code).toBe(2);
    } finally {
      rmTmp(tmp);
    }
  });

  it('validates the deprecated spelling exactly as strictly', async () => {
    const tmp = seededCwd();
    try {
      const res = await invokeCanary(['analyze', 'flaky', '--window', 'lots'], {
        cwd: tmp,
      });
      expect(res.code).toBe(2);
    } finally {
      rmTmp(tmp);
    }
  });

  it('states the unit and an example in the rejection message', async () => {
    const cmd = createAnalyzeCommand({ out: () => {}, err: () => {} });
    cmd.configureOutput({ writeErr: () => {} });
    let message = '';
    try {
      await cmd.parseAsync(['flaky', '--min-rate-pct', '150'], {
        from: 'user',
      });
    } catch (e) {
      if (!(e instanceof CommanderError)) throw e;
      message = e.message;
    }
    expect(message).toContain('--min-rate-pct');
    expect(message).toContain('percent');
    expect(message).toContain('150');
  });
});
