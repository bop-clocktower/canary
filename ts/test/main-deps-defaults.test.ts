/**
 * Branch coverage for the production `defaultMainDeps()` seams (#481).
 *
 * Every CLI test injects fakes over these seams, so the real implementations —
 * the subprocess wrapper's cwd/inherit/spawn-failure handling and the stdin
 * prompt's exhaustion fallback — were the one part of the dependency layer no
 * test drove. They are the seams production actually runs.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { defaultMainDeps } from '../src/main-deps.js';

describe('defaultMainDeps().runSubprocess', () => {
  it('captures stdout and the exit status of a real command', () => {
    const res = defaultMainDeps().runSubprocess('node', [
      '-e',
      'console.log(1)',
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('1');
  });

  it('passes a non-zero exit status through', () => {
    const res = defaultMainDeps().runSubprocess('node', [
      '-e',
      'process.exit(3)',
    ]);
    expect(res.status).toBe(3);
  });

  it('captures stderr separately from stdout', () => {
    const res = defaultMainDeps().runSubprocess('node', [
      '-e',
      'console.error("boom")',
    ]);
    expect(res.stderr).toContain('boom');
    expect(res.stdout).toBe('');
  });

  it('honours the cwd option', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-deps-'));
    try {
      const res = defaultMainDeps().runSubprocess(
        'node',
        ['-e', 'process.stdout.write(process.cwd())'],
        { cwd: dir },
      );
      // macOS reports /private/var for a /var temp dir, so compare the leaf.
      expect(res.stdout).toContain(join(dir).split('/').pop()!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a spawn failure as status null rather than a silent 0', () => {
    const res = defaultMainDeps().runSubprocess(
      'canary-no-such-binary-exists',
      [],
    );
    expect(res.status).toBeNull();
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });

  it('inherit: true forwards the streams, so nothing is captured', () => {
    const res = defaultMainDeps().runSubprocess(
      'node',
      ['-e', 'console.log("inherited")'],
      { inherit: true },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });
});

describe('defaultMainDeps() process-backed values', () => {
  it('reports the bare-factory version fallback rather than throwing', () => {
    // The npm bin injects the real version; the bare factory is the
    // PackageNotFoundError shape.
    expect(defaultMainDeps().pkgVersion()).toBe('unknown');
  });

  it('exposes the live cwd, home, env and python interpreter', () => {
    const deps = defaultMainDeps();
    expect(deps.cwd()).toBe(process.cwd());
    expect(deps.home()).toBeTruthy();
    expect(deps.env).toBe(process.env);
    expect(deps.pythonExe()).toBe('python3');
  });

  it('openBrowser is a no-op that never throws', () => {
    expect(() =>
      defaultMainDeps().openBrowser('https://example.com'),
    ).not.toThrow();
  });

  it('constructs every injected collaborator without arguments', () => {
    const deps = defaultMainDeps();
    for (const make of [
      deps.makeClassifier,
      deps.makeRecommender,
      deps.makeRegistry,
      deps.makeExecutor,
      deps.makeScaffolder,
      deps.makeMigrator,
      deps.makeLinter,
      deps.makeHealer,
      deps.makeSkillRegistry,
      deps.makeWorkflowDiscovery,
      deps.makeTicketUpdater,
    ]) {
      expect(make()).toBeDefined();
    }
    expect(deps.loadCompanyKnowledge(null)).toBeDefined();
  });
});

// NOT COVERED, deliberately: `defaultMainDeps().prompt` is the stdin-backed
// `makeStdinPrompt` reader. Its first call does a blocking `readFileSync(0)`,
// which under vitest inherits the runner's stdin and hangs the worker rather
// than returning — there is no way to drive it in-process without redirecting
// fd 0 for the whole run. The behaviour it implements (consume piped lines,
// then fall back to the shown default) is covered at the CLI level through the
// injected `prompt` seam in company-knowledge-cli-branches.test.ts.

describe('defaultMainDeps() sinks', () => {
  it('writes each line to the real stdout/stderr with a trailing newline', () => {
    const deps = defaultMainDeps();
    const captured: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      });
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      });
    try {
      deps.out('to-stdout');
      deps.err('to-stderr');
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(captured).toEqual(['to-stdout\n', 'to-stderr\n']);
  });
});
