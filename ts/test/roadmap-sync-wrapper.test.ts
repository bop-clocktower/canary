/**
 * Contract tests for `scripts/roadmap-sync.mjs` (#595).
 *
 * The wrapper guards two different hazards, and only one of them has an upstream
 * flag:
 *
 * 1. Open/closed write-back — `--no-state-change` covers it, and the wrapper
 *    appends it unconditionally.
 * 2. Body replacement — nothing covers it. `updateTicket` sets
 *    `patch.body` from the row's `Summary`, so patching a linked issue
 *    overwrites whatever a human wrote there. All 38 rows are linked, so one
 *    `--apply` flattens 38 issue bodies. There is no `--no-patch`.
 *
 * So `--apply` requires `--i-know-this-rewrites-bodies`. Not a block — the
 * command is legitimate once someone has decided the roadmap should win — but it
 * cannot be reached by muscle memory.
 *
 * Tests drive a stub through `HARNESS_BIN` rather than invoking the real CLI, so
 * they assert the argv contract offline and never touch the network or the
 * tracker.
 */

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'roadmap-sync.mjs');
const OVERRIDE = '--i-know-this-rewrites-bodies';

interface Run {
  status: number;
  output: string;
  /** argv the stub saw, or null if it was never reached. */
  argv: string[] | null;
}

describe('roadmap-sync wrapper', () => {
  let dir: string;
  let stub: string;
  let argvLog: string;

  /** A fake `harness` that records its argv and exits with `exitCode`. */
  function writeStub(exitCode = 0): void {
    writeFileSync(
      stub,
      `#!/usr/bin/env node
require('node:fs').writeFileSync(
  ${JSON.stringify(argvLog)},
  JSON.stringify(process.argv.slice(2)),
);
process.exit(${exitCode});
`,
    );
    chmodSync(stub, 0o755);
  }

  /** argv the stub recorded, or null when it was never reached. */
  const recordedArgv = (): string[] | null => {
    try {
      return JSON.parse(readFileSync(argvLog, 'utf-8')) as string[];
    } catch {
      return null;
    }
  };

  const run = (...args: string[]): Run => {
    const { status, output } = runCapture(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, HARNESS_BIN: stub },
      failureStatus: 2,
    });
    return { status, output, argv: recordedArgv() };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'syncwrap-'));
    stub = join(dir, 'harness-stub.js');
    argvLog = join(dir, 'argv.json');
    writeStub();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses --apply without the override, before spawning anything', () => {
    const result = run('--apply');

    expect(result.status).toBe(2);
    expect(result.argv, 'harness must not run at all').toBeNull();
  });

  it('names the override flag and the reason in the refusal', () => {
    const { output } = run('--apply');

    expect(output).toContain(OVERRIDE);
    expect(output).toMatch(/body|bodies/i);
  });

  it('proceeds when the override is given', () => {
    const result = run('--apply', OVERRIDE);

    expect(result.status).toBe(0);
    expect(result.argv).toContain('--apply');
  });

  it('does not forward the override to harness, which would reject it', () => {
    expect(run('--apply', OVERRIDE).argv).not.toContain(OVERRIDE);
  });

  it('needs no override for a dry run — the default path stays frictionless', () => {
    const result = run();

    expect(result.status).toBe(0);
    expect(result.argv).not.toContain('--apply');
  });

  it('always appends --no-state-change', () => {
    expect(run().argv).toContain('--no-state-change');
    expect(run('--apply', OVERRIDE).argv).toContain('--no-state-change');
  });

  it('invokes the roadmap sync subcommand', () => {
    expect(run().argv?.slice(0, 3)).toEqual([
      'roadmap',
      'sync',
      '--no-state-change',
    ]);
  });

  it('passes other flags through untouched', () => {
    expect(run('--json', '--no-create').argv).toEqual(
      expect.arrayContaining(['--json', '--no-create']),
    );
  });

  it('forwards a non-zero exit code rather than flattening it', () => {
    // 3 is ZERO DENOMINATOR upstream — an abstention that must not read as 0.
    writeStub(3);
    expect(run().status).toBe(3);
  });
});
