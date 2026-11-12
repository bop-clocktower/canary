/**
 * Workflow-file hygiene guards (#1236, #1237, #1238).
 *
 * Each of these defects was found in a workflow by hand, after it had already
 * shipped. These tests pin the fix so that the next edit cannot silently undo
 * it:
 *
 * - #1236: `harness-architecture.yml` ran with the repository's default token
 *   scope, because it declared no `permissions:` block.
 * - #1237: `batwoman.yml` drifted out of prettier format, because no check
 *   covered workflow YAML.
 * - #1238: shellcheck findings piled up in `run:` scripts, because nothing ran
 *   actionlint. The `$*_BASE_FLAG` expansions are deliberately unquoted, so
 *   this file also guards them against a well-meant "fix" that quotes them.
 * - #1427: `harness-security.yml` force-pushed its ledger branch with no
 *   `concurrency:` group, so overlapping runs silently lost a write.
 *   `release-advance-latest.test.ts` covers the `latest` tag's ordering.
 * - #1428: five workflows hard-coded `node-version: '20'` while `.nvmrc`
 *   moved on, so the harness CLI ran under an engine it rejects (EBADENGINE,
 *   the #1401 required-check flake).
 * - #1490: `arch-snapshot.yml` read its timeline from the repo-relative path
 *   inside the artifact, but upload-artifact had stored it at the artifact
 *   root, so the push job failed on every run.
 * - #1463: `refresh-arch-baseline.yml` ran the CLI and a PR-head script in the
 *   job that held the write token. `refresh-baseline-push-job.test.ts` runs its
 *   write jobs' scripts against a real remote.
 *
 * Offline: the assertions read the YAML or JSON as data. The #1490 block also
 * runs one restore script under bash in a temp dir.
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { advisoryEntries, REPO_ROOT } from './required-checks-testkit.js';

const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Concurrency {
  group?: string;
  'cancel-in-progress'?: unknown;
}
interface Concurrency {
  group?: string;
  'cancel-in-progress'?: unknown;
}
interface Job {
  permissions?: unknown;
  concurrency?: string | Concurrency;
  steps?: Step[];
}
interface Workflow {
  permissions?: unknown;
  concurrency?: string | Concurrency;
  jobs?: Record<string, Job>;
}

function workflow(file: string): Workflow {
  return loadYaml(readFileSync(join(WORKFLOW_DIR, file), 'utf-8')) as Workflow;
}

describe('#1236 harness-architecture.yml is least-privilege', () => {
  const wf = workflow('harness-architecture.yml');

  it('declares top-level permissions of exactly contents: read', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('has no job that widens the token', () => {
    const widened = Object.entries(wf.jobs ?? {})
      .filter(([, job]) => job.permissions !== undefined)
      .map(([id]) => id);
    expect(widened).toEqual([]);
  });
});

/**
 * The `contents` scope a permissions block grants, or undefined when the block
 * is absent. An object form grants `none` for every scope it does not name.
 */
function contentsScope(perms: unknown): string | undefined {
  if (perms === undefined) return undefined;
  if (perms === 'write-all') return 'write';
  if (perms === 'read-all') return 'read';
  if (perms && typeof perms === 'object')
    return (perms as Record<string, string>).contents ?? 'none';
  return 'none';
}

/**
 * The `contents` scope a job actually runs with. A job with no block inherits
 * the workflow's; a workflow with none gets the repository default, which may
 * be write, so an undeclared scope counts as write.
 */
function effectiveContents(wf: Workflow, job: Job): string {
  return (
    contentsScope(job.permissions) ?? contentsScope(wf.permissions) ?? 'write'
  );
}

/**
 * Launchers that resolve and run package code, or run repo scripts that may
 * import it: `npx`, `npm exec|ci|i|install|run`, `pnpm|yarn dlx`, `bunx`,
 * and `node <script>`. A blocklist, so it is paired with the action allowlist
 * in `ledger-push-jobs.test.ts`.
 */
const REGISTRY_CODE =
  /(?:^|[\s;&|(])(?:(?:npx|bunx|npm\s+(?:exec|ci|i|install|run)|(?:pnpm|yarn)\s+dlx)\b|node\s+\S)/m;

/** Whether a job runs registry code. */
function runsRegistryCode(job: Job): boolean {
  return (job.steps ?? []).some((s) => REGISTRY_CODE.test(s.run ?? ''));
}

describe('#1426 the registry-code detector', () => {
  it.each([
    'npx --yes -p x harness validate',
    'npm exec x',
    'npm ci',
    'npm run build',
    'pnpm dlx x',
    'yarn dlx x',
    'bunx x',
    'node scripts/security_ledger.mjs',
    'set -e; npx x',
  ])('flags %s', (run) => {
    expect(runsRegistryCode({ steps: [{ run }] })).toBe(true);
  });

  it.each(['git push --force origin "HEAD:$BRANCH"', 'cp -- "$SRC/$f" "$f"'])(
    'does not flag %s',
    (run) => {
      expect(runsRegistryCode({ steps: [{ run }] })).toBe(false);
    },
  );
});

/**
 * #1426 (CWE-250 / CWE-272). `harness-security.yml` and `arch-snapshot.yml`
 * granted `contents: write` to the whole workflow, so `npx` resolved a
 * floating `@harness-engineering/cli@13` and ran it while `actions/checkout`
 * held a write token in `.git/config`. Only the final push needed write.
 *
 * A top-level `contents: write` hands that scope to every job, including ones
 * added later. It is allowed only where the workflow's whole purpose is a
 * write, and each such exception carries its reason here.
 *
 * `release.yml` was on this list until #1439 split bin verification into its
 * own job and moved `contents: write` down to the jobs that publish. Keeping
 * it off the list is what proves the narrowing holds.
 */
const TOP_LEVEL_WRITE_ALLOWLIST: Record<string, string> = {
  'wiki-sync.yml':
    'Its one job exists to push docs/wiki to the GitHub Wiki on push to main, ' +
    'and it runs no registry code (no npx / npm exec).',
};

describe('#1426 a top-level contents: write is an explicit exception', () => {
  const all = readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml'))
    .sort()
    .map((f): [string, Workflow] => [f, workflow(f)]);
  const topLevelWriters = all
    .filter(([, wf]) => contentsScope(wf.permissions) === 'write')
    .map(([f]) => f);

  it('finds workflows to check (zero denominator is an abstention)', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it('grants top-level contents: write only to allowlisted workflows', () => {
    expect(
      topLevelWriters.filter((f) => !(f in TOP_LEVEL_WRITE_ALLOWLIST)),
      'move contents: write onto the one job that pushes, or allowlist it with a reason',
    ).toEqual([]);
  });

  it.each(Object.keys(TOP_LEVEL_WRITE_ALLOWLIST))(
    'allowlist entry %s still needs it and states why',
    (file) => {
      expect(topLevelWriters).toContain(file);
      expect(TOP_LEVEL_WRITE_ALLOWLIST[file]!.length).toBeGreaterThan(40);
    },
  );
});

describe.each(['harness-security.yml', 'arch-snapshot.yml'])(
  '#1426 %s runs no registry code under a write token',
  (file) => {
    const wf = workflow(file);
    const jobs = Object.entries(wf.jobs ?? {});
    const writers = jobs.filter(
      ([, job]) => effectiveContents(wf, job) === 'write',
    );

    it('declares top-level permissions of exactly contents: read', () => {
      expect(wf.permissions).toEqual({ contents: 'read' });
    });

    // Denominators for the assertion below: the npx still runs somewhere,
    // and the push still happens somewhere.
    it('still runs npx in some job, and still pushes from some job', () => {
      expect(jobs.some(([, job]) => runsRegistryCode(job))).toBe(true);
      expect(
        writers.some(([, job]) =>
          (job.steps ?? []).some((s) => /\bgit push\b/.test(s.run ?? '')),
        ),
      ).toBe(true);
    });

    it('runs npx in no job that holds contents: write', () => {
      expect(
        writers.filter(([, job]) => runsRegistryCode(job)).map(([id]) => id),
      ).toEqual([]);
    });

    it('limits each write job to contents: write and nothing else', () => {
      for (const [, job] of writers)
        expect(job.permissions).toEqual({ contents: 'write' });
    });
  },
);

/**
 * The scopes a job holds write on. A job with no block inherits the workflow's;
 * a workflow with none gets the repository default, which may be write.
 */
function writeScopes(wf: Workflow, job: Job): string[] {
  const perms = job.permissions ?? wf.permissions;
  if (perms === undefined) return ['(repository default)'];
  if (perms === 'write-all') return ['(all)'];
  if (perms === null || typeof perms !== 'object') return [];
  return Object.entries(perms as Record<string, string>)
    .filter(([, level]) => level === 'write')
    .map(([scope]) => scope);
}

/**
 * Code a checkout supplies, which `REGISTRY_CODE` does not see: the globally
 * installed `harness` bin, a repo script run directly or through a shell, and a
 * local action. Comment lines are dropped first, because a push script's
 * comments are free to name the job it replaced.
 */
const CHECKOUT_CODE =
  /^\s*(?:(?:[\w.-]+=\S*\s+)*harness\s|(?:bash|sh|zsh|python3?)\s+\S|\.{0,2}\/\S|scripts\/)/m;

function runsCheckoutCode(job: Job): boolean {
  return (job.steps ?? []).some(
    (s) =>
      s.uses?.startsWith('./') ||
      CHECKOUT_CODE.test((s.run ?? '').replace(/^\s*#.*$/gm, '')),
  );
}

describe('#1463 the checkout-code detector', () => {
  it.each([
    'harness check-arch --json > arch-report.json || true',
    'FOO=1 harness check-arch',
    'bash scripts/x.sh',
    'sh ./x.sh',
    './scripts/x.sh',
    'scripts/x.sh',
    'python3 tool.py',
    'git status\n./x.sh',
  ])('flags %s', (run) => {
    expect(runsCheckoutCode({ steps: [{ run }] })).toBe(true);
  });

  it('flags a local action', () => {
    expect(runsCheckoutCode({ steps: [{ uses: './.github/actions/x' }] })).toBe(
      true,
    );
  });

  it.each([
    'git push origin "HEAD:refs/heads/$BRANCH"',
    'cp -- "$SRC/$entry" "$dest"',
    '# harness check-arch ran in the measure job',
    'echo "harness did not run here"',
    'gh pr edit "$PR_NUMBER" --remove-label refresh-baseline',
  ])('does not flag %s', (run) => {
    expect(runsCheckoutCode({ steps: [{ run }] })).toBe(false);
  });
});

/**
 * #1463 (CWE-250). `refresh-arch-baseline.yml` granted `contents: write` and
 * `pull-requests: write` to one job, which then ran a floating CLI and a PR-head
 * script with that token in `.git/config`. Only the commit and the label removal
 * need a write scope. This is the #1426 shape with one more write job, because
 * label removal needs a scope the push does not.
 */
describe('#1463 refresh-arch-baseline.yml runs no registry or PR-head code under a write token', () => {
  const wf = workflow('refresh-arch-baseline.yml');
  const jobs = Object.entries(wf.jobs ?? {});
  const writers = jobs.filter(([, j]) => writeScopes(wf, j).length > 0);
  const measure = wf.jobs?.measure;
  const push = wf.jobs?.push;
  const consume = wf.jobs?.['consume-label'];
  const steps = (j?: Job) => j?.steps ?? [];
  const actions = (j?: Job) =>
    steps(j)
      .flatMap((s) => (s.uses ? [s.uses.split('@')[0]] : []))
      .sort();
  const HEAD_SHA = '${{ github.event.pull_request.head.sha }}';

  it('declares top-level permissions of exactly contents: read', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  // Denominators for the assertion below: the code still runs somewhere, and
  // the two writes still happen somewhere.
  it('still measures, still pushes, and still consumes the label', () => {
    const runs = (j: Job | undefined, re: RegExp) =>
      steps(j).some((s) => re.test(s.run ?? ''));
    expect(measure && runsRegistryCode(measure)).toBe(true);
    expect(measure && runsCheckoutCode(measure)).toBe(true);
    expect(runs(measure, /refresh-arch-baseline\.mjs/)).toBe(true);
    expect(runs(push, /\bgit push\b/)).toBe(true);
    expect(runs(consume, /--remove-label refresh-baseline/)).toBe(true);
  });

  it('runs neither in any job that holds a write scope', () => {
    expect(writers.map(([id]) => id).sort()).toEqual(['consume-label', 'push']);
    expect(
      writers
        .filter(([, j]) => runsRegistryCode(j) || runsCheckoutCode(j))
        .map(([id]) => id),
    ).toEqual([]);
  });

  it('runs only for its opt-in label, and only for same-repo PRs', () => {
    const gate = String((measure as { if?: unknown } | undefined)?.if);
    expect(gate).toContain("github.event.label.name == 'refresh-baseline'");
    expect(gate).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
  });

  // A swallowed `git add` is the green run with an empty commit #634 forbids.
  it('stages by name, and lets a failed add fail the step', () => {
    const script = steps(push)
      .map((s) => s.run ?? '')
      .join('\n');
    const adds = script.split('\n').filter((l) => /^\s*git add\b/.test(l));
    expect(adds.map((l) => l.trim())).toEqual([
      'git add .harness/arch/baselines.json',
      'git add .harness/audit.log',
    ]);
  });

  it('gives each write job the one scope it uses', () => {
    expect(push?.permissions).toEqual({ contents: 'write' });
    // Not `contents: write`: this job only edits a label. #1426's "contents:
    // write and nothing else" is the same rule, one scope per write.
    expect(consume?.permissions).toEqual({ 'pull-requests': 'write' });
    expect(measure?.permissions).toBeUndefined();
  });

  it('limits the write jobs to the actions that fetch their input', () => {
    expect(actions(push)).toEqual([
      'actions/checkout',
      'actions/download-artifact',
    ]);
    expect(actions(consume)).toEqual([]);
  });

  it('leaves no token in the measuring checkout', () => {
    const checkout = steps(measure).find((s) =>
      s.uses?.startsWith('actions/checkout@'),
    );
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  // The head ref is a moving target, and the two jobs start minutes apart. Both
  // must see one commit, or the push job would compare and commit a baseline
  // measured on a tree it is not holding.
  it('measures and pushes the same commit', () => {
    for (const j of [measure, push]) {
      const checkout = steps(j).find((s) =>
        s.uses?.startsWith('actions/checkout@'),
      );
      expect(checkout?.with?.ref).toBe(HEAD_SHA);
    }
    const guarded = steps(push).find((s) => /\bgit push\b/.test(s.run ?? ''));
    expect(guarded?.env?.HEAD_SHA).toBe(HEAD_SHA);
  });

  it('orders the jobs so a failed step leaves the label in place (#634)', () => {
    expect((push as { needs?: unknown } | undefined)?.needs).toBe('measure');
    expect((consume as { needs?: unknown } | undefined)?.needs).toBe('push');
    expect((consume as { if?: unknown } | undefined)?.if).toBe('success()');
  });

  it('still uploads the report when the refresh step fails (#588)', () => {
    const report = steps(measure).find(
      (s) => s.with?.name === 'refresh-arch-report',
    );
    expect((report as { if?: unknown } | undefined)?.if).toBe(
      '${{ !cancelled() }}',
    );
  });

  // `.harness/` is a dot-path, which upload-artifact skips unless told. Without
  // these two the artifact is empty and the push job has nothing to push.
  it('uploads the refreshed dot-paths, and treats none found as an error', () => {
    const upload = steps(measure).find(
      (s) => s.with?.name === 'refreshed-arch-baseline',
    );
    expect(upload?.with?.['include-hidden-files']).toBe(true);
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    // No `if:`, so the refresh script's exit 1 or 3 stops the hand-off, and
    // with it the push and the label removal.
    expect((upload as { if?: unknown } | undefined)?.if).toBeUndefined();
  });

  it('extracts the artifact outside the checkout', () => {
    const download = steps(push).find((s) =>
      s.uses?.startsWith('actions/download-artifact@'),
    );
    expect(String(download?.with?.path)).toMatch(/^\$\{\{\s*runner\.temp/);
  });

  // A branch name is attacker-influenced text. In a `run:` an expression is
  // spliced into the script before bash sees it.
  it('passes every input through env, never inline in a script', () => {
    const inline = jobs.flatMap(([id, j]) =>
      steps(j)
        .filter((s) => (s.run ?? '').includes('${{'))
        .map(() => id),
    );
    expect(inline).toEqual([]);
  });
});

describe('#1237 workflow YAML is under the prettier gate', () => {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'ts', 'package.json'), 'utf-8'),
  ) as { scripts: Record<string, string> };

  it('format:check covers .github/workflows/*.yml', () => {
    expect(pkg.scripts['format:check']).toContain(
      '"../.github/workflows/*.yml"',
    );
  });

  // The glob names `.yml` only. A `.yaml` workflow would sit outside the gate
  // with nothing reporting the gap. (Prettier itself errors on a glob that
  // matches nothing, so the zero-file case is already loud.)
  it('workflows use the .yml extension the glob covers', () => {
    const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    expect(readdirSync(WORKFLOW_DIR).some((f) => f.endsWith('.yaml'))).toBe(
      false,
    );
  });
});

describe('#1238 actionlint runs in CI', () => {
  const wf = workflow('workflow-lint.yml');
  const job = wf.jobs?.actionlint;
  const install = (job?.steps ?? []).find(
    (s) => s.env?.ACTIONLINT_VERSION !== undefined,
  );

  // An unpinned version turns the job red whenever upstream adds a rule. An
  // unverified tarball trusts a git tag that can be moved.
  it('pins an exact actionlint version and verifies its SHA-256', () => {
    expect(job).toBeDefined();
    expect(install?.env?.ACTIONLINT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(install?.env?.ACTIONLINT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(install?.run).toContain('sha256sum -c');
    expect(install?.run).toMatch(
      /releases\/download\/v\$\{ACTIONLINT_VERSION\}/,
    );
  });

  it('runs read-only', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('is declared advisory in required-checks.json, with a reason', () => {
    const entry = advisoryEntries().find((e) => e.check === 'actionlint');
    expect(entry?.workflow).toBe('workflow-lint.yml');
    expect(entry?.reason.length ?? 0).toBeGreaterThan(20);
  });
});

describe('#1238 the *_BASE_FLAG expansions stay unquoted', () => {
  // Each flag holds zero or four arguments. Quoting it would fuse four
  // arguments into one on a PR, and pass an empty "" argument on push.
  const steps = Object.values(workflow('harness-quality.yml').jobs ?? {})
    .flatMap((j) => j.steps ?? [])
    .filter((s) => s.run);

  it.each(['DOCS_BASE_FLAG', 'BASE_FLAG', 'PERF_BASE_FLAG'])(
    '%s is expanded bare, with a scoped SC2086 directive',
    (name) => {
      const step = steps.find((s) => s.env?.[name] !== undefined);
      expect(step, `no step sets ${name}`).toBeDefined();
      expect(step!.run).toMatch(new RegExp(`\\s\\$${name}\\b`));
      expect(step!.run).not.toContain(`"$${name}"`);
      expect(step!.run).toMatch(/# shellcheck disable=SC2086/);
    },
  );
});

describe('#1427 a workflow that force-pushes declares a concurrency group', () => {
  // A force push is last-writer-wins. Two overlapping runs that force-update
  // the same ref lose one run's write, and nothing goes red. A `concurrency:`
  // group (workflow-level, or on the pushing job) makes them queue instead.
  // `cancel-in-progress: true` would not help: it kills the earlier run,
  // which drops the same write by a different route.
  const FORCE_PUSH =
    /\bgit\s+push\b[^\n]*?(?:\s--force(?:-with-lease)?\b|\s-f\b|\s\+[^\s]+)/;

  it.each([
    ['git push --force origin "HEAD:$BRANCH"', true],
    ['git push origin latest --force', true],
    ['git push --force-with-lease origin HEAD:x', true],
    ['git push -f origin HEAD:x', true],
    ['git push origin +HEAD:x', true],
    ['git push origin "HEAD:$BRANCH"', false],
    ['git push origin HEAD:master', false],
    ['git push --follow-tags origin main', false],
  ])('the detector classifies %s as force=%s', (line, force) => {
    expect(FORCE_PUSH.test(line)).toBe(force);
  });

  const forcePushers = readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml'))
    .flatMap((file) => {
      const wf = workflow(file);
      return Object.entries(wf.jobs ?? {})
        .filter(([, job]) =>
          (job.steps ?? []).some((s) => s.run && FORCE_PUSH.test(s.run)),
        )
        .map(([id, job]) => ({
          where: `${file} job ${id}`,
          concurrency: job.concurrency ?? wf.concurrency,
        }));
    });

  // A zero denominator would make the next test pass vacuously, e.g. after a
  // detector regression. These three are known force-pushers. Since #1426 the
  // push lives in a write job apart from the scan.
  it('finds the known force-pushing workflows', () => {
    const wheres = forcePushers.map((p) => p.where);
    expect(wheres).toContain('arch-snapshot.yml job push');
    expect(wheres).toContain('harness-security.yml job ledger');
    expect(wheres).toContain('release.yml job advance-latest');
  });

  // `security` is a required check. It no longer pushes (#1426 moved that to
  // `ledger`, which holds the ledger group), so a group on it only queues or
  // supersedes required-check runs. A static group there would make PR runs
  // wait behind `main` or be cancelled as superseded pending runs.
  it('the required security job carries no concurrency group', () => {
    const wf = workflow('harness-security.yml');
    expect(wf.concurrency).toBeUndefined();
    expect(wf.jobs?.security?.concurrency).toBeUndefined();
  });

  it('every force-pushing job is under a non-cancelling concurrency group', () => {
    const bad = forcePushers
      .filter(({ concurrency }) => {
        if (concurrency === undefined) return true;
        if (typeof concurrency === 'string') return concurrency.length === 0;
        return !concurrency.group || concurrency['cancel-in-progress'] === true;
      })
      .map((p) => p.where);
    expect(bad).toEqual([]);
  });
});

describe('#1428 setup-node takes its version from .nvmrc', () => {
  // A literal `node-version:` drifts the moment `.nvmrc` moves, and nothing
  // goes red until a tool's engine check bites. An expression is allowed only
  // where a job deliberately runs a different runtime: a `matrix.*` axis, or
  // a version computed by an earlier step (dogfood.yml derives the
  // unsupported runtime from the npm package's declared engine floor).
  const ALLOWED_EXPRESSION =
    /^\$\{\{\s*(?:matrix\.[\w.-]+|steps\.[\w-]+\.outputs\.[\w-]+)\s*\}\}$/;

  const setupNodeSteps = readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml'))
    .flatMap((file) =>
      Object.entries(workflow(file).jobs ?? {}).flatMap(([id, job]) =>
        (job.steps ?? [])
          .filter((s) => s.uses?.startsWith('actions/setup-node@'))
          .map((s) => ({ where: `${file} job ${id}`, with: s.with ?? {} })),
      ),
    );

  it.each([
    ['${{ matrix.node }}', true],
    ['${{ matrix.node-version }}', true],
    ['${{ steps.floor.outputs.unsupported }}', true],
    ['20', false],
    ['22.x', false],
    ["${{ '20' }}", false],
    ['${{ env.NODE }}', false],
  ])('the allow-list classifies %s as allowed=%s', (value, allowed) => {
    expect(ALLOWED_EXPRESSION.test(value)).toBe(allowed);
  });

  // Zero setup-node steps would make the next test pass vacuously.
  it('finds the setup-node steps', () => {
    expect(setupNodeSteps.length).toBeGreaterThanOrEqual(20);
  });

  it('no setup-node step hard-codes a literal node-version', () => {
    const bad = setupNodeSteps
      .filter((s) => {
        const v = s.with['node-version'];
        if (v === undefined) return s.with['node-version-file'] !== '.nvmrc';
        return !ALLOWED_EXPRESSION.test(String(v));
      })
      .map((s) => `${s.where}: ${JSON.stringify(s.with)}`);
    expect(bad).toEqual([]);
  });
});

/**
 * #1490. `actions/upload-artifact` roots the artifact at the least common
 * ancestor directory of the paths it uploads. One path,
 * `.harness/arch/timeline.json`, has its own directory as that ancestor, so
 * the artifact holds a bare `timeline.json` (artifact 12659041789 on run
 * 40340731570 listed exactly that). The push job looked for
 * `$SRC/.harness/arch/timeline.json` and failed on every run since #1461.
 * `harness-security.yml` uploads two paths whose common ancestor is the repo
 * root, so its entries keep their repo paths. That holds only while both
 * paths stay in the list.
 *
 * Each hand-off below pins its upload list and the artifact layout that list
 * produces. Then the real restore step runs against that layout. Editing an
 * upload list without fixing the matching restore step fails here.
 */
function artifactLayout(paths: string[]): string[] {
  const dirs = paths.map((p) => p.split('/').slice(0, -1));
  let common = 0;
  while (dirs.every((d) => common < d.length && d[common] === dirs[0]![common]))
    common++;
  return paths.map((p) => p.split('/').slice(common).join('/'));
}

describe('#1490 the artifact-layout model', () => {
  it.each([
    [['.harness/arch/timeline.json'], ['timeline.json']],
    [
      ['.harness/security/timeline.json', 'docs/SECURITY_LEDGER.md'],
      ['.harness/security/timeline.json', 'docs/SECURITY_LEDGER.md'],
    ],
    [
      ['.harness/a/x.json', '.harness/b/y.json'],
      ['a/x.json', 'b/y.json'],
    ],
    [['top.json'], ['top.json']],
  ])('roots %j at their common ancestor: %j', (paths, entries) => {
    expect(artifactLayout(paths)).toEqual(entries);
  });
});

interface Handoff {
  file: string;
  artifact: string;
  /** The upload list, pinned: changing it must fail this test. */
  upload: string[];
  /** Artifact entry -> checkout path the restore step must write. */
  entries: Record<string, string>;
  /** Entry -> real content, for a restore step that checks what it copies. */
  seed?: Record<string, { tree: string; artifact: string }>;
}

/** A one-metric baseline, byte-for-byte as the refresh script writes it. */
const refreshedBaseline = (value: number, updatedAt: string): string =>
  `${JSON.stringify(
    {
      updatedAt,
      updatedFrom: 'c'.repeat(40),
      metrics: { m: { value, violationIds: [] } },
    },
    null,
    2,
  )}\n`;

const HANDOFFS: Handoff[] = [
  {
    file: 'arch-snapshot.yml',
    artifact: 'arch-timeline',
    upload: ['.harness/arch/timeline.json'],
    entries: { 'timeline.json': '.harness/arch/timeline.json' },
  },
  {
    file: 'harness-security.yml',
    artifact: 'security-ledger',
    upload: [
      '.harness/security/timeline.json',
      '.harness/security/supply-chain.json',
      'docs/SECURITY_LEDGER.md',
    ],
    entries: {
      '.harness/security/timeline.json': '.harness/security/timeline.json',
      '.harness/security/supply-chain.json':
        '.harness/security/supply-chain.json',
      'docs/SECURITY_LEDGER.md': 'docs/SECURITY_LEDGER.md',
    },
  },
  {
    file: 'refresh-arch-baseline.yml',
    artifact: 'refreshed-arch-baseline',
    upload: ['.harness/arch/baselines.json', '.harness/audit.log'],
    entries: {
      'arch/baselines.json': '.harness/arch/baselines.json',
      'audit.log': '.harness/audit.log',
    },
    // #1463: this restore checks content, so it needs real files on both sides,
    // stamped and formatted as `scripts/refresh-arch-baseline.mjs` writes them.
    seed: {
      'arch/baselines.json': {
        tree: refreshedBaseline(1, '2026-01-01T00:00:00.000Z'),
        artifact: refreshedBaseline(2, '2026-11-12T00:00:00.000Z'),
      },
      'audit.log': { tree: 'log\n', artifact: 'log\nmore\n' },
    },
  },
];

describe.each(HANDOFFS)(
  '#1490 $file restores $artifact from where upload-artifact puts it',
  (h) => {
    const steps = Object.values(workflow(h.file).jobs ?? {}).flatMap(
      (j) => j.steps ?? [],
    );
    const upload = steps.find(
      (s) =>
        s.uses?.startsWith('actions/upload-artifact@') &&
        s.with?.name === h.artifact,
    );
    const downloadJob = Object.values(workflow(h.file).jobs ?? {}).find((j) =>
      (j.steps ?? []).some(
        (s) =>
          s.uses?.startsWith('actions/download-artifact@') &&
          s.with?.name === h.artifact,
      ),
    );
    const download = downloadJob?.steps?.find((s) =>
      s.uses?.startsWith('actions/download-artifact@'),
    );
    const restore = downloadJob?.steps?.find(
      (s) => s.env?.SRC !== undefined && s.run !== undefined,
    );

    it('uploads exactly the pinned path list', () => {
      const lines = String(upload?.with?.path ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      expect(lines.sort()).toEqual([...h.upload].sort());
    });

    it('pins the entries that upload list produces', () => {
      expect(artifactLayout(h.upload).sort()).toEqual(
        Object.keys(h.entries).sort(),
      );
    });

    it('restores from the directory the artifact was downloaded to', () => {
      expect(restore?.env?.SRC).toBeDefined();
      expect(restore!.env!.SRC).toBe(download?.with?.path);
    });

    it('copies every artifact entry to its checkout path', () => {
      const contentOf = (entry: string): string =>
        h.seed?.[entry]?.artifact ?? `from ${entry}\n`;
      const dir = mkdtempSync(join(tmpdir(), 'artifact-layout-'));
      try {
        const src = join(dir, 'artifact');
        const work = join(dir, 'work');
        for (const [entry, dest] of Object.entries(h.entries)) {
          mkdirSync(dirname(join(src, entry)), { recursive: true });
          writeFileSync(join(src, entry), contentOf(entry));
          mkdirSync(dirname(join(work, dest)), { recursive: true });
          const tree = h.seed?.[entry]?.tree;
          if (tree !== undefined) writeFileSync(join(work, dest), tree);
        }
        const r = spawnSync('bash', ['-e', '-c', restore!.run!], {
          cwd: work,
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', SRC: src },
        });
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
        for (const [entry, dest] of Object.entries(h.entries))
          expect(readFileSync(join(work, dest), 'utf8')).toBe(contentOf(entry));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
