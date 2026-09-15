/**
 * Tree mode for the leak gate (#843, ADR 0023 rule 3).
 *
 * Under `pull_request_target` the checkout is BASE. Scanning it would report a
 * green about the wrong tree, which is the false-green shape this gate exists
 * to refuse. So the scanner reads the PR head commit's blobs straight from the
 * object store (`CANARY_LEAK_SCAN_TREE=<sha>`), never materialising head files
 * on disk.
 *
 * The decisive cases are the crossed ones: a leak only in the commit must fail
 * over a clean working tree, and a clean commit must pass over a dirty one.
 * Either alone could be satisfied by a scanner that ignored the variable.
 *
 * NOTE FOR EDITORS: this file is scanned by the gate. Offenders are synthetic.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check_removed_symbols.mjs');
const FIXTURE_TERM = 'Quuxlander';

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf-8');
}

/** A fixture repo with one commit of `files`; returns [root, sha]. */
function committed(files: Record<string, string>): [string, string] {
  const root = mkdtempSync(join(tmpdir(), 'leak-tree-'));
  roots.push(root);
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', root, ...a], { encoding: 'utf-8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return [root, git('rev-parse', 'HEAD')];
}

function gitIn(root: string, ...a: string[]): string {
  return execFileSync('git', ['-C', root, ...a], { encoding: 'utf-8' }).trim();
}

function run(root: string, extra: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CANARY_LEAK_SCAN_ROOT: root,
    CANARY_PROPRIETARY_DENYLIST: FIXTURE_TERM,
    CANARY_LEAK_SCAN_TREE: undefined,
    GITHUB_EVENT_NAME: undefined,
    GITHUB_BASE_REF: undefined,
    GITHUB_EVENT_BEFORE: undefined,
    CANARY_AUTHOR_RANGE: undefined,
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8', env });
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

describe('leak gate tree mode reads the named commit, not the working tree', () => {
  it('fails on a leak present only in the commit (working tree clean)', () => {
    const [root, sha] = committed({
      'src/widget.ts': `// for ${FIXTURE_TERM}\n`,
    });
    write(root, 'src/widget.ts', 'export const clean = 1;\n');

    const { status, out } = run(root, { CANARY_LEAK_SCAN_TREE: sha });

    expect(out).toContain('src/widget.ts');
    expect(out).toContain(`scanned commit ${sha}`);
    expect(status).toBe(1);
  });

  it('passes a clean commit even when the working tree carries the term', () => {
    const [root, sha] = committed({ 'docs/notes.md': 'Nothing here.\n' });
    write(root, 'docs/notes.md', `Shipped for ${FIXTURE_TERM}.\n`);

    const { status, out } = run(root, { CANARY_LEAK_SCAN_TREE: sha });

    expect(out).toContain('clean');
    expect(status).toBe(0);
  });

  it('fails a removed-symbol reference inside an included path of the commit', () => {
    const [root, sha] = committed({
      'docs/guides/run.md': 'Run `python3 -m agent.cli` to start.\n',
    });
    write(root, 'docs/guides/run.md', 'fine\n');

    const { status, out } = run(root, { CANARY_LEAK_SCAN_TREE: sha });

    expect(out).toContain('docs/guides/run.md');
    expect(status).toBe(1);
  });

  it('does not follow a symlink committed in the head tree', () => {
    const outside = mkdtempSync(join(tmpdir(), 'leak-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'secret.md'), `${FIXTURE_TERM}\n`, 'utf-8');
    const [root] = committed({ 'docs/a.md': 'ok\n' });
    symlinkSync(join(outside, 'secret.md'), join(root, 'docs', 'link.md'));
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-q', '-m', 'link');
    const sha = gitIn(root, 'rev-parse', 'HEAD');

    const { status, out } = run(root, { CANARY_LEAK_SCAN_TREE: sha });

    expect(out).not.toContain('docs/link.md');
    expect(status).toBe(0);
  });

  it('abstains when the named commit does not resolve', () => {
    const [root] = committed({ 'docs/a.md': 'ok\n' });

    const { status, out } = run(root, {
      CANARY_LEAK_SCAN_TREE: 'f'.repeat(40),
    });

    expect(out).toMatch(/ABSTAIN/);
    expect(status).toBe(1);
  });

  it('rejects a value that is not a full commit SHA', () => {
    const [root] = committed({ 'docs/a.md': 'ok\n' });

    const { status, out } = run(root, { CANARY_LEAK_SCAN_TREE: 'HEAD' });

    expect(out).toMatch(/ABSTAIN/);
    expect(status).toBe(1);
  });

  it('withholds the matched line text in a pull_request_target log', () => {
    // Two guesses, one per file: the log must not reveal which one matched.
    const [root, sha] = committed({
      'docs/probe-a.md': `guess list: ${FIXTURE_TERM}\n`,
      'docs/probe-b.md': 'guess list: Nonmatchia\n',
    });

    const { status, out } = run(root, {
      CANARY_LEAK_SCAN_TREE: sha,
      GITHUB_EVENT_NAME: 'pull_request_target',
    });

    expect(out).toContain('withheld');
    expect(out).not.toContain('probe-a');
    expect(out).not.toContain('guess list');
    expect(status).toBe(1);
  });

  it('never prints matched head content at column zero (workflow commands)', () => {
    const [root, sha] = committed({
      'docs/guides/cmd.md': '::error::agent.cli spoof\n',
    });

    const { status, out } = run(root, { CANARY_LEAK_SCAN_TREE: sha });

    expect(status).toBe(1);
    expect(out.split('\n').some((l) => l.startsWith('::'))).toBe(false);
  });

  it('refuses to scan the base checkout under pull_request_target', () => {
    const [root] = committed({ 'docs/a.md': 'ok\n' });

    const { status, out } = run(root, {
      GITHUB_EVENT_NAME: 'pull_request_target',
    });

    expect(out).toMatch(/ABSTAIN/);
    expect(out).toContain('CANARY_LEAK_SCAN_TREE');
    expect(status).toBe(1);
  });
});
