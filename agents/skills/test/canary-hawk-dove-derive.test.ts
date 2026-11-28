// canary-hawk-dove derived labels (#618): the three ADR 0025 guardian rules,
// each written once per (finding, rule), and every ambiguous case left
// unlabelled. Plus the argv-only git boundary they lean on.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { deriveLabels } from '../claude-code/canary-hawk-dove/scripts/derive.mjs';
import { changedFiles } from '../claude-code/canary-hawk-dove/scripts/git.mjs';

const AT = '2026-01-01T00:00:00.000Z';

interface F {
  id: string;
  fidelity?: string | null;
  suppressed?: boolean;
  reason?: string | null;
  file?: string;
}

function finding(f: F) {
  return {
    v: 1,
    kind: 'finding',
    gate: 'guardian',
    file: f.file ?? `${f.id}.ts`,
    rule: 'untested',
    anchor: 'u',
    fidelity: f.fidelity ?? 'coverage-verified',
    id: f.id,
  };
}

function state(findings: F[], runs: unknown[] = [], labels: unknown[] = []) {
  return {
    findings: new Map(findings.map((f) => [f.id, finding(f)])),
    runs,
    labels,
  };
}

const runOf = (id: string, pr: number | null, ids: F[], vouches = true) => ({
  v: 1,
  kind: 'run',
  run: id,
  gate: 'guardian',
  pr,
  at: AT,
  vouches,
  base: 'b',
  head: 'h',
  findings: ids.map((f) => ({
    id: f.id,
    suppressed: f.suppressed ?? false,
    reason: f.reason ?? null,
  })),
});

const changed = (files: string[]) => () => ({ files: new Set(files) });

describe('suppression rules', () => {
  it('fp: means noise, any other reason means intentional (ADR 0025)', () => {
    const a = { id: 'a', suppressed: true, reason: 'FP : type-only barrel' };
    const b = { id: 'b', suppressed: true, reason: 'generated code' };
    const s = state([a, b]);
    const run = runOf('run-1', null, [a, b]);
    const res = deriveLabels({ state: s, run, at: AT, changed: changed([]) });
    expect(res.labels.map((l) => [l.finding, l.outcome, l.rule])).toEqual([
      ['a', 'noise', 'guardian-fp-suppression'],
      ['b', 'intentional', 'guardian-reasoned-suppression'],
    ]);
    expect(res.labels[0]).toMatchObject({
      kind: 'label',
      by: 'derived',
      at: AT,
      evidence: 'run run-1: FP : type-only barrel',
    });
  });

  it('writes a derived label once per (finding, rule)', () => {
    const a = { id: 'a', suppressed: true, reason: 'fp: x' };
    const prior = {
      kind: 'label',
      finding: 'a',
      rule: 'guardian-fp-suppression',
    };
    const s = state([a], [], [prior]);
    const res = deriveLabels({
      state: s,
      run: runOf('run-2', null, [a]),
      at: AT,
      changed: changed([]),
    });
    expect(res.labels).toEqual([]);
  });

  it('derives nothing for a gate other than the guardian', () => {
    const a = { id: 'a', suppressed: true, reason: 'fp: x' };
    const run = { ...runOf('run-1', null, [a]), gate: 'savant' };
    const res = deriveLabels({
      state: state([a]),
      run,
      at: AT,
      changed: changed([]),
    });
    expect(res.labels).toEqual([]);
  });
});

describe('guardian-covered-later', () => {
  const a = { id: 'a', file: 'src/a.ts' };

  it('a coverage-verified finding gone from a later vouching run, file still in the diff, is real', () => {
    const first = runOf('run-1', 7, [a]);
    const later = runOf('run-2', 7, []);
    const res = deriveLabels({
      state: state([a], [first]),
      run: later,
      at: AT,
      changed: changed(['src/a.ts']),
    });
    expect(res.labels).toHaveLength(1);
    expect(res.labels[0]).toMatchObject({
      finding: 'a',
      outcome: 'real',
      rule: 'guardian-covered-later',
      evidence: 'run run-1 -> run run-2, PR 7',
    });
  });

  it.each([
    ['the later run does not vouch', { vouches: false }, ['src/a.ts']],
    ['the file left the diff', {}, ['src/other.ts']],
  ])('%s: ambiguous, no label', (_why, over, files) => {
    const first = runOf('run-1', 7, [a]);
    const later = { ...runOf('run-2', 7, []), ...over };
    const res = deriveLabels({
      state: state([a], [first]),
      run: later,
      at: AT,
      changed: changed(files),
    });
    expect(res.labels).toEqual([]);
    expect(res.ambiguous).toBe(1);
  });

  it('git unavailable: ambiguous, no label', () => {
    const res = deriveLabels({
      state: state([a], [runOf('run-1', 7, [a])]),
      run: runOf('run-2', 7, []),
      at: AT,
      changed: () => ({ unknown: 'git could not diff the run endpoints' }),
    });
    expect(res.labels).toEqual([]);
    expect(res.ambiguous).toBe(1);
  });

  it('still present: unresolved, no label', () => {
    const res = deriveLabels({
      state: state([a], [runOf('run-1', 7, [a])]),
      run: runOf('run-2', 7, [a]),
      at: AT,
      changed: changed(['src/a.ts']),
    });
    expect(res.labels).toEqual([]);
    expect(res.unresolved).toBe(1);
  });

  it('a heuristic finding that disappears is ambiguous, not real', () => {
    const h = { id: 'h', file: 'src/h.ts', fidelity: 'heuristic' };
    const res = deriveLabels({
      state: state([h], [runOf('run-1', 7, [h])]),
      run: runOf('run-2', 7, []),
      at: AT,
      changed: changed(['src/h.ts']),
    });
    expect(res.labels).toEqual([]);
    expect(res.ambiguous).toBe(1);
  });

  it('compares only runs of the same PR, and needs a PR at all', () => {
    const other = runOf('run-1', 8, [a]);
    const s = state([a], [other]);
    const opts = { at: AT, changed: changed(['src/a.ts']) };
    expect(
      deriveLabels({ ...opts, state: s, run: runOf('run-2', 7, []) }).labels,
    ).toEqual([]);
    expect(
      deriveLabels({ ...opts, state: s, run: runOf('run-2', null, []) }).labels,
    ).toEqual([]);
  });
});

describe('changedFiles (argv-only git)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  function repo(): { dir: string; base: string; head: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-git-'));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'synthetic@example.invalid');
    git('config', 'user.name', 'Synthetic Labeller');
    fs.writeFileSync(path.join(dir, 'a.ts'), '1');
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'b.ts'), '2');
    git('add', '.');
    git('commit', '-q', '-m', 'two');
    return { dir, base, head: git('rev-parse', 'HEAD') };
  }

  it('lists the paths between two revisions', () => {
    const { dir, base, head } = repo();
    expect(changedFiles(dir, base, head)).toEqual({ files: new Set(['b.ts']) });
  });

  it('rejects a revision that git would read as an option', () => {
    const { dir, head } = repo();
    expect(changedFiles(dir, '--output=/tmp/x', head)).toEqual({
      unknown: 'the run names an invalid revision',
    });
  });

  it('reports a missing endpoint or an unknown revision as unknown', () => {
    const { dir, head } = repo();
    expect(changedFiles(dir, null, head).unknown).toBe(
      'the run names no diff endpoints',
    );
    expect(changedFiles(dir, 'f'.repeat(40), head).unknown).toBe(
      'git could not diff the run endpoints',
    );
  });
});
