/**
 * Behavioural tests for the security-ledger step of `.githooks/pre-commit`
 * (#1446, part 2).
 *
 * The hook used to regenerate the ledger whenever ANY non-ledger file was
 * staged, then `git add` both `.harness/security/timeline.json` and
 * `docs/SECURITY_LEDGER.md`. A commit touching one unrelated file therefore
 * picked up both, plus whatever snapshot a local `harness check-security` run
 * had appended to the timeline (#1446 part 1, an upstream CLI defect). That is
 * noise in unrelated diffs and a source of CHANGELOG-style merge conflicts.
 *
 * `scripts/security_ledger.mjs` derives its two outputs from exactly one data
 * input, the timeline, plus its own source. So the step now runs only when the
 * commit stages one of those, or the ledger itself. CI stays the canonical
 * writer: `harness-security.yml` refreshes the ledger after every scan on
 * `main`, and `harness-quality.yml`'s freshness guard fails a PR whose staged
 * timeline and ledger disagree.
 *
 * Hermetic: each case runs the real hook and the real ledger script in a
 * throwaway git repo. No markdown or `ts/` file is staged, so the markdownlint
 * and prettier gates never fire and nothing depends on the host's installs.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TIMELINE = '.harness/security/timeline.json';
const LEDGER = 'docs/SECURITY_LEDGER.md';
const LEDGER_SCRIPT = 'scripts/security_ledger.mjs';

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function snapshot(commitHash: string): Record<string, unknown> {
  return {
    capturedAt: '2026-10-01T00:00:00.000Z',
    commitHash,
    securityScore: 100,
    totalFindings: 0,
    bySeverity: { error: 0, warning: 0, info: 0 },
    supplyChain: { total: 0 },
    suppressionCount: 0,
  };
}

function timelineJson(hashes: string[]): string {
  return `${JSON.stringify(
    { snapshots: hashes.map(snapshot), findingLifecycles: [] },
    null,
    2,
  )}\n`;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

/**
 * A repo whose committed ledger is fresh for its committed timeline, so any
 * ledger diff after a hook run is the hook's doing.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canary-precommit-ledger-'));
  createdDirs.push(dir);
  git(dir, 'init', '--quiet');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');

  for (const rel of ['.githooks/pre-commit', LEDGER_SCRIPT]) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    cpSync(join(REPO_ROOT, rel), join(dir, rel));
  }
  chmodSync(join(dir, '.githooks', 'pre-commit'), 0o755);
  mkdirSync(join(dir, dirname(TIMELINE)), { recursive: true });
  writeFileSync(join(dir, TIMELINE), timelineJson(['aaaaaaa']));
  execFileSync('node', [LEDGER_SCRIPT], { cwd: dir });
  writeFileSync(join(dir, 'unrelated.txt'), 'v1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '--no-verify', '-m', 'seed');
  return dir;
}

function runHook(dir: string): void {
  execFileSync('bash', ['.githooks/pre-commit'], {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** `git status --porcelain` lines for the two ledger outputs only. */
function ledgerStatus(dir: string): string {
  return git(dir, 'status', '--porcelain', '--', TIMELINE, LEDGER).trimEnd();
}

function staged(dir: string): string[] {
  return git(dir, 'diff', '--cached', '--name-only')
    .split('\n')
    .filter(Boolean);
}

describe('pre-commit security-ledger step is scoped to its inputs (#1446)', () => {
  it('leaves the ledger untouched on an unrelated commit', () => {
    const dir = makeRepo();
    // A committed ledger that a regeneration WOULD change, so a hook that
    // still regenerates on unrelated commits cannot pass by producing
    // identical bytes.
    writeFileSync(join(dir, LEDGER), '# stale\n');
    git(dir, 'commit', '--quiet', '--no-verify', '-am', 'stale ledger');
    writeFileSync(join(dir, 'unrelated.txt'), 'v2\n');
    git(dir, 'add', 'unrelated.txt');

    runHook(dir);

    expect(staged(dir)).toEqual(['unrelated.txt']);
    expect(ledgerStatus(dir)).toBe('');
  });

  it('does not stage a stray local timeline snapshot into an unrelated commit', () => {
    const dir = makeRepo();
    // What a local `harness check-security` run leaves behind (#1446 part 1).
    const dirtyTimeline = timelineJson(['aaaaaaa', 'bbbbbbb']);
    writeFileSync(join(dir, TIMELINE), dirtyTimeline);
    writeFileSync(join(dir, 'unrelated.txt'), 'v2\n');
    git(dir, 'add', 'unrelated.txt');

    runHook(dir);

    expect(staged(dir)).toEqual(['unrelated.txt']);
    // The stray snapshot stays an unstaged edit, byte-for-byte as left, and
    // the ledger is not regenerated from it.
    expect(ledgerStatus(dir)).toBe(` M ${TIMELINE}`);
    expect(readFileSync(join(dir, TIMELINE), 'utf-8')).toBe(dirtyTimeline);
  });

  it('refreshes and stages the ledger when the timeline is staged', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, TIMELINE), timelineJson(['aaaaaaa', 'ccccccc']));
    git(dir, 'add', TIMELINE);

    runHook(dir);

    expect(staged(dir).sort()).toEqual([TIMELINE, LEDGER].sort());
    expect(readFileSync(join(dir, LEDGER), 'utf-8')).toContain('`ccccccc`');
    // Nothing left unstaged: the commit carries a fresh pair, which is what
    // the CI freshness guard checks.
    expect(ledgerStatus(dir)).toBe(`M  ${TIMELINE}\nM  ${LEDGER}`);
  });

  it('refreshes the ledger when the ledger script itself is staged', () => {
    const dir = makeRepo();
    // Simulate a stale ledger in the tree, then a change to its generator.
    writeFileSync(join(dir, LEDGER), '# stale\n');
    git(dir, 'add', LEDGER);
    git(dir, 'commit', '--quiet', '--no-verify', '-m', 'stale ledger');
    const script = readFileSync(join(dir, LEDGER_SCRIPT), 'utf-8');
    writeFileSync(join(dir, LEDGER_SCRIPT), `${script}// touched\n`);
    git(dir, 'add', LEDGER_SCRIPT);

    runHook(dir);

    expect(staged(dir)).toContain(LEDGER);
    expect(readFileSync(join(dir, LEDGER), 'utf-8')).toContain(
      '# Security Ledger',
    );
  });
});
