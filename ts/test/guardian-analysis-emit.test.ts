/**
 * Faithful TypeScript port of `tests/unit/test_guardian_analysis_emit.py`.
 *
 * Covers the v1.0 envelope builder + filename convention and the channel
 * availability / atomic write / loud-fallback signal. Deterministic: the
 * envelope is pure and the writer is exercised through temp dirs -- no network,
 * no real `.harness/`. The `os.replace` / `build_analysis_record` monkeypatches
 * become `vi.spyOn(emitSeams, ...)`.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  analysisFilename,
  buildAnalysisRecord,
  isChannelAvailable,
  emitAnalysis,
  emitSeams,
} from '../src/guardian/analysis-emit.js';
import { Fidelity } from '../src/guardian/coverage.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import { GuardianFinding, renderFindings } from '../src/guardian/pr-check.js';
import { mkTmp, rmTmp } from './guardian-cli-testkit.js';

function findings(): GuardianFinding[] {
  return [
    new GuardianFinding({
      path: 'pkg/a.py',
      unit: 'alpha',
      fidelity: Fidelity.GraphVerified,
      severity: Severity.HIGH,
      evidence: 'no covering test for alpha',
    }),
    new GuardianFinding({
      path: 'pkg/b.py',
      unit: 'beta',
      fidelity: Fidelity.Heuristic,
      severity: Severity.MEDIUM,
      evidence: 'no covering test for beta',
    }),
    new GuardianFinding({
      path: 'pkg/c.py',
      unit: 'gamma',
      fidelity: Fidelity.Heuristic,
      severity: Severity.MEDIUM,
      evidence: 'no covering test for gamma',
      suppressed: true,
      suppression_reason: 'canary:allow-untested legacy',
    }),
  ];
}

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmTmp(tmp);
});

describe('envelope', () => {
  it('top level fields', () => {
    const record = buildAnalysisRecord(findings(), {
      ref: 'pr-7',
      gate: 'hard',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 1,
      analyzed_at: '2026-07-19T00:00:00+00:00',
    });
    // #554: 1.1 adds the additive `coverage` block.
    // #582: 1.2 adds the additive `skipped` list.
    // #761: 1.3 adds the additive `provenance` block.
    expect(record.schemaVersion).toBe('1.3');
    expect(record.source).toBe('canary-pr-guardian');
    expect(record.ref).toBe('pr-7');
    expect(record.gate).toBe('hard');
    expect(record.exitCode).toBe(1);
    expect(record.tier).toBe(0);
    expect(record.degradedNotice).toBeNull();
    expect(record.analyzedAt).toBe('2026-07-19T00:00:00+00:00');
  });

  it('findings are verbatim renderFindings json', () => {
    const fs = findings();
    const record = buildAnalysisRecord(fs, {
      ref: 'pr-7',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
    });
    const expected = JSON.parse(renderFindings(fs, 'json', 0)).findings;
    expect(record.findings).toEqual(expected);
  });

  it('summary counts and byFidelity (first-seen order)', () => {
    const record = buildAnalysisRecord(findings(), {
      ref: 'pr-7',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
    });
    expect(record.summary.total).toBe(3);
    expect(record.summary.unaddressed).toBe(2);
    expect(record.summary.suppressed).toBe(1);
    expect(record.summary.byFidelity).toEqual({
      'graph-verified': 1,
      heuristic: 2,
    });
  });

  it('envelope carries checked/abstained additively (#508)', () => {
    const record = buildAnalysisRecord([], {
      ref: 'pr-1',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
      checked: 4,
      abstained: false,
    });
    expect(record.checked).toBe(4);
    expect(record.abstained).toBe(false);
  });

  it('fields default when a caller predates #508', () => {
    const record = buildAnalysisRecord([], {
      ref: 'pr-1',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
    });
    expect(record.checked).toBe(0);
    expect(record.abstained).toBe(false);
  });

  it('degraded notice propagates', () => {
    const record = buildAnalysisRecord(findings(), {
      ref: 'pr-7',
      gate: 'soft',
      effective_tier: 1,
      degraded_notice: 'tier 2 unavailable -- degraded to tier 1',
      exit_code: 0,
    });
    expect(record.tier).toBe(1);
    expect(record.degradedNotice).toBe(
      'tier 2 unavailable -- degraded to tier 1',
    );
  });

  it('analyzedAt defaults to iso utc (tz-aware, parseable)', () => {
    const record = buildAnalysisRecord(findings(), {
      ref: 'pr-7',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
    });
    expect(record.analyzedAt).toMatch(/\+00:00$/);
    expect(Number.isNaN(Date.parse(record.analyzedAt))).toBe(false);
  });
});

describe('filename', () => {
  it('pr ref', () => {
    expect(analysisFilename('pr-42')).toBe('canary-pr-guardian-pr-42.json');
  });

  it('unsafe chars sanitized', () => {
    expect(analysisFilename('feature/x y')).toBe(
      'canary-pr-guardian-feature-x-y.json',
    );
  });

  it('empty ref falls back to local', () => {
    expect(analysisFilename('')).toBe('canary-pr-guardian-local.json');
  });

  it('no path separator and safe charset', () => {
    const name = analysisFilename('a/b\\c:d');
    expect(name.includes('/')).toBe(false);
    expect(/^[A-Za-z0-9._-]+\.json$/.test(name)).toBe(true);
  });

  it('long ref is length capped', () => {
    const name = analysisFilename('x'.repeat(300));
    expect(name.startsWith('canary-pr-guardian-')).toBe(true);
    expect(name.endsWith('.json')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(140);
  });

  it('truncated refs disambiguate via hash', () => {
    const shared = 'y'.repeat(100);
    const a = analysisFilename(shared + '-alpha-tail' + 'z'.repeat(200));
    const b = analysisFilename(shared + '-bravo-tail' + 'z'.repeat(200));
    expect(a).not.toBe(b);
  });

  it('short ref unchanged, no hash suffix', () => {
    expect(analysisFilename('feature-x')).toBe(
      'canary-pr-guardian-feature-x.json',
    );
  });
});

describe('channel availability', () => {
  it('absent harness home is unavailable', () => {
    expect(isChannelAvailable(join(tmp, '.harness', 'analyses'))).toBe(false);
  });

  it('present harness home is available', () => {
    mkdirSync(join(tmp, '.harness'));
    expect(isChannelAvailable(join(tmp, '.harness', 'analyses'))).toBe(true);
  });
});

describe('emit write', () => {
  it('writes prefixed record when available', () => {
    mkdirSync(join(tmp, '.harness'));
    const analysesDir = join(tmp, '.harness', 'analyses');
    const res = emitAnalysis(findings(), {
      analysesDir,
      ref: 'pr-3',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
    });
    expect(res.action).toBe('emitted');
    expect(res.notice).toBeNull();
    const expected = join(analysesDir, 'canary-pr-guardian-pr-3.json');
    expect(res.path).toBe(expected);
    const record = JSON.parse(readFileSync(expected, 'utf-8'));
    expect(record.source).toBe('canary-pr-guardian');
  });
});

describe('atomic write', () => {
  it('no torn file and no leftover temp', () => {
    mkdirSync(join(tmp, '.harness'));
    const analysesDir = join(tmp, '.harness', 'analyses');
    const res = emitAnalysis(findings(), {
      analysesDir,
      ref: 'pr-3',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
    });
    expect(res.action).toBe('emitted');
    const target = join(analysesDir, 'canary-pr-guardian-pr-3.json');
    const record = JSON.parse(readFileSync(target, 'utf-8'));
    expect(record.source).toBe('canary-pr-guardian');
    expect(readdirSync(analysesDir)).toEqual(['canary-pr-guardian-pr-3.json']);
  });

  it('uses replace from a distinct same-dir temp to target', () => {
    mkdirSync(join(tmp, '.harness'));
    const analysesDir = join(tmp, '.harness', 'analyses');
    const target = join(analysesDir, 'canary-pr-guardian-pr-3.json');
    const calls: Array<[string, string]> = [];
    vi.spyOn(emitSeams, 'replace').mockImplementation(
      (src: string, dst: string) => {
        calls.push([src, dst]);
        // Delegate to the real rename so the file still materializes.
        renameSync(src, dst);
      },
    );
    const res = emitAnalysis(findings(), {
      analysesDir,
      ref: 'pr-3',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
    });
    expect(res.action).toBe('emitted');
    expect(calls.length).toBe(1);
    const [src, dst] = calls[0]!;
    expect(dst).toBe(target);
    expect(src).not.toBe(target);
    expect(src.startsWith(analysesDir)).toBe(true);
  });

  it('temp cleaned up when replace fails', () => {
    mkdirSync(join(tmp, '.harness'));
    const analysesDir = join(tmp, '.harness', 'analyses');
    vi.spyOn(emitSeams, 'replace').mockImplementation(() => {
      throw new Error('simulated rename failure');
    });
    const res = emitAnalysis(findings(), {
      analysesDir,
      ref: 'pr-3',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
    });
    expect(res.action).toBe('unavailable');
    expect(res.path).toBeNull();
    expect(res.notice).toContain('sticky comment');
    expect(readdirSync(analysesDir)).toEqual([]); // temp cleaned, dir empty
  });
});

describe('emit fallback', () => {
  it('absent channel returns loud notice and writes nothing', () => {
    const analysesDir = join(tmp, '.harness', 'analyses');
    const res = emitAnalysis(findings(), {
      analysesDir,
      ref: 'pr-3',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
    });
    expect(res.action).toBe('unavailable');
    expect(res.path).toBeNull();
    expect(res.notice).toContain('unavailable');
    expect(res.notice).toContain('sticky comment');
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('write error returns loud notice', () => {
    const harnessHome = join(tmp, '.harness');
    mkdirSync(harnessHome);
    chmodSync(harnessHome, 0o555);
    const probe = join(harnessHome, '.probe');
    let denied = false;
    try {
      writeFileSync(probe, 'x', 'utf-8');
    } catch {
      denied = true;
    }
    if (!denied) {
      chmodSync(harnessHome, 0o755);
      return; // running as root -- chmod does not deny; skip like the Python test
    }
    const analysesDir = join(harnessHome, 'analyses');
    let res;
    try {
      res = emitAnalysis(findings(), {
        analysesDir,
        ref: 'pr-3',
        gate: 'soft',
        effective_tier: 0,
        degraded_notice: null,
        exit_code: 0,
      });
    } finally {
      chmodSync(harnessHome, 0o755);
    }
    expect(res.action).toBe('unavailable');
    expect(res.path).toBeNull();
    expect(res.notice).toContain('write failed');
    expect(res.notice).toContain('sticky comment');
  });

  it('build error degrades not crashes', () => {
    mkdirSync(join(tmp, '.harness'));
    const analysesDir = join(tmp, '.harness', 'analyses');
    vi.spyOn(emitSeams, 'buildAnalysisRecord').mockImplementation(() => {
      throw new Error('simulated build failure');
    });
    const res = emitAnalysis(findings(), {
      analysesDir,
      ref: 'pr-3',
      gate: 'soft',
      effective_tier: 0,
      degraded_notice: null,
      exit_code: 0,
    });
    expect(res.action).toBe('unavailable');
    expect(res.path).toBeNull();
    expect(res.notice).toContain('sticky comment');
    // The build fails before `mkdir`, so nothing materialized.
    expect(existsSync(analysesDir)).toBe(false);
  });
});
