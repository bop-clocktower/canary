/**
 * Faithful TypeScript port of `tests/unit/test_guardian_cli.py`.
 *
 * Exercises the `analyze --emit-diff`, `pr-check`, and `author-plan` wiring plus
 * the env/git helpers, through the injected {@link GuardianDeps} seams (capturing
 * sinks, fake stdin, fake GitHub clients). Network-free.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GeneratedTest,
  InSessionAgentTier,
} from '../src/guardian/agent-tier.js';
import {
  GuardianDeps,
  defaultDeps,
  isForkContext,
  prContextFromEnv,
  resolveAnalysisRef,
} from '../src/guardian/cli.js';
import { FakeGitHubClient, STICKY_MARKER } from '../src/guardian/pr-comment.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

const DIFF_NEW_UNIT = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
`;

const DIFF_DOCS_ONLY = `diff --git a/docs/x.md b/docs/x.md
index 1111111..2222222 100644
--- a/docs/x.md
+++ b/docs/x.md
@@ -0,0 +1,2 @@
+# Heading
+prose
`;

const DIFF_SRC_AND_TEST = `diff --git a/agent/core/foo.py b/agent/core/foo.py
index 1111111..2222222 100644
--- a/agent/core/foo.py
+++ b/agent/core/foo.py
@@ -0,0 +1,3 @@
+def foo():
+    return 1
+
diff --git a/tests/unit/test_foo.py b/tests/unit/test_foo.py
index 3333333..4444444 100644
--- a/tests/unit/test_foo.py
+++ b/tests/unit/test_foo.py
@@ -0,0 +1,3 @@
+def test_foo():
+    assert foo() == 1
+
`;

const DIFF_LOCKFILE_ONLY = `diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -0,0 +1,3 @@
+{
+  "name": "lego-tracker"
+}
`;

const DIFF_BARREL_INDEX_TS = `diff --git a/pkg/index.ts b/pkg/index.ts
index 1111111..2222222 100644
--- a/pkg/index.ts
+++ b/pkg/index.ts
@@ -0,0 +1,2 @@
+export { foo } from './foo';
+export * from './bar';
`;

const DIFF_FOO_UNIT = `diff --git a/pkg/foo.py b/pkg/foo.py
index 1111111..2222222 100644
--- a/pkg/foo.py
+++ b/pkg/foo.py
@@ -0,0 +1,3 @@
+def foo():
+    return 42
+
`;

const TRANSITIVE_GRAPH_NDJSON =
  [
    { kind: 'node', type: 'file', id: 'file:pkg/foo.py', path: 'pkg/foo.py' },
    { kind: 'node', type: 'file', id: 'file:pkg/b.py', path: 'pkg/b.py' },
    {
      kind: 'node',
      type: 'file',
      id: 'file:tests/test_a.py',
      path: 'tests/test_a.py',
    },
    {
      kind: 'edge',
      from: 'file:tests/test_a.py',
      to: 'file:pkg/b.py',
      type: 'imports',
    },
    {
      kind: 'edge',
      from: 'file:pkg/b.py',
      to: 'file:pkg/foo.py',
      type: 'imports',
    },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  rmTmp(tmp);
});

function writeConfig(guardianBlock: Record<string, unknown>): string {
  const p = join(tmp, 'harness.config.json');
  writeFileSync(
    p,
    JSON.stringify({ canary: { guardian: guardianBlock } }),
    'utf-8',
  );
  return p;
}

function writeTransitiveGraph(): void {
  const graphDir = join(tmp, '.harness', 'graph');
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, 'graph.json'), TRANSITIVE_GRAPH_NDJSON, 'utf-8');
}

// --- analyze --emit-diff ------------------------------------------------------

describe('analyze', () => {
  function writeSpecs(): [string, string] {
    const before = join(tmp, 'before.json');
    const after = join(tmp, 'after.json');
    writeFileSync(
      before,
      JSON.stringify({
        openapi: '3.0.0',
        paths: { '/members': { get: { operationId: 'list' } } },
      }),
    );
    writeFileSync(
      after,
      JSON.stringify({
        openapi: '3.0.0',
        paths: {
          '/members': { get: { operationId: 'list' } },
          '/members/bulk': { post: { operationId: 'bulk' } },
        },
      }),
    );
    return [before, after];
  }

  it('emit-diff writes the contract artifact', async () => {
    const [before, after] = writeSpecs();
    const out = join(tmp, 'api-delta.json');
    const res = await invokeGuardian([
      'analyze',
      'abc1234',
      '--spec-before',
      before,
      '--spec-after',
      after,
      '--suite',
      'api',
      '--emit-diff',
      out,
      '--dry-run',
    ]);
    expect(res.code).toBe(0);
    const delta = JSON.parse(readFileSync(out, 'utf-8'));
    expect(delta.schema_version).toBe(1);
    expect(delta.sut.suite).toBe('api');
    expect(delta.summary.added).toBe(1);
    expect(delta.endpoints.added[0]).toEqual({
      method: 'POST',
      path: '/members/bulk',
    });
  });

  it('without --emit-diff no file is written', async () => {
    const [before, after] = writeSpecs();
    const res = await invokeGuardian([
      'analyze',
      'abc1234',
      '--spec-before',
      before,
      '--spec-after',
      after,
      '--dry-run',
    ]);
    expect(res.code).toBe(0);
  });

  it('no specs prints the tip and a JSON summary', async () => {
    const res = await invokeGuardian(['analyze', 'abc1234', '--json']);
    expect(res.code).toBe(0);
    // The no-specs tip prints first, then the JSON summary -- parse from the
    // first brace (matches the shipping CLI which prints both to stdout).
    const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(payload.commit).toBe('abc1234');
    expect(payload.added).toBe(0);
  });

  it('no commit defaults to unknown; prints markdown summary', async () => {
    const res = await invokeGuardian(['analyze']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Test Impact Summary');
  });

  it('posts a PR comment via gh when not dry-run and pr is given', async () => {
    const runGh = (): {
      status: number;
      stdout: string;
      stderr: string;
      failed: boolean;
    } => ({ status: 0, stdout: '', stderr: '', failed: false });
    const res = await invokeGuardian(
      ['analyze', 'abc1234', '--pr', 'https://example/pr/1'],
      { deps: { runGh } },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Posted impact summary as PR comment.');
  });
});

// --- helpers ------------------------------------------------------------------

describe('prContextFromEnv', () => {
  it('resolves repo and pr from ref', () => {
    expect(
      prContextFromEnv({
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/pull/7/merge',
      }),
    ).toEqual(['o/r', 7]);
  });

  it('returns null when unset', () => {
    expect(prContextFromEnv({})).toBeNull();
  });

  it('event-path fallback for pr number', () => {
    const event = join(tmp, 'event.json');
    writeFileSync(
      event,
      JSON.stringify({ pull_request: { number: 42 } }),
      'utf-8',
    );
    expect(
      prContextFromEnv({
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_PATH: event,
      }),
    ).toEqual(['o/r', 42]);
  });

  it('returns null on a malformed event file', () => {
    const event = join(tmp, 'event.json');
    writeFileSync(event, 'not json', 'utf-8');
    expect(
      prContextFromEnv({
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_PATH: event,
      }),
    ).toBeNull();
  });
});

describe('resolveAnalysisRef', () => {
  function depsWith(over: Partial<GuardianDeps>): GuardianDeps {
    return { ...defaultDeps(), env: {}, ...over };
  }

  it('git absent returns local', () => {
    const deps = depsWith({ runGit: () => null });
    expect(resolveAnalysisRef(deps)).toBe('local');
  });

  it('uses PR context when present', () => {
    const deps = depsWith({
      env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/9/merge' },
    });
    expect(resolveAnalysisRef(deps)).toBe('pr-9');
  });

  it('uses short HEAD sha when no CI context', () => {
    const deps = depsWith({ runGit: () => ({ code: 0, stdout: 'deadbee\n' }) });
    expect(resolveAnalysisRef(deps)).toBe('deadbee');
  });
});

describe('isForkContext', () => {
  it('unset is not a fork', () => {
    expect(isForkContext({})).toBe(false);
  });
  it('zero (whitespace wrapped) is not a fork', () => {
    expect(isForkContext({ CANARY_GUARDIAN_IS_FORK: '  0  ' })).toBe(false);
  });
  it.each(['1', 'true', 'yes', '  1 ', 'x'])(
    'any other value %s is a fork',
    (value) => {
      expect(isForkContext({ CANARY_GUARDIAN_IS_FORK: value })).toBe(true);
    },
  );
});

// --- pr-check -----------------------------------------------------------------

describe('pr-check post pipeline', () => {
  const CI_ENV = {
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_REF: 'refs/pull/7/merge',
  };

  it('post creates a single sticky comment', async () => {
    const fake = new FakeGitHubClient();
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--post-comment'],
      {
        input: DIFF_NEW_UNIT,
        env: CI_ENV,
        cwd: tmp,
        deps: { buildCommentClient: () => fake },
      },
    );
    expect(res.code).toBe(0);
    const marked = fake.comments.filter((c) => c.body.includes(STICKY_MARKER));
    expect(marked.length).toBe(1);
  });

  it('docs-only skips and posts nothing', async () => {
    const fake = new FakeGitHubClient();
    const cfg = writeConfig({ skipGlobs: ['docs/**'] });
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--config', cfg, '--post-comment'],
      {
        input: DIFF_DOCS_ONLY,
        env: CI_ENV,
        cwd: tmp,
        deps: { buildCommentClient: () => fake },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('nothing to verify');
    expect(fake.comments).toEqual([]);
  });

  it('test files never become findings', async () => {
    mkdirSync(join(tmp, 'agent', 'core'), { recursive: true });
    writeFileSync(
      join(tmp, 'agent', 'core', 'foo.py'),
      'def foo():\n    return 1\n',
      'utf-8',
    );
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json', '--gate', 'soft'],
      { input: DIFF_SRC_AND_TEST, cwd: tmp },
    );
    expect(res.code).toBe(0);
    const data = JSON.parse(res.stdout);
    const paths = new Set(data.findings.map((f: { path: string }) => f.path));
    expect(paths.has('agent/core/foo.py')).toBe(true);
    expect(paths.has('tests/unit/test_foo.py')).toBe(false);
  });

  it('lockfile-only skips by default', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_LOCKFILE_ONLY, cwd: tmp },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('nothing to verify');
  });

  it('explicit empty skipGlobs disables the default skip', async () => {
    const cfg = writeConfig({ skipGlobs: [] });
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--config', cfg, '--format', 'json'],
      { input: DIFF_LOCKFILE_ONLY, cwd: tmp },
    );
    expect(res.code).toBe(0);
    const data = JSON.parse(res.stdout);
    const paths = new Set(data.findings.map((f: { path: string }) => f.path));
    expect(paths.has('package-lock.json')).toBe(true);
  });

  it('barrel index.ts is not flagged', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json'],
      { input: DIFF_BARREL_INDEX_TS, cwd: tmp },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('nothing to verify');
  });

  it('pr disabled skips the surface', async () => {
    const fake = new FakeGitHubClient();
    const cfg = writeConfig({ pr: { enabled: false } });
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--config', cfg, '--post-comment'],
      {
        input: DIFF_NEW_UNIT,
        env: CI_ENV,
        cwd: tmp,
        deps: { buildCommentClient: () => fake },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('skipping PR surface');
    expect(fake.comments).toEqual([]);
  });

  it('read-only token degrades to a warning', async () => {
    const fake = new FakeGitHubClient({ deny_writes: true });
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--post-comment'],
      {
        input: DIFF_NEW_UNIT,
        env: CI_ENV,
        cwd: tmp,
        deps: { buildCommentClient: () => fake },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('::warning::');
  });

  it('no PR context prints the body instead', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--post-comment'],
      {
        input: DIFF_NEW_UNIT,
        cwd: tmp,
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(STICKY_MARKER);
  });
});

describe('pr-check graph-depth (#320)', () => {
  it('hard gate flags transitive-only coverage', async () => {
    writeTransitiveGraph();
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json', '--gate', 'hard'],
      { input: DIFF_FOO_UNIT, cwd: tmp },
    );
    expect(res.code).toBe(1);
    const data = JSON.parse(res.stdout);
    const paths = new Set(data.findings.map((f: { path: string }) => f.path));
    expect(paths.has('pkg/foo.py')).toBe(true);
    expect(data.findings[0].fidelity).toBe('graph-verified');
  });

  it('soft gate credits transitive coverage', async () => {
    writeTransitiveGraph();
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--format', 'json', '--gate', 'soft'],
      { input: DIFF_FOO_UNIT, cwd: tmp },
    );
    expect(res.code).toBe(0);
    const data = JSON.parse(res.stdout);
    const paths = new Set(data.findings.map((f: { path: string }) => f.path));
    expect(paths.has('pkg/foo.py')).toBe(false);
  });
});

describe('pr-check tier degradation (SC-5)', () => {
  it('tier one degrades loudly local (both footer + Actions warning)', async () => {
    const cfg = writeConfig({ pr: { tier: 1 } });
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--config', cfg, '--format', 'text'],
      { input: DIFF_NEW_UNIT, cwd: tmp },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('::warning::');
    expect(res.stdout).toContain('tier 1');
    expect(res.stdout).toContain('degraded');
    expect(res.stdout).toContain('tier 0');
  });

  it('tier zero has no false degradation', async () => {
    const cfg = writeConfig({ pr: { tier: 0 } });
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--config', cfg, '--format', 'text'],
      { input: DIFF_NEW_UNIT, cwd: tmp },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('::warning::');
    expect(res.stdout).not.toContain('degraded');
  });

  it('tier two degrades on both channels when posting', async () => {
    const summary = join(tmp, 'step_summary.md');
    const fake = new FakeGitHubClient();
    const cfg = writeConfig({ pr: { tier: 2 } });
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--config', cfg, '--post-comment'],
      {
        input: DIFF_NEW_UNIT,
        env: {
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_REF: 'refs/pull/7/merge',
          GITHUB_STEP_SUMMARY: summary,
        },
        cwd: tmp,
        deps: { buildCommentClient: () => fake },
      },
    );
    expect(res.code).toBe(0);
    const marked = fake.comments.filter((c) => c.body.includes(STICKY_MARKER));
    expect(marked.length).toBe(1);
    expect(marked[0]!.body).toContain('degraded: tier 2');
    expect(readFileSync(summary, 'utf-8')).toContain('tier 2');
    expect(res.stdout).toContain('::warning::');
  });
});

describe('pr-check emit-analysis (SC-10)', () => {
  it('emits to an available channel; writes a record, no comment', async () => {
    mkdirSync(join(tmp, '.harness'));
    const analysesDir = join(tmp, '.harness', 'analyses');
    const fake = new FakeGitHubClient();
    const res = await invokeGuardian(
      [
        'pr-check',
        '--diff',
        '-',
        '--emit-analysis',
        '--analyses-dir',
        analysesDir,
      ],
      {
        input: DIFF_NEW_UNIT,
        cwd: tmp,
        deps: { buildCommentClient: () => fake },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('wrote analysis record');
    const record = JSON.parse(
      readFileSync(join(analysesDir, 'canary-pr-guardian-local.json'), 'utf-8'),
    );
    expect(record.source).toBe('canary-pr-guardian');
    expect(record.findings.length).toBeGreaterThanOrEqual(1);
    expect(fake.comments).toEqual([]);
  });

  it('absent channel warns and falls back to the comment', async () => {
    const absent = join(tmp, 'no-harness', 'analyses'); // parent missing
    const fake = new FakeGitHubClient();
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--emit-analysis', '--analyses-dir', absent],
      {
        input: DIFF_NEW_UNIT,
        env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' },
        cwd: tmp,
        deps: { buildCommentClient: () => fake },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('::warning::');
    expect(res.stdout).toContain('falling back');
    const marked = fake.comments.filter((c) => c.body.includes(STICKY_MARKER));
    expect(marked.length).toBe(1);
  });

  it('emit + post-comment fire both surfaces', async () => {
    mkdirSync(join(tmp, '.harness'));
    const analysesDir = join(tmp, '.harness', 'analyses');
    const fake = new FakeGitHubClient();
    const res = await invokeGuardian(
      [
        'pr-check',
        '--diff',
        '-',
        '--emit-analysis',
        '--post-comment',
        '--analyses-dir',
        analysesDir,
      ],
      {
        input: DIFF_NEW_UNIT,
        env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' },
        cwd: tmp,
        deps: { buildCommentClient: () => fake },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('wrote analysis record');
    const marked = fake.comments.filter((c) => c.body.includes(STICKY_MARKER));
    expect(marked.length).toBe(1);
  });

  it('emit preserves the hard-gate exit and records exitCode', async () => {
    mkdirSync(join(tmp, '.harness'));
    mkdirSync(join(tmp, 'pkg'));
    writeFileSync(
      join(tmp, 'pkg', 'widget.py'),
      'def widget():\n    return 42\n',
      'utf-8',
    );
    writeFileSync(
      join(tmp, 'cov.info'),
      'SF:pkg/widget.py\nDA:1,0\nDA:2,0\nDA:3,0\nend_of_record\n',
      'utf-8',
    );
    const analysesDir = join(tmp, '.harness', 'analyses');
    const res = await invokeGuardian(
      [
        'pr-check',
        '--diff',
        '-',
        '--coverage',
        'cov.info',
        '--gate',
        'hard',
        '--emit-analysis',
        '--analyses-dir',
        analysesDir,
      ],
      { input: DIFF_NEW_UNIT, cwd: tmp },
    );
    expect(res.code).toBe(1);
    const record = JSON.parse(
      readFileSync(join(analysesDir, 'canary-pr-guardian-local.json'), 'utf-8'),
    );
    expect(record.exitCode).toBe(1);
    expect(record.gate).toBe('hard');
  });

  it('malformed config warns on stderr', async () => {
    const cfg = join(tmp, 'harness.config.json');
    writeFileSync(cfg, '{ not json', 'utf-8');
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--config', cfg, '--format', 'json'],
      { input: DIFF_NEW_UNIT, cwd: tmp },
    );
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('WARNING:');
  });
});

// --- author-plan --------------------------------------------------------------

class FakeAuthorInvoker {
  review(): string {
    return '';
  }
  author(intent: GeneratedTest): GeneratedTest {
    return new GeneratedTest({
      gap: intent.gap,
      target_path: intent.target_path,
      requirement: intent.requirement,
      status: 'authored',
      written_path: intent.target_path,
    });
  }
}

describe('author-plan (T7)', () => {
  it('opt-in off skips all intents, no block', async () => {
    const res = await invokeGuardian(['author-plan', '--diff', '-'], {
      input: DIFF_NEW_UNIT,
      cwd: tmp,
    });
    expect(res.code).toBe(0);
    const data = JSON.parse(res.stdout);
    expect(data.intents.length).toBeGreaterThan(0);
    expect(
      data.intents.every((i: { status: string }) => i.status === 'skipped'),
    ).toBe(true);
    expect(data.intents[0].skip_reason).toContain('opt-in');
    expect(data.block.block).toBe(false);
    expect(data.block.authored_count).toBe(0);
  });

  it('opt-in on + agent + fake invoker authors and blocks', async () => {
    const cfg = writeConfig({
      preCommit: { enabled: true, authorTests: true },
    });
    const res = await invokeGuardian(
      ['author-plan', '--diff', '-', '--config', cfg],
      {
        input: DIFF_NEW_UNIT,
        env: { CANARY_GUARDIAN_AGENT: '2' },
        cwd: tmp,
        deps: {
          makeAgentTier: () =>
            new InSessionAgentTier({ invoker: new FakeAuthorInvoker() }),
        },
      },
    );
    expect(res.code).toBe(0);
    const data = JSON.parse(res.stdout);
    const authored = data.intents.filter(
      (i: { status: string }) => i.status === 'authored',
    );
    expect(authored.length).toBeGreaterThanOrEqual(1);
    expect(authored[0].written_path).toBeTruthy();
    expect(data.block.block).toBe(true);
    expect(data.block.authored_count).toBeGreaterThanOrEqual(1);
    expect(data.block.message).toContain('re-commit');
  });

  it('opt-in on production path (RecordingInvoker) blocks on planned', async () => {
    const cfg = writeConfig({
      preCommit: { enabled: true, authorTests: true },
    });
    const res = await invokeGuardian(
      ['author-plan', '--diff', '-', '--config', cfg],
      { input: DIFF_NEW_UNIT, env: { CANARY_GUARDIAN_AGENT: '2' }, cwd: tmp },
    );
    expect(res.code).toBe(0);
    const data = JSON.parse(res.stdout);
    const planned = data.intents.filter(
      (i: { status: string }) => i.status === 'planned',
    );
    expect(planned.length).toBeGreaterThanOrEqual(1);
    expect(data.block.block).toBe(true);
    expect(data.block.message).toContain('review');
    expect(data.block.message).toContain('re-commit');
  });

  it('forks skip authoring', async () => {
    const cfg = writeConfig({
      preCommit: { enabled: true, authorTests: true },
    });
    const res = await invokeGuardian(
      ['author-plan', '--diff', '-', '--config', cfg],
      {
        input: DIFF_NEW_UNIT,
        env: { CANARY_GUARDIAN_AGENT: '2', CANARY_GUARDIAN_IS_FORK: 'true' },
        cwd: tmp,
      },
    );
    expect(res.code).toBe(0);
    const data = JSON.parse(res.stdout);
    expect(
      data.intents.every((i: { status: string }) => i.status === 'skipped'),
    ).toBe(true);
    expect(data.intents[0].skip_reason).toContain('fork');
    expect(data.block.block).toBe(false);
  });

  it('opt-in on without agent degrades to skip', async () => {
    const cfg = writeConfig({
      preCommit: { enabled: true, authorTests: true },
    });
    const res = await invokeGuardian(
      ['author-plan', '--diff', '-', '--config', cfg],
      { input: DIFF_NEW_UNIT, cwd: tmp },
    );
    expect(res.code).toBe(0);
    const data = JSON.parse(res.stdout);
    expect(
      data.intents.every((i: { status: string }) => i.status === 'skipped'),
    ).toBe(true);
    expect(data.intents[0].skip_reason).toContain('tier');
    expect(data.block.block).toBe(false);
  });

  it('repo_root resolved from git toplevel, not cwd (collision at root)', () => {
    // A real git repo so `git rev-parse --show-toplevel` resolves to the root.
    execFileSync('git', ['init', '-q', tmp]);
    mkdirSync(join(tmp, 'pkg'), { recursive: true });
    // DIFF_NEW_UNIT adds pkg/widget.py -> target pkg/test_widget.py.
    writeFileSync(
      join(tmp, 'pkg', 'test_widget.py'),
      '# owned by another PR/session\n',
      'utf-8',
    );
    const cfg = writeConfig({
      preCommit: { enabled: true, authorTests: true },
    });
    const subdir = join(tmp, 'nested', 'deep');
    mkdirSync(subdir, { recursive: true });
    return invokeGuardian(['author-plan', '--diff', '-', '--config', cfg], {
      input: DIFF_NEW_UNIT,
      env: { CANARY_GUARDIAN_AGENT: '2' },
      cwd: subdir,
    }).then((res) => {
      expect(res.code).toBe(0);
      const data = JSON.parse(res.stdout);
      expect(
        data.intents.every((i: { status: string }) => i.status === 'skipped'),
      ).toBe(true);
      const reason = data.intents[0].skip_reason ?? '';
      expect(reason.includes('collision') || reason.includes('exists')).toBe(
        true,
      );
      expect(data.block.block).toBe(false);
    });
  });
});

// --- mark-authored + watch ----------------------------------------------------

describe('mark-authored', () => {
  it('writes the sentinel with one path per line', async () => {
    execFileSync('git', ['init', '-q', tmp]);
    const res = await invokeGuardian(
      ['mark-authored', '--path', 'a/test_x.py', '--path', 'b/test_y.py'],
      { cwd: tmp },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('recorded 2 authored path(s)');
    const sentinel = join(tmp, '.git', 'canary-guardian-authored');
    expect(readFileSync(sentinel, 'utf-8')).toBe('a/test_x.py\nb/test_y.py\n');
  });
});

describe('watch', () => {
  it('prints startup + poll, then stops on interrupt', async () => {
    const { WatchInterrupt } = await import('../src/guardian/cli.js');
    let calls = 0;
    const res = await invokeGuardian(['watch', '--interval', '1'], {
      deps: {
        sleep: async () => {
          calls += 1;
          throw new WatchInterrupt();
        },
      },
    });
    expect(res.code).toBe(0);
    expect(calls).toBe(1);
    expect(res.stdout).toContain('Guardian watch mode');
    expect(res.stdout).toContain('Polling for new merges');
    expect(res.stdout).toContain('Watch stopped');
  });
});
