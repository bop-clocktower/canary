/**
 * Contract tests for `scripts/check_changelog_entry.mjs` and the advisory
 * `changelog-entry.yml` workflow that runs it (#1418).
 *
 * Every release found `[Unreleased]` missing most user-facing PRs (v8.0.0: 21
 * of 35; v9.4.0: ~20 of ~31), and the gap only showed up when someone rebuilt
 * the release notes from PR bodies at cut time. The check makes the gap
 * visible on the PR that opens it.
 *
 * Exit codes follow the repo's gate convention (#508, ADR 0009):
 *   0 = an entry was added, the PR type is exempt, or the author opted out
 *   1 = a user-facing PR adds no line under `## [Unreleased]` (a finding)
 *   2 = usage error
 *   3 = ABSTAINED: the title cannot be classified, the diff or CHANGELOG.md
 *       cannot be read, the diff lists no files, or the `[Unreleased]` heading
 *       is missing. None of these is evidence an entry exists, so none passes.
 *
 * The workflow maps 1 to a green job with a `::warning`, because the check is
 * advisory. 3 stays red.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildGitTemplate,
  copyGitTemplate,
  GIT_TEMPLATE_BUILD_TIMEOUT_MS,
  removeGitFixture,
} from './git-fixture-testkit.js';
import { advisoryEntries, requiredEntries } from './required-checks-testkit.js';
import { runCapture } from './subprocess-testkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check_changelog_entry.mjs');
const LIB = join(REPO_ROOT, 'scripts', 'lib', 'changelog-entry.mjs');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'changelog-entry.yml');

type Verdict = 'ok' | 'exempt' | 'opted-out' | 'missing' | 'abstain';
interface Result {
  verdict: Verdict;
  reason: string;
  type?: string | null;
  added?: number;
  checked?: number;
}
interface Inputs {
  changedFiles: string[] | null;
  changelog: string | null;
  diff: string | null;
  errors?: Record<string, string>;
}
interface Module {
  classifyTitle: (title: unknown) => {
    kind: 'user-facing' | 'exempt' | 'unknown';
    type: string | null;
  };
  parseOptOut: (body: unknown) => { present: boolean; reason?: string | null };
  findUnreleasedSection: (
    text: string,
  ) => { start: number; end: number } | null;
  addedLines: (diff: string) => { line: number; text: string }[];
  assess: (args: {
    title: unknown;
    body: unknown;
    read: () => Inputs;
  }) => Result;
  render: (result: Result) => {
    stdout: string[];
    summary: string[];
    exitCode: number;
  };
}

// The pure verdict lives in the lib; the CLI owns rendering and git.
const mod = {
  ...(await import(pathToFileURL(LIB).href)),
  ...(await import(pathToFileURL(SCRIPT).href)),
} as Module;

const CHANGELOG = [
  '# Changelog', // 1
  '', // 2
  '## [Unreleased]', // 3
  '', // 4
  '### Fixed', // 5
  '', // 6
  '- an existing entry (#1).', // 7
  '', // 8
  '## [9.8.0] - 2026-11-25', // 9
  '', // 10
  '- an old entry (#0).', // 11
  '',
].join('\n');

/** A one-hunk `git diff --unified=0` body adding `lines` at new line `at`. */
function diffAdding(at: number, lines: string[]): string {
  return [
    'diff --git a/CHANGELOG.md b/CHANGELOG.md',
    'index 1111111..2222222 100644',
    '--- a/CHANGELOG.md',
    '+++ b/CHANGELOG.md',
    `@@ -${at - 1},0 +${at},${lines.length} @@ ### Fixed`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

const readable = (over: Partial<Inputs> = {}): (() => Inputs) => {
  return () => ({
    changedFiles: ['ts/src/x.ts', 'CHANGELOG.md'],
    changelog: CHANGELOG,
    diff: diffAdding(8, ['- a new entry (#1418).']),
    errors: {},
    ...over,
  });
};

describe('classifyTitle', () => {
  it.each([
    ['feat: add a thing', 'feat'],
    ['fix(ci): stop a flake', 'fix'],
    ['perf(guardian)!: drop a pass', 'perf'],
    ['feat!: remove the old flag', 'feat'],
  ])('%s is user-facing', (title, type) => {
    expect(mod.classifyTitle(title)).toMatchObject({
      kind: 'user-facing',
      type,
    });
  });

  it.each([
    'chore(deps): bump vitest',
    'docs: fix a typo',
    'test: pin a case',
    'ci: pin an action',
    'refactor(core): split a module',
    'style: prettier',
  ])('%s is exempt', (title) => {
    expect(mod.classifyTitle(title).kind).toBe('exempt');
  });

  it('treats a breaking change of an exempt type as user-facing', () => {
    // A `!` is a breaking change, and a breaking change is always news.
    expect(mod.classifyTitle('chore!: drop Node 20').kind).toBe('user-facing');
  });

  it.each(['Update README', '', 'feature: x', 'Revert "feat: x"', undefined])(
    '%s cannot be classified',
    (title) => {
      expect(mod.classifyTitle(title).kind).toBe('unknown');
    },
  );
});

describe('parseOptOut', () => {
  it('reads a reason after an em dash', () => {
    expect(
      mod.parseOptOut('Summary\n\nChangelog: none — internal test refactor\n'),
    ).toEqual({ present: true, reason: 'internal test refactor' });
  });

  it.each([
    'changelog: none - reverted before release',
    'Changelog: None: reverted before release',
    '- Changelog: none – reverted before release',
  ])('accepts %s', (line) => {
    expect(mod.parseOptOut(line)).toEqual({
      present: true,
      reason: 'reverted before release',
    });
  });

  it.each([
    'Changelog: none',
    'Changelog: none —',
    'Changelog: none — <reason>',
  ])('%s is present but carries no reason', (line) => {
    expect(mod.parseOptOut(line)).toEqual({ present: true, reason: null });
  });

  it('ignores the line inside an HTML comment or a code fence', () => {
    // A template or a PR describing the syntax must not opt itself out.
    const body = [
      '<!-- Changelog: none — template hint -->',
      '```',
      'Changelog: none — an example',
      '```',
      'Opt out with `Changelog: none — <reason>`.',
    ].join('\n');
    expect(mod.parseOptOut(body)).toEqual({ present: false });
  });

  it('reads a CRLF body, which is what GitHub stores for the web editor', () => {
    expect(
      mod.parseOptOut('Summary\r\n\r\nChangelog: none — docs only\r\nmore'),
    ).toEqual({ present: true, reason: 'docs only' });
  });

  it('ignores a multi-line comment, and everything after an unclosed one', () => {
    const multi = '<!--\nChangelog: none — hint\n-->\nsummary';
    expect(mod.parseOptOut(multi)).toEqual({ present: false });
    const unclosed = 'summary\n<!-- hint\nChangelog: none — hint';
    expect(mod.parseOptOut(unclosed)).toEqual({ present: false });
  });

  it('still reads an opt-out after a closed comment', () => {
    const body = '<!-- template -->\nChangelog: none — docs only';
    expect(mod.parseOptOut(body)).toEqual({
      present: true,
      reason: 'docs only',
    });
  });

  it('treats a missing body as no opt-out', () => {
    expect(mod.parseOptOut(null)).toEqual({ present: false });
  });
});

describe('findUnreleasedSection', () => {
  it('spans from the heading to the line before the next h2', () => {
    expect(mod.findUnreleasedSection(CHANGELOG)).toEqual({ start: 3, end: 8 });
  });

  it('runs to the end of the file when no release follows', () => {
    const text = '# Changelog\n\n## [Unreleased]\n\n- x\n';
    expect(mod.findUnreleasedSection(text)).toEqual({ start: 3, end: 6 });
  });

  it('does not end the section at an h3', () => {
    const section = mod.findUnreleasedSection(CHANGELOG);
    expect(section?.end).toBeGreaterThan(5);
  });

  it('returns null when there is no [Unreleased] heading', () => {
    expect(mod.findUnreleasedSection('# Changelog\n\n## [1.0.0]\n')).toBeNull();
  });
});

describe('addedLines', () => {
  it('numbers added lines on the new side of each hunk', () => {
    const diff = [
      '--- a/CHANGELOG.md',
      '+++ b/CHANGELOG.md',
      '@@ -7,0 +8,2 @@',
      '+- one',
      '+- two',
      '@@ -20 +22 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(mod.addedLines(diff)).toEqual([
      { line: 8, text: '- one' },
      { line: 9, text: '- two' },
      { line: 22, text: 'new' },
    ]);
  });

  it('does not read the +++ file header as an added line', () => {
    expect(mod.addedLines('+++ b/CHANGELOG.md\n')).toEqual([]);
  });

  it('returns nothing for an empty diff', () => {
    expect(mod.addedLines('')).toEqual([]);
  });
});

describe('assess', () => {
  const feat = 'feat(ci): add a check';

  it('passes a user-facing PR that adds a line under [Unreleased]', () => {
    expect(
      mod.assess({ title: feat, body: '', read: readable() }),
    ).toMatchObject({ verdict: 'ok', added: 1, checked: 2 });
  });

  it('matches by section, not by PR number', () => {
    // Entries cite the issue, not the PR, so no #N is required at all.
    const read = readable({ diff: diffAdding(8, ['- no number here']) });
    expect(mod.assess({ title: feat, body: '', read }).verdict).toBe('ok');
  });

  it('flags a line added under a released version, not [Unreleased]', () => {
    const read = readable({ diff: diffAdding(12, ['- misplaced (#1418).']) });
    expect(mod.assess({ title: feat, body: '', read }).verdict).toBe('missing');
  });

  it('does not count a blank line or a bare subheading as an entry', () => {
    const read = readable({ diff: diffAdding(4, ['### Added', '']) });
    expect(mod.assess({ title: feat, body: '', read }).verdict).toBe('missing');
  });

  it('flags a user-facing PR that does not touch CHANGELOG.md', () => {
    const read = readable({ diff: '', changedFiles: ['ts/src/x.ts'] });
    const r = mod.assess({ title: feat, body: '', read });
    expect(r.verdict).toBe('missing');
    expect(r.reason).toMatch(/\[Unreleased\]/);
  });

  it('honours an opt-out that carries a reason', () => {
    const read = readable({ diff: '' });
    const body = 'Changelog: none — reverted in the same release';
    expect(mod.assess({ title: feat, body, read })).toMatchObject({
      verdict: 'opted-out',
      reason: expect.stringContaining('reverted in the same release'),
    });
  });

  it('refuses an opt-out with no reason, and says so', () => {
    const read = readable({ diff: '' });
    const r = mod.assess({ title: feat, body: 'Changelog: none', read });
    expect(r.verdict).toBe('missing');
    expect(r.reason).toMatch(/reason/);
  });

  it('exempts a chore without reading git at all', () => {
    const read = () => {
      throw new Error('must not read git for an exempt PR');
    };
    expect(mod.assess({ title: 'chore: x', body: '', read }).verdict).toBe(
      'exempt',
    );
  });

  describe('abstains, never passes, when it cannot see', () => {
    it('on a title it cannot classify', () => {
      const r = mod.assess({
        title: 'Update stuff',
        body: '',
        read: readable(),
      });
      expect(r.verdict).toBe('abstain');
      expect(r.reason).toMatch(/Conventional Commit/);
    });

    it('when the diff cannot be listed', () => {
      const read = readable({
        changedFiles: null,
        errors: { changedFiles: 'bad revision' },
      });
      const r = mod.assess({ title: feat, body: '', read });
      expect(r.verdict).toBe('abstain');
      expect(r.reason).toMatch(/bad revision/);
    });

    it('when the diff lists zero files', () => {
      const read = readable({ changedFiles: [] });
      const r = mod.assess({ title: feat, body: '', read });
      expect(r.verdict).toBe('abstain');
      expect(r.reason).toMatch(/0 changed files/);
    });

    it('when CHANGELOG.md cannot be read at the head', () => {
      const read = readable({ changelog: null, errors: { changelog: 'gone' } });
      expect(mod.assess({ title: feat, body: '', read }).verdict).toBe(
        'abstain',
      );
    });

    it('when the CHANGELOG.md diff cannot be read', () => {
      const read = readable({ diff: null, errors: { diff: 'broken pipe' } });
      expect(mod.assess({ title: feat, body: '', read }).verdict).toBe(
        'abstain',
      );
    });

    it('when the [Unreleased] heading is missing', () => {
      const read = readable({ changelog: '# Changelog\n\n## [1.0.0]\n' });
      const r = mod.assess({ title: feat, body: '', read });
      expect(r.verdict).toBe('abstain');
      expect(r.reason).toMatch(/\[Unreleased\]/);
    });

    it('even when the author opted out', () => {
      // The opt-out answers "is an entry needed", not "could the check run".
      const read = readable({ changedFiles: [] });
      const body = 'Changelog: none — test only';
      expect(mod.assess({ title: feat, body, read }).verdict).toBe('abstain');
    });
  });
});

describe('render', () => {
  it('turns a missing entry into a ::warning naming both remedies, exit 1', () => {
    const out = mod.render({ verdict: 'missing', reason: 'x', type: 'feat' });
    expect(out.exitCode).toBe(1);
    const text = out.stdout.join('\n');
    expect(text).toMatch(/^::warning /m);
    expect(text).toMatch(/## \[Unreleased\]/);
    expect(text).toMatch(/Changelog: none — <reason>/);
    expect(out.summary.join('\n')).toMatch(/Changelog: none/);
  });

  it('turns an abstention into a loud ::error, exit 3', () => {
    const out = mod.render({ verdict: 'abstain', reason: 'no heading' });
    expect(out.exitCode).toBe(3);
    expect(out.stdout.join('\n')).toMatch(/^::error .*ABSTAINED: no heading/m);
  });

  it.each(['ok', 'exempt', 'opted-out'] as const)('%s exits 0', (verdict) => {
    expect(mod.render({ verdict, reason: 'r' }).exitCode).toBe(0);
  });

  it('escapes an untrusted reason so it cannot start a workflow command', () => {
    const out = mod.render({
      verdict: 'opted-out',
      reason: 'a\n::error::forged 100%',
    });
    const lines = out.stdout.join('\n').split('\n');
    expect(lines.some((l) => l.startsWith('::error'))).toBe(false);
    expect(out.stdout.join('\n')).toContain('%0A');
    expect(out.stdout.join('\n')).toContain('100%25');
  });
});

/** Run git in `cwd`, quietly, with a fixed identity. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
}

describe('the CLI against a real repository', () => {
  let template = '';
  beforeAll(() => {
    template = buildGitTemplate('changelog-entry-', (dir) => {
      git(dir, 'init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG);
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'base');
    });
  }, GIT_TEMPLATE_BUILD_TIMEOUT_MS);
  afterAll(() => removeGitFixture(template));

  /** A copy whose HEAD adds `entry` at line 8 (or only touches code). */
  function repo(entry: string | null): string {
    const dir = copyGitTemplate(template, 'changelog-entry-copy-');
    if (entry !== null) {
      const lines = CHANGELOG.split('\n');
      lines.splice(7, 0, entry);
      writeFileSync(join(dir, 'CHANGELOG.md'), lines.join('\n'));
    }
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.ts'), 'export {};\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'head');
    return dir;
  }

  function run(cwd: string, env: Record<string, string>, args: string[] = []) {
    const summary = join(cwd, '..', `${Math.random()}-summary.md`);
    const r = runCapture(process.execPath, [SCRIPT, ...args], {
      cwd,
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, ...env },
      failureStatus: 99,
    });
    let written = '';
    try {
      written = readFileSync(summary, 'utf8');
    } catch {
      written = '';
    }
    return { ...r, summary: written };
  }

  it('exits 0 when the head adds an [Unreleased] entry', () => {
    const r = run(repo('- added (#1418).'), {
      PR_TITLE: 'feat: x',
      PR_BODY: '',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/2 changed file/);
    expect(r.summary).toMatch(/CHANGELOG/);
  });

  it('exits 1 with a ::warning when it does not', () => {
    const r = run(repo(null), { PR_TITLE: 'fix: x', PR_BODY: '' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^::warning /m);
    expect(r.summary).toMatch(/Changelog: none/);
  });

  it('abstains (exit 3) when the base revision does not exist', () => {
    const r = run(repo(null), { PR_TITLE: 'fix: x', PR_BODY: '' }, [
      '--base',
      'no-such-ref',
    ]);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/ABSTAINED/);
  });

  it('abstains when PR_TITLE was never passed in', () => {
    const r = run(repo(null), { PR_BODY: '' });
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/PR_TITLE/);
  });

  it('rejects an unknown flag with usage (exit 2)', () => {
    const r = run(repo(null), { PR_TITLE: 'fix: x' }, ['--bogus']);
    expect(r.status).toBe(2);
    expect(r.output).toMatch(/usage:/);
  });

  describe('through the real workflow step body', () => {
    type Step = { run?: string; env?: Record<string, string> };
    type Job = { steps?: Step[] };
    const wf = loadYaml(readFileSync(WORKFLOW, 'utf8')) as {
      jobs: Record<string, Job>;
    };
    const step = Object.values(wf.jobs)
      .flatMap((j) => j.steps ?? [])
      .find((s) => s.run?.includes('check_changelog_entry.mjs'));

    /** Run the step body under `bash -e`, as Actions does, in `cwd`. */
    function body(cwd: string, env: Record<string, string>) {
      mkdirSync(join(cwd, 'scripts', 'lib'), { recursive: true });
      copyFileSync(SCRIPT, join(cwd, 'scripts', 'check_changelog_entry.mjs'));
      for (const lib of ['is-main.mjs', 'changelog-entry.mjs'])
        copyFileSync(
          join(REPO_ROOT, 'scripts', 'lib', lib),
          join(cwd, 'scripts', 'lib', lib),
        );
      return runCapture('bash', ['-e', '-c', step?.run ?? 'exit 99'], {
        cwd,
        env: { PATH: process.env.PATH, ...env },
        failureStatus: 99,
      });
    }

    it('finds the step (zero denominator is an abstention)', () => {
      expect(step?.run).toBeDefined();
    });

    it('keeps the job green on a missing entry, with the warning', () => {
      const r = body(repo(null), { PR_TITLE: 'feat: x', PR_BODY: '' });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^::warning /m);
    });

    it('fails the job when the check abstains', () => {
      const r = body(repo(null), { PR_TITLE: 'whatever', PR_BODY: '' });
      expect(r.status).toBe(3);
    });
  });
});

describe('changelog-entry.yml shape', () => {
  type Wf = {
    on?: Record<string, unknown>;
    true?: Record<string, unknown>;
    permissions?: unknown;
    jobs: Record<
      string,
      {
        name?: string;
        'timeout-minutes'?: number;
        permissions?: unknown;
        steps: {
          uses?: string;
          with?: Record<string, unknown>;
          run?: string;
          env?: Record<string, string>;
        }[];
      }
    >;
  };
  const text = readFileSync(WORKFLOW, 'utf8');
  const wf = loadYaml(text) as Wf;
  const on = wf.on ?? wf.true ?? {};
  const jobs = Object.values(wf.jobs);
  const names = Object.entries(wf.jobs).map(([id, j]) => j.name ?? id);

  it('runs on pull_request, including title and body edits', () => {
    const pr = on['pull_request'] as { types?: string[] } | null;
    expect(pr?.types).toEqual(
      expect.arrayContaining(['opened', 'edited', 'synchronize', 'reopened']),
    );
    expect(on['pull_request_target']).toBeUndefined();
  });

  it('is read-only', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const j of jobs) expect(j.permissions).toBeUndefined();
  });

  it('is advisory with a reason, never required', () => {
    expect(names.length).toBeGreaterThan(0);
    const required = requiredEntries().map((r) => r.check);
    const advisory = advisoryEntries();
    for (const n of names) {
      expect(required).not.toContain(n);
      const entry = advisory.find((a) => a.check === n);
      expect(entry?.workflow).toBe('changelog-entry.yml');
      expect(entry?.reason.trim()).not.toBe('');
    }
  });

  it('passes the untrusted title and body only through env', () => {
    const runs = jobs.flatMap((j) => j.steps).map((s) => s.run ?? '');
    expect(runs.join('\n')).not.toMatch(/\$\{\{/);
    const env = jobs.flatMap((j) => j.steps).find((s) => s.env)?.env ?? {};
    expect(env['PR_TITLE']).toBe('${{ github.event.pull_request.title }}');
    expect(env['PR_BODY']).toBe('${{ github.event.pull_request.body }}');
  });

  it('checks out the merge commit with its first parent, and no token', () => {
    const checkout = jobs
      .flatMap((j) => j.steps)
      .find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(2);
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    expect(text).toMatch(/--base HEAD\^1 --head HEAD/);
  });
});
