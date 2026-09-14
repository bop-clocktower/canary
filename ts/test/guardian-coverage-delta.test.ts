/**
 * #606 — coverage REGRESSION on units a PR touches, versus base.
 *
 * The existing ladder answers "is this unit covered at all?". These tests pin
 * the second question: did coverage go *down* against a base-branch artifact —
 * and, when no base artifact exists, does the run degrade to a LOUD
 * "delta unavailable — head-only" rather than passing silently.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  coverageDeltaNotice,
  coverageDeltaStatus,
  resolveCoverageDelta,
  type ChangedUnit,
} from '../src/guardian/coverage.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-covdelta-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write an lcov report where `hits[line] = count` for one file. */
function writeLcov(
  name: string,
  files: Record<string, Record<number, number>>,
): string {
  const path = join(dir, name);
  const chunks: string[] = [];
  for (const [file, hits] of Object.entries(files)) {
    chunks.push(`SF:${file}`);
    for (const [line, count] of Object.entries(hits)) {
      chunks.push(`DA:${line},${count}`);
    }
    chunks.push('end_of_record');
  }
  writeFileSync(path, `${chunks.join('\n')}\n`, 'utf-8');
  return path;
}

const unit = (path: string): ChangedUnit => ({
  path,
  added_ranges: [[1, 4]],
});

describe('resolveCoverageDelta', () => {
  it('flags a touched unit whose covered ratio fell against base', () => {
    const base = writeLcov('base.info', {
      'src/a.ts': { 1: 1, 2: 1, 3: 1, 4: 1 },
    });
    const head = writeLcov('head.info', {
      'src/a.ts': { 1: 1, 2: 0, 3: 0, 4: 0 },
    });

    const { deltas, state } = resolveCoverageDelta([unit('src/a.ts')], {
      baseCoveragePath: base,
      headCoveragePath: head,
    });

    expect(state.unitsCompared).toBe(1);
    expect(state.unitsTotal).toBe(1);
    expect(coverageDeltaStatus(state)).toBe('compared');
    expect(deltas).toHaveLength(1);
    const delta = deltas[0]!;
    expect(delta.path).toBe('src/a.ts');
    expect(delta.regressed).toBe(true);
    expect(delta.base).toEqual({ covered: 4, coverable: 4 });
    expect(delta.head).toEqual({ covered: 1, coverable: 4 });
    // 100% -> 25% is a 75 percentage-point drop.
    expect(delta.dropPoints).toBeCloseTo(75, 6);
  });

  it('does not flag improved or unchanged coverage', () => {
    const base = writeLcov('base.info', {
      'src/up.ts': { 1: 0, 2: 0 },
      'src/flat.ts': { 1: 1, 2: 0 },
    });
    const head = writeLcov('head.info', {
      'src/up.ts': { 1: 1, 2: 1 },
      'src/flat.ts': { 1: 1, 2: 0 },
    });

    const { deltas, state } = resolveCoverageDelta(
      [unit('src/up.ts'), unit('src/flat.ts')],
      { baseCoveragePath: base, headCoveragePath: head },
    );

    expect(state.unitsCompared).toBe(2);
    expect(deltas.map((d) => d.regressed)).toEqual([false, false]);
    expect(deltas[0]!.dropPoints).toBeLessThanOrEqual(0);
  });

  it('never compares a unit whose base report records no coverable line', () => {
    // An empty record: the file is named but nothing was instrumented, so a
    // ratio would be 0/0 — a number guardian must not invent.
    const base = writeLcov('base.info', { 'src/a.ts': {} });
    const head = writeLcov('head.info', { 'src/a.ts': { 1: 0, 2: 0 } });

    const { deltas, state } = resolveCoverageDelta([unit('src/a.ts')], {
      baseCoveragePath: base,
      headCoveragePath: head,
    });

    expect(deltas).toHaveLength(0);
    expect(state.unitsCompared).toBe(0);
    expect(coverageDeltaStatus(state)).toBe('unavailable');
  });

  it('degrades to head-only when no base path is supplied', () => {
    const head = writeLcov('head.info', { 'src/a.ts': { 1: 1 } });

    const { deltas, state } = resolveCoverageDelta([unit('src/a.ts')], {
      baseCoveragePath: null,
      headCoveragePath: head,
    });

    expect(deltas).toHaveLength(0);
    expect(state.baseRequested).toBeNull();
    expect(state.baseFound).toBe(false);
    expect(state.baseParsed).toBe(false);
    expect(coverageDeltaStatus(state)).toBe('unavailable');

    const notice = coverageDeltaNotice(state);
    expect(notice).toContain('coverage delta unavailable');
    expect(notice).toContain('head-only');
    expect(notice).toContain('no base coverage report was supplied');
  });

  it('names the missing artifact when the base path does not exist', () => {
    const head = writeLcov('head.info', { 'src/a.ts': { 1: 1 } });
    const missing = join(dir, 'nope.info');

    const { state } = resolveCoverageDelta([unit('src/a.ts')], {
      baseCoveragePath: missing,
      headCoveragePath: head,
    });

    expect(state.baseFound).toBe(false);
    expect(coverageDeltaNotice(state)).toContain(missing);
  });

  it('separates a base report that is present but unusable from a missing one', () => {
    // #554's distinction, carried into the delta: "no base artifact" and "a
    // base artifact we could not read" are different operator problems — one
    // is a missing upload, the other a broken producer. A notice that blamed
    // both on absence would send the reader to the wrong fix.
    const head = writeLcov('head.info', { 'src/a.ts': { 1: 1 } });
    const unusable = join(dir, 'garbage.info');
    writeFileSync(unusable, 'not an lcov report at all\n', 'utf-8');

    const { state } = resolveCoverageDelta([unit('src/a.ts')], {
      baseCoveragePath: unusable,
      headCoveragePath: head,
    });

    expect(state.baseFound).toBe(true);
    expect(state.baseParsed).toBe(false);
    expect(coverageDeltaStatus(state)).toBe('unavailable');

    const notice = coverageDeltaNotice(state);
    expect(notice).toContain('yielded no usable records');
    expect(notice).toContain(unusable);
    // Not the missing-artifact wording — that is the branch above.
    expect(notice).not.toContain('not found at');
  });

  it('is unavailable — not compared — when the base report matches no unit', () => {
    const base = writeLcov('base.info', { 'src/other.ts': { 1: 1 } });
    const head = writeLcov('head.info', { 'src/a.ts': { 1: 1 } });

    const { state } = resolveCoverageDelta([unit('src/a.ts')], {
      baseCoveragePath: base,
      headCoveragePath: head,
    });

    expect(state.baseFound).toBe(true);
    expect(state.baseParsed).toBe(true);
    expect(state.filesInBaseReport).toBe(1);
    expect(state.unitsCompared).toBe(0);
    expect(coverageDeltaStatus(state)).toBe('unavailable');
    expect(coverageDeltaNotice(state)).toContain('matched 0 of 1');
  });

  it('reports partial when only some touched units could be compared', () => {
    const base = writeLcov('base.info', { 'src/a.ts': { 1: 1, 2: 1 } });
    const head = writeLcov('head.info', {
      'src/a.ts': { 1: 1, 2: 0 },
      'src/b.ts': { 1: 0 },
    });

    const { deltas, state } = resolveCoverageDelta(
      [unit('src/a.ts'), unit('src/b.ts')],
      { baseCoveragePath: base, headCoveragePath: head },
    );

    expect(state.unitsCompared).toBe(1);
    expect(state.unitsTotal).toBe(2);
    expect(coverageDeltaStatus(state)).toBe('partial');
    expect(deltas.map((d) => d.path)).toEqual(['src/a.ts']);
    expect(deltas[0]!.regressed).toBe(true);
    expect(coverageDeltaNotice(state)).toContain('coverage delta partial');
  });

  it('makes no claim, and no notice, when there were no units to judge', () => {
    const { deltas, state } = resolveCoverageDelta([], {
      baseCoveragePath: null,
      headCoveragePath: null,
    });

    expect(deltas).toHaveLength(0);
    expect(state.unitsTotal).toBe(0);
    expect(coverageDeltaNotice(state)).toBeNull();
  });

  it('degrades loudly when the head report is the one that is missing', () => {
    const base = writeLcov('base.info', { 'src/a.ts': { 1: 1 } });

    const { state } = resolveCoverageDelta([unit('src/a.ts')], {
      baseCoveragePath: base,
      headCoveragePath: null,
    });

    expect(state.unitsCompared).toBe(0);
    expect(coverageDeltaStatus(state)).toBe('unavailable');
    expect(coverageDeltaNotice(state)).toContain('coverage delta unavailable');
  });
});
