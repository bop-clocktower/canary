/**
 * #1040 — a failure has to be visible from the exit code AND the stream.
 *
 * #1007 (PR #1036) fixed the exit-code half for `canary run` and for `canary
 * init <unknown-framework>`. The same review listed three places where the CLI
 * still hides a failure from a caller and deliberately left them:
 *
 *   1. `init <known-framework>` with no template (status `unsupported`) exited
 *      0 — a script saw success when nothing was scaffolded.
 *   2. `migrate`, `heal-test` and `ticket-update` exited 1 but printed the
 *      error on stdout, so a caller capturing stdout as data got an error
 *      message mixed into it and a caller watching stderr saw nothing.
 *   3. `run` echoed the runner's stderr on stdout, so runner diagnostics could
 *      not be separated from output.
 *
 * Each assertion below checks BOTH streams: that the message reached stderr,
 * and that it is absent from stdout. Asserting only the first would pass on a
 * command that writes the error to both, which is the same unusable-stdout
 * problem this fixes.
 *
 * These are contract changes on a pinned surface — see CHANGELOG.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { invokeCanary } from './canary-cli-testkit.js';

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'canary-1040-'));
}
function rmTmp(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

/** A scaffolder whose framework is known to the registry but has no template. */
function unsupportedScaffolder() {
  return {
    scaffold: (framework: string) => ({
      framework,
      status: 'unsupported',
      created_files: [],
      created_dirs: [],
      skipped_files: [],
      guidance: `No scaffold template for '${framework}' yet.`,
      execution_command: null,
    }),
  };
}

describe('#1040 init: an unsupported framework is not a success', () => {
  it('exits 2 with the guidance on stderr, not stdout', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['init', 'cucumber'], {
        cwd: tmp,
        deps: { makeScaffolder: unsupportedScaffolder as never },
      });
      // 2, matching the unknown-framework case: both mean "nothing was
      // scaffolded and it is the caller's invocation that has to change".
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('No scaffold template');
      expect(res.stdout).not.toContain('No scaffold template');
    } finally {
      rmTmp(tmp);
    }
  });

  it('does not claim scaffolding completed', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['init', 'cucumber'], {
        cwd: tmp,
        deps: { makeScaffolder: unsupportedScaffolder as never },
      });
      expect(res.stdout).not.toContain('Scaffolding Complete');
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('#1040 run: runner stderr stays on stderr', () => {
  const executor = (exitCode: number) => () => ({
    execute: () => [exitCode, 'runner stdout line', 'runner stderr line'],
  });

  it('passes the runner stderr through to stderr on a failure', async () => {
    const res = await invokeCanary(['run', 'x.spec.ts', 'playwright'], {
      deps: { makeExecutor: executor(1) as never },
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('runner stderr line');
    expect(res.stdout).not.toContain('runner stderr line');
  });

  it('still puts the runner stdout on stdout', async () => {
    const res = await invokeCanary(['run', 'x.spec.ts', 'playwright'], {
      deps: { makeExecutor: executor(0) as never },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('runner stdout line');
  });
});

describe('#1040 heal-test: errors go to stderr', () => {
  it('a missing file reports on stderr and exits 1', async () => {
    const res = await invokeCanary(['heal-test', '/nope/missing-file.spec.ts']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('is not a file');
    expect(res.stdout).not.toContain('is not a file');
  });
});

describe('#1040 ticket-update: errors go to stderr', () => {
  it('an unreadable result file reports on stderr and exits 1', async () => {
    const tmp = mkTmp();
    try {
      const bad = join(tmp, 'result.json');
      writeFileSync(bad, 'not json at all');
      const res = await invokeCanary(['ticket-update', '--result', bad]);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('Could not read result file');
      expect(res.stdout).not.toContain('Could not read result file');
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('#1040 migrate: errors go to stderr', () => {
  it('a non-harness project reports on stderr and exits 1', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['migrate', '--path', tmp]);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('harness');
      expect(res.stdout).not.toContain('No harness project detected');
    } finally {
      rmTmp(tmp);
    }
  });
});
