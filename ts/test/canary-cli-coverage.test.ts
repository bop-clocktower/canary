/**
 * Branch/format coverage for the main `canary` CLI surfaces not exercised by the
 * ported oracle tests: the human + --json paths of recommend/frameworks/feedback,
 * the review-test/flake-check/heal-test renderers, version/--version/help,
 * upgrade, the overlay/doctor npm-shim pointers, the skills / workflow /
 * company-knowledge sub-apps, and usage-error normalization.
 *
 * Deterministic branches use injected fakes; the real classifier/recommender/
 * registry/company-knowledge/workflow modules (already unit-tested) are driven
 * live where that is simpler.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CompanyKnowledge } from '../src/core/company-knowledge.js';
import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { HealChange, HealResult } from '../src/core/pattern-healer.js';
import type { LintFinding } from '../src/core/static-linter.js';
import {
  type RunSummary,
  TransitionResult,
  UpdateResult,
} from '../src/core/ticket-updater.js';
import {
  IssueType,
  SemanticRole,
  StatusEntry,
  TransitionEntry,
  WorkflowMapping,
} from '../src/core/workflow-discovery.js';
import type { MainDeps } from '../src/main-deps.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

function fake<T>(obj: unknown): T {
  return obj as T;
}

const finding = (over: Partial<LintFinding> = {}): LintFinding => ({
  file: 'f.py',
  line: 3,
  rule: 'R1',
  severity: 'warning',
  message: 'msg',
  suggestion: 'fix it',
  ...over,
});

describe('program-level: version / help / usage errors', () => {
  it('--version prints the banner and exits 0', async () => {
    const res = await invokeCanary(['--version'], {
      deps: { pkgVersion: () => '9.9.9' },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('canary');
  });

  it('no args prints help and exits 2 (no_args_is_help)', async () => {
    // Python typer(no_args_is_help=True) treats a bare invocation as a usage
    // exit (2), not a success (0).
    const res = await invokeCanary([]);
    expect(res.code).toBe(2);
  });

  it('an unknown option is a usage error (exit 2)', async () => {
    const res = await invokeCanary(['frameworks', '--bogus']);
    expect(res.code).toBe(2);
  });

  it('a missing required argument is a usage error (exit 2)', async () => {
    const res = await invokeCanary(['recommend']);
    expect(res.code).toBe(2);
  });
});

describe('recommend / frameworks (live)', () => {
  it('recommend human output', async () => {
    const res = await invokeCanary(['recommend', 'write playwright e2e tests']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Canary Recommendation');
    expect(res.stdout).toContain('Framework:');
  });

  it('recommend --json', async () => {
    const res = await invokeCanary([
      'recommend',
      'write playwright e2e tests',
      '--json',
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload['status']).toBe('success');
    expect(payload).toHaveProperty('execution_command');
  });

  it('frameworks human + --json', async () => {
    const human = await invokeCanary(['frameworks']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Canary Frameworks');
    const json = await invokeCanary(['frameworks', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toHaveProperty('frameworks');
  });
});

describe('feedback (live)', () => {
  it('rejects an unknown category', async () => {
    const res = await invokeCanary(['feedback', 'hi', '--category', 'bogus']);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('Unknown --category');
  });

  it('requires a message', async () => {
    const res = await invokeCanary(['feedback']);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('feedback message is required');
  });

  it('human output', async () => {
    const res = await invokeCanary(['feedback', 'love it']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Canary Feedback');
  });

  it('--json', async () => {
    const res = await invokeCanary(['feedback', 'love it', '--json']);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toHaveProperty('issue_url');
  });

  it('--open invokes the browser launcher', async () => {
    const open = vi.fn();
    const res = await invokeCanary(['feedback', 'love it', '--open'], {
      deps: { openBrowser: open },
    });
    expect(res.code).toBe(0);
    expect(open).toHaveBeenCalledTimes(1);
    expect(res.stdout).toContain('Opened in your browser');
  });
});

describe('init (live scaffolder)', () => {
  it('scaffolds each supported framework next steps', async () => {
    for (const fw of ['playwright', 'vitest', 'pytest', 'k6']) {
      const tmp = mkTmp();
      try {
        const res = await invokeCanary(['init', fw], { cwd: tmp });
        expect(res.code).toBe(0);
        expect(res.stdout).toContain('Scaffolding Complete');
      } finally {
        rmTmp(tmp);
      }
    }
  });

  // #1007: an unknown framework is a usage error -- exit 2, message on stderr.
  it('exits 2 with the error on stderr for an unknown framework', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['init', 'nope-fw'], { cwd: tmp });
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('Error');
      expect(res.stderr).toContain('Supported frameworks');
      expect(res.stdout).not.toContain('Supported frameworks');
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('review-test / flake-check (injected linter)', () => {
  it('review-test: no findings', async () => {
    const res = await invokeCanary(['review-test', 'x.py'], {
      deps: { makeLinter: () => fake({ lint: () => [] }) },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('No issues found');
  });

  it('review-test: sorted findings, counts, critical -> exit 1', async () => {
    const findings = [
      finding({ severity: 'info', line: 5 }),
      finding({ severity: 'critical', line: 1 }),
      finding({ severity: 'warning', line: 3 }),
    ];
    const res = await invokeCanary(['review-test', 'x.py'], {
      deps: { makeLinter: () => fake({ lint: () => findings }) },
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('finding(s):');
    expect(res.stdout).toContain('critical');
  });

  it('review-test --json', async () => {
    const res = await invokeCanary(['review-test', 'x.py', '--json'], {
      deps: { makeLinter: () => fake({ lint: () => [finding()] }) },
    });
    expect(res.code).toBe(0);
    expect(Array.isArray(JSON.parse(res.stdout))).toBe(true);
  });

  it('review-test over a directory walks for files', async () => {
    const tmp = mkTmp();
    try {
      writeFileSync(join(tmp, 'test_a.py'), 'x=1\n', 'utf-8');
      const seen: string[] = [];
      const res = await invokeCanary(['review-test', tmp], {
        deps: {
          makeLinter: () =>
            fake({
              lint: (p: string) => {
                seen.push(p);
                return [];
              },
            }),
        },
      });
      expect(res.code).toBe(0);
      expect(seen.some((p) => p.endsWith('test_a.py'))).toBe(true);
    } finally {
      rmTmp(tmp);
    }
  });

  it('flake-check: none / findings / json', async () => {
    const none = await invokeCanary(['flake-check', 'x.py'], {
      deps: { makeLinter: () => fake({ flakeCheck: () => [] }) },
    });
    expect(none.code).toBe(0);
    expect(none.stdout).toContain('No flakiness patterns detected');

    const hit = await invokeCanary(['flake-check', 'x.py'], {
      deps: {
        makeLinter: () =>
          fake({ flakeCheck: () => [finding({ severity: 'critical' })] }),
      },
    });
    expect(hit.code).toBe(1);
    expect(hit.stdout).toContain('flakiness pattern(s) found');

    // #566: `--json` used to exit 0 with findings on stdout, so a consumer
    // gating on `$?` read every finding-bearing run as clean. The payload is
    // still a parseable array -- only the exit code changed.
    const json = await invokeCanary(['flake-check', 'x.py', '--json'], {
      deps: { makeLinter: () => fake({ flakeCheck: () => [finding()] }) },
    });
    expect(json.code).toBe(1);
    expect(Array.isArray(JSON.parse(json.stdout))).toBe(true);
  });
});

describe('heal-test (injected healer)', () => {
  function healResult(changed: boolean): HealResult {
    const r = new HealResult('t.py');
    r.patched_content = 'patched\n';
    if (changed) {
      r.changes.push(
        new HealChange(2, 'HEAL-001', ' before ', ' after ', 'desc'),
      );
    } else {
      r.skipped.push('a brittle selector');
    }
    return r;
  }

  it('missing file exits 1', async () => {
    const res = await invokeCanary(['heal-test', '/no/such/file.py']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('is not a file');
  });

  it('no changes reports skipped', async () => {
    const tmp = mkTmp();
    try {
      const file = join(tmp, 't.py');
      writeFileSync(file, 'x=1\n', 'utf-8');
      const res = await invokeCanary(['heal-test', file], {
        deps: { makeHealer: () => fake({ heal: () => healResult(false) }) },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('No auto-fixable patterns found');
      expect(res.stdout).toContain('Skipped:');
    } finally {
      rmTmp(tmp);
    }
  });

  // Reproduction only -- documents a defect, no fix applied.
  // `heal-test` declares `--pattern` / `--no-pattern` (ts/src/cli.ts), but
  // `opts.pattern` is read nowhere in src/: healTestCmd applies the healer and
  // writes unconditionally, gated only by `--dry-run`. So a user who explicitly
  // disables pattern fixes still has the file rewritten in place.
  it('--no-pattern does not rewrite the file', async () => {
    const tmp = mkTmp();
    try {
      const file = join(tmp, 't.py');
      writeFileSync(file, 'orig\n', 'utf-8');
      const res = await invokeCanary(['heal-test', file, '--no-pattern'], {
        deps: { makeHealer: () => fake({ heal: () => healResult(true) }) },
      });
      expect(res.code).toBe(0);
      expect(readFileSync(file, 'utf-8')).toBe('orig\n');
    } finally {
      rmTmp(tmp);
    }
  });

  it('dry-run lists fixes; apply writes them; json emits payload', async () => {
    const tmp = mkTmp();
    try {
      const file = join(tmp, 't.py');
      writeFileSync(file, 'orig\n', 'utf-8');

      const dry = await invokeCanary(['heal-test', file, '--dry-run'], {
        deps: { makeHealer: () => fake({ heal: () => healResult(true) }) },
      });
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain('Pattern fixes for');
      expect(dry.stdout).toContain('ready');

      const applied = await invokeCanary(['heal-test', file], {
        deps: { makeHealer: () => fake({ heal: () => healResult(true) }) },
      });
      expect(applied.code).toBe(0);
      expect(applied.stdout).toContain('applied to');

      const json = await invokeCanary(['heal-test', file, '--json'], {
        deps: { makeHealer: () => fake({ heal: () => healResult(true) }) },
      });
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toHaveProperty('changes');
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('upgrade', () => {
  it('--dry-run', async () => {
    const res = await invokeCanary(['upgrade', '--dry-run']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Dry run');
  });

  it('upgrades through npm, the channel Canary actually ships on', async () => {
    const calls: Array<[string, string[]]> = [];
    const res = await invokeCanary(['upgrade'], {
      deps: {
        runSubprocess: (cmd, args) => {
          calls.push([cmd, args]);
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    });
    expect(res.code).toBe(0);
    expect(calls).toEqual([
      ['npm', ['install', '-g', 'canary-test-cli@latest']],
    ]);
  });

  it('does not touch the discontinued pipx/pip Python channel', async () => {
    const calls: Array<[string, string[]]> = [];
    const res = await invokeCanary(['upgrade'], {
      deps: {
        runSubprocess: (cmd, args) => {
          calls.push([cmd, args]);
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    });
    expect(res.code).toBe(0);
    const flat = calls
      .map(([cmd, args]) => [cmd, ...args].join(' '))
      .join('\n');
    expect(flat).not.toContain('pipx');
    expect(flat).not.toContain('pip install');
    expect(flat).not.toContain('canary-test-ai');
  });

  // Regression: a nonzero exit means the tool RAN and FAILED. Reporting it as
  // "not found" and swallowing its stderr hid the real cause (e.g. uv's
  // "does not appear to be a Python project") behind a bogus one.
  it('surfaces the real stderr when the upgrade tool runs and fails', async () => {
    const res = await invokeCanary(['upgrade'], {
      deps: {
        runSubprocess: () => ({
          status: 1,
          stdout: '',
          stderr:
            'EACCES: permission denied, mkdir /usr/local/lib/node_modules',
        }),
      },
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Upgrade failed');
    expect(res.stderr).toContain('EACCES: permission denied');
    expect(res.stderr).not.toContain('not found');
  });

  // Regression: `status: null` is the ONLY signal that the binary is missing
  // (main-deps maps a spawn error to null). Conflating it with a nonzero exit
  // is what produced the false "pipx not found".
  it('reports a genuinely missing binary distinctly from a failed run', async () => {
    const res = await invokeCanary(['upgrade'], {
      deps: {
        runSubprocess: () => ({ status: null, stdout: '', stderr: '' }),
      },
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('npm');
    expect(res.stderr).toContain('not found');
  });
});

describe('overlay / doctor npm-shim pointers', () => {
  it('overlay points at the npm install and exits 1', async () => {
    const res = await invokeCanary(['overlay', 'list']);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('provided by the npm install');
  });

  it('doctor points at the npm install and exits 1', async () => {
    const res = await invokeCanary(['doctor']);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('provided by the npm install');
  });

  it('uninstall points at the npm install and exits 1', async () => {
    // Trailing args are accepted and ignored: the shim never does the work.
    const res = await invokeCanary(['uninstall', '--yes']);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain(
      '`canary uninstall` is provided by the npm install of Canary.',
    );
    expect(res.stdout).toContain('npm install -g canary-test-cli');
    expect(res.stdout).toContain('does not include the uninstall command');
  });
});

describe('skills sub-app', () => {
  it('list: no skills abstains and names every root it searched (#757)', async () => {
    const res = await invokeCanary(['skills', 'list'], {
      deps: {
        makeSkillRegistry: () =>
          fake({
            discover: () => [],
            searchRoots: () => [
              { tier: 'bundled', path: '/pkg/agents/skills', exists: false },
            ],
          }),
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Abstained');
    expect(res.stdout).toContain('/pkg/agents/skills');
    // The old copy claimed there were none; it must not come back.
    expect(res.stdout).not.toContain('No skills found');
  });

  it('list: all sources + markers (+ verbose)', async () => {
    const skills = [
      {
        source: 'bundled',
        name: 'b1',
        path: '/x/skills/b1/SKILL.md',
        description: 'd',
        cli: null,
        entry: null,
        error: null,
      },
      {
        source: 'overlay',
        name: 'o1',
        path: '/h/.canary/overlays/ov/.canary/skills/o1/SKILL.md',
        description: '',
        cli: 'run.py',
        entry: null,
        error: null,
      },
      {
        source: 'global',
        name: 'g1',
        path: '/g/skills/g1/SKILL.md',
        description: '',
        cli: null,
        entry: 'm:f',
        error: null,
      },
      {
        source: 'local',
        name: 'l1',
        path: '/l/skills/l1/SKILL.md',
        description: '',
        cli: null,
        entry: null,
        error: 'bad',
      },
    ];
    const res = await invokeCanary(['skills', 'list', '-v'], {
      deps: { makeSkillRegistry: () => fake({ discover: () => skills }) },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Bundled skills:');
    expect(res.stdout).toContain('Overlay skills');
    expect(res.stdout).toContain('[cli]');
    expect(res.stdout).toContain('[entry]');
    expect(res.stdout).toContain('[error]');
  });

  it('run: refuses an executable skill in a non-interactive context (exit 3)', async () => {
    const skill = {
      error: null,
      isExecutable: true,
      cli: 'x.py',
      entry: null,
      name: 'e',
      dir: '.',
    };
    const res = await invokeCanary(['skills', 'run', 'e'], {
      deps: { makeSkillRegistry: () => fake({ find: () => skill }) },
    });
    expect(res.code).toBe(3);
    expect(res.stdout).toContain('Refusing to invoke');
  });
});

describe('workflow show / init', () => {
  function mapping(): WorkflowMapping {
    return new WorkflowMapping({
      project_key: 'ACME',
      source: 'jira',
      discovered_at: '2026-01-01T00:00:00+00:00',
      issue_types: [
        new IssueType(
          '1',
          'Story',
          [
            new StatusEntry('1', 'To Do', 'new'),
            new StatusEntry('2', 'Done', 'done'),
          ],
          [new TransitionEntry('1', 'Start', 'To Do', 'Done')],
        ),
      ],
      semantic_roles: { qa_passed: new SemanticRole('QA Passed', 'Story') },
      role_annotations_confirmed: true,
      atlassian_url: null,
    });
  }

  it('show: human, --json, --roles-only, json+roles', async () => {
    const wd: MainDeps['makeWorkflowDiscovery'] = () =>
      fake({ show: () => mapping() });
    const human = await invokeCanary(
      ['workflow', 'show', '--project', 'ACME'],
      {
        deps: { makeWorkflowDiscovery: wd },
      },
    );
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Story');
    expect(human.stdout).toContain('QA Passed');

    const json = await invokeCanary(
      ['workflow', 'show', '--project', 'ACME', '--json'],
      {
        deps: { makeWorkflowDiscovery: wd },
      },
    );
    expect(json.code).toBe(0);
    expect(json.stdout).toContain('project_key');

    const roles = await invokeCanary(
      ['workflow', 'show', '--project', 'ACME', '--roles-only', '--json'],
      { deps: { makeWorkflowDiscovery: wd } },
    );
    expect(roles.code).toBe(0);
    expect(JSON.parse(roles.stdout)).toHaveProperty('qa_passed');
  });

  it('show: no cached mapping exits 1', async () => {
    const res = await invokeCanary(['workflow', 'show', '--project', 'ZZZ'], {
      deps: { makeWorkflowDiscovery: () => fake({ show: () => null }) },
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('No cached mapping');
  });

  it('show: no project + no .canary reports no mappings (exit 0)', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['workflow', 'show'], { cwd: tmp });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('No cached workflow mappings');
    } finally {
      rmTmp(tmp);
    }
  });

  it('init: creates a mapping, then refuses without --force', async () => {
    const tmp = mkTmp();
    try {
      const created = await invokeCanary(
        [
          'workflow',
          'init',
          '--project',
          'ACME',
          '--qa-passed',
          'QA Passed',
          '--in-qa',
          'In QA',
        ],
        { cwd: tmp },
      );
      expect(created.code).toBe(0);
      expect(created.stdout).toContain('Created');

      const again = await invokeCanary(
        ['workflow', 'init', '--project', 'ACME', '--qa-passed', 'QA Passed'],
        { cwd: tmp },
      );
      expect(again.code).toBe(1);
      expect(again.stdout).toContain('already exists');
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('company-knowledge show / init', () => {
  it('show: empty configuration', async () => {
    const emptyHome = mkTmp();
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['company-knowledge', 'show'], {
        cwd: tmp,
        deps: {
          loadCompanyKnowledge: (env) =>
            CompanyKnowledge.load(tmp, env, emptyHome),
        },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('No company knowledge configured');
    } finally {
      rmTmp(tmp);
      rmTmp(emptyHome);
    }
  });

  it('show: populated (human + --json)', async () => {
    const emptyHome = mkTmp();
    const tmp = mkTmp();
    try {
      mkdirSync(join(tmp, '.canary'));
      writeFileSync(
        join(tmp, '.canary', 'company.json'),
        JSON.stringify({
          confluence_spaces: ['QA'],
          jira_projects: ['PROJ'],
          internal_doc_urls: ['https://x'],
          notes: 'hi',
        }),
        'utf-8',
      );
      const load = (env: string | null) =>
        CompanyKnowledge.load(tmp, env, emptyHome);

      const human = await invokeCanary(['company-knowledge', 'show'], {
        cwd: tmp,
        deps: { loadCompanyKnowledge: load },
      });
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('Company Knowledge');
      expect(human.stdout).toContain('PROJ');

      const json = await invokeCanary(['company-knowledge', 'show', '--json'], {
        cwd: tmp,
        deps: { loadCompanyKnowledge: load },
      });
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toHaveProperty('jira_projects');
    } finally {
      rmTmp(tmp);
      rmTmp(emptyHome);
    }
  });

  it('init: warns then writes when a config already exists', async () => {
    const emptyHome = mkTmp();
    const tmp = mkTmp();
    try {
      mkdirSync(join(tmp, '.canary'));
      writeFileSync(join(tmp, '.canary', 'company.json'), '{}', 'utf-8');
      const res = await invokeCanary(['company-knowledge', 'init'], {
        cwd: tmp,
        deps: { home: () => emptyHome },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('already exists');
      expect(res.stdout).toContain('Written to');
    } finally {
      rmTmp(tmp);
      rmTmp(emptyHome);
    }
  });
});

describe('history human-readable paths', () => {
  // #508 Wave 4a: this used to assert `No tests above N%` over an EMPTY store
  // -- a green all-clear from a run that examined zero runs. That is the exact
  // silent-abstention shape the doctrine exists to end, so the pin now asserts
  // the loud outcome. The `No tests above` line still ships; it just requires a
  // non-zero denominator to earn it (covered by the seeded-store test below).
  it('flaky over an EMPTY store abstains, never a green all-clear', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['history', 'flaky'], { cwd: tmp });
      expect(res.code).toBe(0); // advisory (D3)
      expect(res.stdout).toContain('Abstained');
      expect(res.stdout).not.toContain('No tests above');
    } finally {
      rmTmp(tmp);
    }
  });

  it('summary prints the suite line', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['history', 'summary', 'api'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Suite');
    } finally {
      rmTmp(tmp);
    }
  });

  // #508 (review round): this pointed at an EMPTY store, so it asserted
  // `No history found for: nope` over a store that held nothing at all -- the
  // silent-abstention shape restated as a test, for the fourth time in this
  // epic. Reporting the miss is real behavior; it just needs recorded runs to
  // be a miss rather than an absence. (Empty-store abstention is covered in
  // abstention-longtail.test.ts.)
  it('timeline reports the miss when the store HAS runs', async () => {
    const tmp = mkTmp();
    try {
      const dir = join(tmp, 'test-results', 'reports');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'history-v2.jsonl'),
        `${JSON.stringify({
          run_id: 'r1',
          suite: 'api',
          repo: 'o/r',
          branch: 'main',
          commit_sha: 'abc1234',
          timestamp: '2026-08-01T00:00:00+00:00',
          total: 1,
          passed: 1,
          failed: 0,
          flaky: 0,
          skipped: 0,
          tests: [{ test_name: 't1', status: 'passed' }],
        })}\n`,
        'utf-8',
      );
      const res = await invokeCanary(['history', 'timeline', 'nope'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('No history found for');
      expect(res.stdout).not.toContain('Abstained');
    } finally {
      rmTmp(tmp);
    }
  });

  it('migrate applies (writes) a v1 record', async () => {
    const tmp = mkTmp();
    try {
      const v1 = join(tmp, 'history.jsonl');
      writeFileSync(
        v1,
        JSON.stringify({
          commit_short: 'abc',
          timestamp: '2026-01-01T00:00:00Z',
          run: { total: 1, passed: 1 },
        }) + '\n',
        'utf-8',
      );
      const res = await invokeCanary(
        ['history', 'migrate', v1, '--suite', 'api', '--repo', 'a/b'],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Migrated 1 runs');
    } finally {
      rmTmp(tmp);
    }
  });
});

// --- cli-commands.ts gap pass (test-fleet) ------------------------------------

describe('recommend / frameworks: sparse registry data', () => {
  it('recommend --json nulls the run command when the registry has no entry', async () => {
    const res = await invokeCanary(
      ['recommend', 'write playwright e2e tests', '--json'],
      { deps: { makeRegistry: () => fake({ executionInfo: () => null }) } },
    );
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload['execution_command']).toBeNull();
    expect(payload['ci_flags']).toEqual([]);
  });

  it('frameworks falls back for a missing tier, category, and run command', async () => {
    const summaries = [
      {
        name: 'acme-fw',
        status: 'beta',
        tier: '',
        category: '',
        execution_command: '',
        ci_flags: [],
      },
      {
        name: 'example-fw',
        status: '',
        tier: 'experimental',
        category: 'unit',
        execution_command: 'example run {file}',
        ci_flags: ['--ci'],
      },
    ];
    const res = await invokeCanary(['frameworks'], {
      deps: { makeRegistry: () => fake({ summaries: () => summaries }) },
    });
    expect(res.code).toBe(0);
    // An empty tier reads as `catalog`; an empty category reads as `n/a`.
    expect(res.stdout).toContain('acme-fw catalog (beta) \u{2014} n/a');
    expect(res.stdout).toContain('run: (no run command)');
    // An unrecognised tier is still printed verbatim, not dropped.
    expect(res.stdout).toContain('example-fw experimental \u{2014} unit');
    expect(res.stdout).toContain('ci:  --ci');
  });
});

describe('init: injected scaffolder results', () => {
  it('lists skipped files and prints no install step for an unlisted framework', async () => {
    const res = await invokeCanary(['init', 'acme'], {
      deps: {
        makeScaffolder: () =>
          fake({
            scaffold: () => ({ status: 'ok', skipped_files: ['acme.config'] }),
          }),
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Files Skipped (Already Exist):');
    expect(res.stdout).toContain('  - acme.config');
    expect(res.stdout).not.toContain('Directories Created:');
    expect(res.stdout).not.toContain('1. Run:');
  });

  it('reports a non-Error throw from the scaffolder as a usage error (exit 2)', async () => {
    const res = await invokeCanary(['init', 'acme'], {
      deps: {
        makeScaffolder: () =>
          fake({
            scaffold: () => {
              throw 'scaffold exploded';
            },
          }),
      },
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Error: scaffold exploded');
  });
});

describe('migrate: injected migrator failures', () => {
  // Each case pins an empty home so a host's tracked overlays never leak in.
  function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkTmp();
    return fn(dir).finally(() => rmTmp(dir));
  }

  it('--adoption-report exits 1 with the error on stderr when detection throws', () =>
    withTmp(async (dir) => {
      const res = await invokeCanary(
        ['migrate', '--path', dir, '--adoption-report'],
        {
          deps: {
            home: () => dir,
            makeMigrator: () =>
              fake({
                detect: () => {
                  throw new Error('adoption probe failed');
                },
              }),
          },
        },
      );
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('adoption probe failed');
    }));

  it('--check exits 1 with the error on stderr when the freshness check throws', () =>
    withTmp(async (dir) => {
      const overlay = join(dir, 'overlay');
      mkdirSync(overlay);
      const res = await invokeCanary(
        ['migrate', '--path', dir, '--check', '--from', overlay],
        {
          deps: {
            home: () => dir,
            makeMigrator: () =>
              fake({
                checkFreshness: () => {
                  throw new Error('freshness probe failed');
                },
              }),
          },
        },
      );
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('freshness probe failed');
    }));

  it('exits 1 with "Detection error" on stderr when detect throws', () =>
    withTmp(async (dir) => {
      const res = await invokeCanary(['migrate', '--path', dir], {
        deps: {
          home: () => dir,
          makeMigrator: () =>
            fake({
              detect: () => {
                throw new Error('unreadable tree');
              },
            }),
        },
      });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('Detection error: unreadable tree');
    }));

  it('exits 1 with the error on stderr when migrate itself throws', () =>
    withTmp(async (dir) => {
      const res = await invokeCanary(['migrate', '--path', dir], {
        deps: {
          home: () => dir,
          makeMigrator: () =>
            fake({
              detect: () => ({ is_harness_project: true }),
              migrate: () => {
                throw new Error('write refused');
              },
            }),
        },
      });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('Error: write refused');
    }));

  it('a dry run with pending files tells the user to re-run with --apply', () =>
    withTmp(async (dir) => {
      const migrate = vi.fn(() => ({
        would_create: ['tests/acme.test.ts'],
        to_markdown: () => '## plan',
      }));
      const res = await invokeCanary(['migrate', '--path', dir], {
        deps: {
          home: () => dir,
          makeMigrator: () =>
            fake({ detect: () => ({ is_harness_project: true }), migrate }),
        },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('## plan');
      expect(res.stdout).toContain('Re-run with --apply to write these files.');
      expect(migrate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ dryRun: true }),
      );
    }));
});

describe('review-test / flake-check: remaining render branches', () => {
  it('review-test sorts findings by file, then line, then severity', async () => {
    const res = await invokeCanary(['review-test', 'x.test.ts'], {
      deps: {
        makeLinter: () =>
          fake({
            // Each key is the only difference between one adjacent pair:
            // file (b vs a), line (3 vs 1), severity (info vs warning).
            lint: () => [
              finding({ file: 'b.py', line: 1, message: 'fourth' }),
              finding({ file: 'a.py', severity: 'info', message: 'third' }),
              finding({ file: 'a.py', line: 3, message: 'second' }),
              finding({ file: 'a.py', line: 1, message: 'first' }),
            ],
          }),
      },
    });
    expect(res.code).toBe(0);
    const order = ['first', 'second', 'third', 'fourth'].map((m) =>
      res.stdout.indexOf(`  ${m}\n`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it('review-test with only info findings lists them and still exits 0', async () => {
    const res = await invokeCanary(['review-test', 'x.test.ts'], {
      deps: {
        makeLinter: () =>
          fake({ lint: () => [finding({ severity: 'info', message: 'nit' })] }),
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[INFO] f.py:3');
    expect(res.stdout).toContain('1 finding(s): 1 info');
    expect(res.stdout).not.toContain('warning');
  });

  it('flake-check fails on a non-critical finding too (any flake is exit 1)', async () => {
    const res = await invokeCanary(['flake-check', 'x.test.ts'], {
      deps: {
        makeLinter: () =>
          fake({ flakeCheck: () => [finding({ message: 'sleeps 500ms' })] }),
      },
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('[WARNING] f.py:3 (R1)');
    expect(res.stdout).toContain('  sleeps 500ms');
    expect(res.stdout).toContain('1 flakiness pattern(s) found.');
  });

  it('review-test on an extensionless file abstains by naming the file', async () => {
    const res = await invokeCanary(['review-test', 'Makefile']);
    expect(res.code).toBe(EXIT_ABSTAINED);
    expect(res.stdout).toContain('Cannot lint Makefile');
  });

  it('review-test --json keeps stdout parseable and reports an unreadable file on stderr', async () => {
    const dir = mkTmp();
    try {
      writeFileSync(join(dir, 'a.test.ts'), '', 'utf-8');
      writeFileSync(join(dir, 'b.test.ts'), '', 'utf-8');
      const lint = (f: string): LintFinding[] => {
        if (f.endsWith('b.test.ts'))
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return [];
      };
      const res = await invokeCanary(['review-test', dir, '--json'], {
        deps: { makeLinter: () => fake({ lint }) },
      });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual([]);
      expect(res.stderr).toContain('Not every collected file was read');
      expect(res.stderr).toContain('EACCES');
    } finally {
      rmTmp(dir);
    }
  });

  it('flake-check --json with no findings emits [] and exits 0', async () => {
    const res = await invokeCanary(['flake-check', 'x.test.ts', '--json'], {
      deps: { makeLinter: () => fake({ flakeCheck: () => [] }) },
    });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual([]);
  });
});

describe('vacuity-check / promote-check: remaining branches', () => {
  const CLEAN = [
    `import { it, expect } from 'vitest';`,
    `import { save } from './store.js';`,
    `it('saves the row', () => {`,
    `  expect(save({ id: 7 })).toBe(7);`,
    `});`,
    '',
  ].join('\n');

  it('vacuity-check over a directory reports both denominators', async () => {
    const dir = mkTmp();
    try {
      writeFileSync(join(dir, 'store.test.ts'), CLEAN, 'utf-8');
      const res = await invokeCanary(['vacuity-check', dir]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('[1 file(s) resolved, 1 test(s) scanned]');
    } finally {
      rmTmp(dir);
    }
  });

  it('vacuity-check on a single file resolves exactly that file', async () => {
    const dir = mkTmp();
    try {
      const path = join(dir, 'store.test.ts');
      writeFileSync(path, CLEAN, 'utf-8');
      const res = await invokeCanary(['vacuity-check', path]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('[1 file(s) resolved, 1 test(s) scanned]');
    } finally {
      rmTmp(dir);
    }
  });

  it('promote-check --json exits 0 with a promote decision for a clean draft', async () => {
    const dir = mkTmp();
    try {
      const path = join(dir, 'gen.test.ts');
      writeFileSync(path, CLEAN, 'utf-8');
      const res = await invokeCanary(['promote-check', path, '--json']);
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout).decision).toBe('promote');
    } finally {
      rmTmp(dir);
    }
  });
});

describe('heal-test: skipped items and json dry-run', () => {
  function mixedResult(): HealResult {
    const r = new HealResult('t.py');
    r.patched_content = 'patched\n';
    r.changes.push(new HealChange(2, 'HEAL-001', ' before ', ' after ', 'd'));
    r.skipped.push('a brittle selector');
    return r;
  }

  it('lists what it skipped alongside the fixes it applied', async () => {
    const dir = mkTmp();
    try {
      const f = join(dir, 't.py');
      writeFileSync(f, 'orig\n', 'utf-8');
      const res = await invokeCanary(['heal-test', f], {
        deps: { makeHealer: () => fake({ heal: () => mixedResult() }) },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Skipped: a brittle selector');
      expect(res.stdout).toContain('1 fix(es) applied');
      expect(readFileSync(f, 'utf-8')).toBe('patched\n');
    } finally {
      rmTmp(dir);
    }
  });

  it('--json --dry-run reports the change without rewriting the file', async () => {
    const dir = mkTmp();
    try {
      const f = join(dir, 't.py');
      writeFileSync(f, 'orig\n', 'utf-8');
      const res = await invokeCanary(['heal-test', f, '--json', '--dry-run'], {
        deps: { makeHealer: () => fake({ heal: () => mixedResult() }) },
      });
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout).changed).toBe(true);
      expect(readFileSync(f, 'utf-8')).toBe('orig\n');
    } finally {
      rmTmp(dir);
    }
  });
});

describe('upgrade: failure detail fallbacks', () => {
  it('falls back to npm stdout when stderr is empty', async () => {
    const res = await invokeCanary(['upgrade'], {
      deps: {
        runSubprocess: () => ({ status: 1, stdout: 'ERR! 404', stderr: '' }),
      },
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('ERR! 404');
  });

  it('names the exit status when npm printed nothing', async () => {
    const res = await invokeCanary(['upgrade'], {
      deps: { runSubprocess: () => ({ status: 7, stdout: '', stderr: '' }) },
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('npm exited 7.');
  });
});

describe('ticket-update: result coercion and quiet outcomes', () => {
  function quietResult(): UpdateResult {
    return new UpdateResult({
      ticket_key: 'PROJ-1',
      project_key: 'PROJ',
      linkage_source: 'branch',
      comment_posted: false,
      transition: new TransitionResult(false, false, null, null, 'skipped'),
      dry_run: false,
      messages: [],
    });
  }

  it('coerces an unrecognised result value to FAIL', async () => {
    const dir = mkTmp();
    try {
      const report = join(dir, 'report.json');
      writeFileSync(report, JSON.stringify({ result: 'maybe' }), 'utf-8');
      const seen: RunSummary[] = [];
      const res = await invokeCanary(['ticket-update', '--result', report], {
        deps: {
          makeTicketUpdater: () =>
            fake({
              update: async (s: RunSummary) => {
                seen.push(s);
                return quietResult();
              },
            }),
        },
      });
      expect(res.code).toBe(0);
      expect(seen.map((s) => s.result)).toEqual(['FAIL']);
    } finally {
      rmTmp(dir);
    }
  });

  it('prints nothing when nothing was posted or attempted', async () => {
    const res = await invokeCanary(['ticket-update'], {
      deps: {
        makeTicketUpdater: () => fake({ update: async () => quietResult() }),
      },
    });
    expect(res.code).toBe(0);
    // Nothing happened and the updater said nothing, so the CLI adds nothing.
    expect(res.stdout.trim()).toBe('');
  });
});
