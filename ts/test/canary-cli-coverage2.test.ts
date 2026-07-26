/**
 * Second coverage pass -- branch-heavy paths not hit by the first pass:
 * `defaultMainDeps` real seams, analyze human renderers, history tables/push,
 * `skills run` cli/entry branches, workflow roles-only/init-url/discover errors,
 * the full company-knowledge show field set, migrate apply/json/no-harness, and
 * ticket-update rendering.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TransitionResult, UpdateResult } from '../src/core/ticket-updater.js';
import { defaultMainDeps } from '../src/main-deps.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

function fake<T>(obj: unknown): T {
  return obj as T;
}

const WARN = '\u{26a0}';

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

function seed(tmp: string): void {
  const path = join(tmp, HISTORY_REL);
  mkdirSync(join(tmp, 'test-results', 'reports'), { recursive: true });
  const record = {
    run_id: 'r1',
    suite: 'checkout',
    timestamp: '2026-07-02T00:00:00Z',
    passed: 1,
    failed: 1,
    flaky: 1,
    total: 3,
    commit_sha: 'aaaaaaaa',
    tests: [
      { test_name: 'test_ok', status: 'passed' },
      {
        test_name: 'test_pay',
        status: 'failed',
        failure_category: 'assertion',
        error_text: 'AssertionError: boom',
      },
    ],
  };
  writeFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
}

describe('defaultMainDeps seams', () => {
  it('runSubprocess captures, reports exit codes, and survives a missing binary', () => {
    const d = defaultMainDeps();
    const ok = d.runSubprocess('node', ['-e', 'process.stdout.write("hi")']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('hi');
    const code = d.runSubprocess('node', ['-e', 'process.exit(3)'], {
      cwd: process.cwd(),
    });
    expect(code.status).toBe(3);
    const missing = d.runSubprocess('no-such-binary-xyz-123', []);
    expect(missing.status).toBeNull();
  });

  it('non-seam defaults return sane values and factories construct', () => {
    const d = defaultMainDeps();
    expect(d.pkgVersion()).toBe('unknown');
    expect(typeof d.pythonExe()).toBe('string');
    expect(typeof d.home()).toBe('string');
    expect(typeof d.cwd()).toBe('string');
    expect(typeof d.prompt('q', 'def')).toBe('string');
    d.openBrowser('http://example.test');
    expect(d.makeClassifier()).toBeTruthy();
    expect(d.makeRecommender()).toBeTruthy();
    expect(d.makeRegistry()).toBeTruthy();
    expect(d.makeExecutor()).toBeTruthy();
    expect(d.makeScaffolder()).toBeTruthy();
    expect(d.makeMigrator()).toBeTruthy();
    expect(d.makeLinter()).toBeTruthy();
    expect(d.makeHealer()).toBeTruthy();
    expect(d.makeSkillRegistry()).toBeTruthy();
    expect(d.makeWorkflowDiscovery()).toBeTruthy();
    expect(d.makeTicketUpdater()).toBeTruthy();
    expect(d.loadCompanyKnowledge(null)).toBeTruthy();
  });
});

describe('analyze human renderers', () => {
  const run = (args: string[]) => {
    const tmp = mkTmp();
    seed(tmp);
    return invokeCanary(['analyze', ...args], { cwd: tmp }).finally(() =>
      rmTmp(tmp),
    );
  };

  it('spikes / area-health / common-failures / regression human output', async () => {
    for (const cmd of [
      ['spikes'],
      ['area-health'],
      ['common-failures'],
      ['regression-candidates'],
    ]) {
      const res = await run(cmd);
      expect(res.code).toBe(0);
    }
  });

  it('digest human + slack', async () => {
    const human = await run(['digest', '--output', 'o']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Artifacts written to');
    const slack = await run(['digest', '--slack', '--output', 'o']);
    expect(slack.code).toBe(0);
    expect(slack.stdout).toContain('Fleet Health Digest');
  });
});

describe('history tables + push', () => {
  it('timeline renders a table for a known test', async () => {
    const tmp = mkTmp();
    try {
      seed(tmp);
      const res = await invokeCanary(['history', 'timeline', 'test_pay'], {
        cwd: tmp,
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Timeline: test_pay');
    } finally {
      rmTmp(tmp);
    }
  });

  it('push (non-dry) pushes the latest run to the local store', async () => {
    const tmp = mkTmp();
    try {
      seed(tmp);
      const res = await invokeCanary(
        ['history', 'push', join(tmp, HISTORY_REL)],
        {
          cwd: tmp,
        },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Pushed');
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('skills run: cli + entry branches', () => {
  it('runs a cli target and forwards its exit code', async () => {
    const tmp = mkTmp();
    try {
      const cli = join(tmp, 'run.js');
      writeFileSync(cli, 'process.exit(0)\n', 'utf-8');
      chmodSync(cli, 0o755);
      const skill = {
        error: null,
        isExecutable: true,
        cli: 'run.js',
        entry: null,
        name: 'e',
        dir: tmp,
      };
      const res = await invokeCanary(
        ['skills', 'run', 'e', '--allow-executable-skills'],
        {
          deps: {
            makeSkillRegistry: () => fake({ find: () => skill }),
            runSubprocess: () => ({ status: 0, stdout: '', stderr: '' }),
          },
        },
      );
      expect(res.code).toBe(0);
    } finally {
      rmTmp(tmp);
    }
  });

  it('rejects a malformed entry (exit 5)', async () => {
    const skill = {
      error: null,
      isExecutable: true,
      cli: null,
      entry: 'noattr',
      name: 'e',
      dir: '.',
    };
    const res = await invokeCanary(
      ['skills', 'run', 'e', '--allow-executable-skills'],
      { deps: { makeSkillRegistry: () => fake({ find: () => skill }) } },
    );
    expect(res.code).toBe(5);
    expect(res.stdout).toContain("must be 'module:callable'");
  });

  it('reports an unresolvable entry module (exit 6)', async () => {
    const skill = {
      error: null,
      isExecutable: true,
      cli: null,
      entry: 'totally-missing-module-xyz:main',
      name: 'e',
      dir: '.',
    };
    const res = await invokeCanary(
      ['skills', 'run', 'e', '--allow-executable-skills'],
      { deps: { makeSkillRegistry: () => fake({ find: () => skill }) } },
    );
    expect(res.code).toBe(6);
  });
});

describe('workflow discover / show branches', () => {
  it('discover prints the unconfirmed tip', async () => {
    const mapping = {
      issue_types: ['Story'],
      semantic_roles: { qa_passed: 'x' },
      role_annotations_confirmed: false,
      toJson: () => '{}',
    };
    const res = await invokeCanary(
      ['workflow', 'discover', '--project', 'ACME'],
      {
        deps: {
          makeWorkflowDiscovery: () => fake({ discover: async () => mapping }),
        },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Tip: verify role assignments');
  });

  it('discover surfaces a WorkflowDiscoveryError and exits 1', async () => {
    const { WorkflowDiscoveryError } =
      await import('../src/core/workflow-discovery.js');
    const res = await invokeCanary(
      ['workflow', 'discover', '--project', 'ACME'],
      {
        deps: {
          makeWorkflowDiscovery: () =>
            fake({
              discover: async () => {
                throw new WorkflowDiscoveryError('creds missing');
              },
            }),
        },
      },
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('Discovery failed for: ACME');
  });

  it('show --roles-only human path', async () => {
    const { WorkflowMapping, SemanticRole } =
      await import('../src/core/workflow-discovery.js');
    const mapping = new WorkflowMapping({
      project_key: 'ACME',
      source: 'jira',
      discovered_at: '2026-01-01T00:00:00+00:00',
      issue_types: [],
      semantic_roles: { qa_passed: new SemanticRole('QA Passed', 'Story') },
      role_annotations_confirmed: false,
      atlassian_url: null,
    });
    const res = await invokeCanary(
      ['workflow', 'show', '--project', 'ACME', '--roles-only'],
      { deps: { makeWorkflowDiscovery: () => fake({ show: () => mapping }) } },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Semantic roles:');
    expect(res.stdout).toContain('QA Passed');
  });

  it('init records atlassian_url when provided', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(
        [
          'workflow',
          'init',
          '--project',
          'INTERNAL',
          '--qa-passed',
          'Done',
          '--atlassian-url',
          'https://internal.atlassian.net/',
        ],
        { cwd: tmp },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('atlassian_url');
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('company-knowledge show: full field set', () => {
  it('renders every populated pointer field', async () => {
    const { CompanyKnowledge } =
      await import('../src/core/company-knowledge.js');
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
          internal_domains: ['corp.example.com'],
          mcp_servers: ['plugin_x'],
          claude_code_skills: ['team:s'],
          dashboard_url: 'https://dash',
          otel_exporter_endpoint: 'https://otel',
          notes: 'hi',
          brand: { company_name: 'Acme' },
        }),
        'utf-8',
      );
      const res = await invokeCanary(['company-knowledge', 'show'], {
        cwd: tmp,
        deps: {
          loadCompanyKnowledge: (env) =>
            CompanyKnowledge.load(tmp, env, emptyHome),
        },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Internal domains:');
      expect(res.stdout).toContain('MCP servers:');
      expect(res.stdout).toContain('Dashboard URL:');
      expect(res.stdout).toContain('OTel endpoint:');
      expect(res.stdout).toContain('Brand:');
    } finally {
      rmTmp(tmp);
      rmTmp(emptyHome);
    }
  });
});

describe('migrate apply / json / no-harness', () => {
  function harnessProject(root: string): void {
    writeFileSync(
      join(root, 'harness.config.json'),
      '{"framework": "vitest"}',
      'utf-8',
    );
    mkdirSync(join(root, '.harness'));
  }

  it('exits 1 when no harness project is detected', async () => {
    const tmp = mkTmp();
    try {
      const res = await invokeCanary(['migrate', '--path', tmp], {
        deps: { home: () => mkTmp() },
      });
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('No harness project detected');
    } finally {
      rmTmp(tmp);
    }
  });

  it('dry-run then --apply then --json', async () => {
    const base = mkTmp();
    try {
      const project = join(base, 'proj');
      const home = join(base, 'home');
      mkdirSync(project);
      mkdirSync(home, { recursive: true });
      harnessProject(project);

      const dry = await invokeCanary(['migrate', '--path', project], {
        deps: { home: () => home },
      });
      expect(dry.code).toBe(0);

      const applied = await invokeCanary(
        ['migrate', '--path', project, '--apply'],
        {
          deps: { home: () => home },
        },
      );
      expect(applied.code).toBe(0);

      const json = await invokeCanary(
        ['migrate', '--path', project, '--json'],
        {
          deps: { home: () => home },
        },
      );
      expect(json.code).toBe(0);
      // migrate prints the "Canary Migrate" header before the JSON body (faithful
      // to the Python oracle), so parse from the first brace.
      expect(
        JSON.parse(json.stdout.slice(json.stdout.indexOf('{'))),
      ).toHaveProperty('framework');
    } finally {
      rmTmp(base);
    }
  });
});

describe('ticket-update rendering', () => {
  function result(reason: string, succeeded: boolean): UpdateResult {
    return new UpdateResult({
      ticket_key: 'PROJ-1',
      project_key: 'PROJ',
      linkage_source: 'branch',
      comment_posted: true,
      transition: new TransitionResult(true, succeeded, 'A', 'B', reason),
      dry_run: false,
      messages: ['a message line'],
    });
  }

  it('renders comment + transition on success', async () => {
    const res = await invokeCanary(['ticket-update'], {
      deps: {
        makeTicketUpdater: () =>
          fake({ update: async () => result('ok', true) }),
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('a message line');
    expect(res.stdout).toContain('Comment posted to PROJ-1');
    expect(res.stdout).toContain('Transitioned PROJ-1');
  });

  it('exits 1 when the transition reason is a warning', async () => {
    const res = await invokeCanary(['ticket-update'], {
      deps: {
        makeTicketUpdater: () =>
          fake({ update: async () => result(`${WARN} blocked`, false) }),
      },
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('Transition failed');
  });

  it('dry-run skips the post-write rendering', async () => {
    const res = await invokeCanary(['ticket-update', '--dry-run'], {
      deps: {
        makeTicketUpdater: () =>
          fake({ update: async () => result('ok', true) }),
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('Comment posted to');
  });
});
