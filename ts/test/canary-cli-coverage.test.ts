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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CompanyKnowledge } from '../src/core/company-knowledge.js';
import { HealChange, HealResult } from '../src/core/pattern-healer.js';
import type { LintFinding } from '../src/core/static-linter.js';
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

  it('reports an error for an unknown framework', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['init', 'nope-fw'], { cwd: tmp });
      expect(res.code).toBe(0); // handler catches and reports
      expect(res.stdout).toContain('Error');
      expect(res.stdout).toContain('Supported frameworks');
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
    expect(res.stdout).toContain('is not a file');
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

  it('pipx success reports up-to-date', async () => {
    const res = await invokeCanary(['upgrade'], {
      deps: {
        runSubprocess: () => ({ status: 0, stdout: '', stderr: '' }),
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Already up to date');
  });

  it('falls back to pip when pipx is unavailable', async () => {
    let calls = 0;
    const res = await invokeCanary(['upgrade'], {
      deps: {
        runSubprocess: () => {
          calls += 1;
          return { status: calls === 1 ? 1 : 0, stdout: '', stderr: '' };
        },
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('trying pip');
  });

  it('reports failure when both fail (exit 1)', async () => {
    const res = await invokeCanary(['upgrade'], {
      deps: {
        runSubprocess: () => ({ status: 1, stdout: '', stderr: 'nope' }),
      },
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('Upgrade failed');
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
