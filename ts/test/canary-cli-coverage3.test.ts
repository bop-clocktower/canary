/**
 * Third coverage pass -- remaining branch pools: the recommend license/warning +
 * no-framework fallback paths, ticket-update report-JSON parsing (tuple vs bare
 * failed-name normalization + defaults), and the analyze `--since` / `--suite`
 * filter branches.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TransitionResult, UpdateResult } from '../src/core/ticket-updater.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

function fake<T>(obj: unknown): T {
  return obj as T;
}

const HISTORY_REL = join('test-results', 'reports', 'history-v2.jsonl');

describe('recommend: license warning + alternatives + no-framework', () => {
  const classifier = () =>
    fake({
      classify: () => ({ intent: '', test_type: 'performance', confidence: 1 }),
    });
  const registry = () =>
    fake({
      executionInfo: () => ({
        execution_command: 'k6 run {file}',
        ci_flags: [],
      }),
    });

  it('human output includes the license warning and alternatives', async () => {
    const recommender = () =>
      fake({
        recommend: () => [
          {
            framework: 'k6',
            file_extension: 'js',
            reason: ['perf'],
            warning: 'AGPL note',
            license: 'AGPL-3.0',
          },
          { framework: 'locust', file_extension: 'py', reason: ['alt'] },
        ],
      });
    const res = await invokeCanary(['recommend', 'perf'], {
      deps: {
        makeClassifier: classifier,
        makeRecommender: recommender,
        makeRegistry: registry,
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('License: AGPL note');
    expect(res.stdout).toContain('Alternatives:');
  });

  it('--json includes license + warning + execution_command', async () => {
    const recommender = () =>
      fake({
        recommend: () => [
          {
            framework: 'k6',
            file_extension: 'js',
            reason: ['perf'],
            warning: 'AGPL note',
            license: 'AGPL-3.0',
          },
        ],
      });
    const res = await invokeCanary(['recommend', 'perf', '--json'], {
      deps: {
        makeClassifier: classifier,
        makeRecommender: recommender,
        makeRegistry: registry,
      },
    });
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload['warning']).toBe('AGPL note');
    expect(payload['license']).toBe('AGPL-3.0');
    expect(payload['execution_command']).toBe('k6 run {file}');
  });

  it('prints None when no framework matches', async () => {
    const res = await invokeCanary(['recommend', 'perf'], {
      deps: {
        makeClassifier: classifier,
        makeRecommender: () => fake({ recommend: () => [] }),
        makeRegistry: () => fake({ executionInfo: () => null }),
      },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Framework: None');
  });
});

describe('ticket-update: report JSON parsing', () => {
  it('normalizes failed_names (tuple + bare) and passes defaults', async () => {
    const tmp = mkTmp();
    try {
      const report = join(tmp, 'report.json');
      writeFileSync(
        report,
        JSON.stringify({
          suite_name: 'api',
          env: 'uat',
          result: 'partial',
          passed_names: ['t_ok'],
          failed_names: [['t_bad', 'assertion'], 't_lonely'],
          duration_s: 1.5,
        }),
        'utf-8',
      );
      let received: unknown;
      const res = await invokeCanary(
        ['ticket-update', '--result', report, '--dry-run'],
        {
          deps: {
            makeTicketUpdater: () =>
              fake({
                update: async (summary: unknown) => {
                  received = summary;
                  return new UpdateResult({
                    ticket_key: null,
                    project_key: null,
                    linkage_source: 'none',
                    comment_posted: false,
                    transition: new TransitionResult(
                      false,
                      false,
                      null,
                      null,
                      'skipped',
                    ),
                    dry_run: true,
                    messages: ['ok'],
                  });
                },
              }),
          },
        },
      );
      expect(res.code).toBe(0);
      const s = received as {
        suite_name: string;
        result: string;
        failed_names: [string, string][];
      };
      expect(s.suite_name).toBe('api');
      expect(s.result).toBe('PARTIAL');
      expect(s.failed_names[0]).toEqual(['t_bad', 'assertion']);
      expect(s.failed_names[1]).toEqual(['t_lonely', 'unknown']);
    } finally {
      rmTmp(tmp);
    }
  });
});

describe('analyze filter branches', () => {
  function seeded(): string {
    const tmp = mkTmp();
    const path = join(tmp, HISTORY_REL);
    mkdirSync(join(tmp, 'test-results', 'reports'), { recursive: true });
    const record = {
      run_id: 'r1',
      suite: 'checkout',
      timestamp: '2026-07-02T00:00:00Z',
      passed: 1,
      failed: 1,
      flaky: 0,
      total: 2,
      commit_sha: 'aaaaaaaa',
      tests: [
        { test_name: 'test_ok', status: 'passed' },
        {
          test_name: 'test_pay',
          status: 'failed',
          failure_category: 'assertion',
          error_text: 'boom',
        },
      ],
    };
    writeFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
    return tmp;
  }

  it('flaky --suite, spikes --since, common-failures --since, digest --suite', async () => {
    for (const args of [
      ['flaky', '--suite', 'checkout', '--min-rate', '0'],
      ['spikes', '--since', '2026-01-01'],
      ['common-failures', '--since', '2026-01-01'],
      ['digest', '--suite', 'checkout', '--output', 'o'],
    ]) {
      const tmp = seeded();
      try {
        const res = await invokeCanary(['analyze', ...args], { cwd: tmp });
        expect(res.code).toBe(0);
      } finally {
        rmTmp(tmp);
      }
    }
  });

  it('spikes/common-failures --since filters everything out', async () => {
    const tmp = seeded();
    try {
      const spikes = await invokeCanary(
        ['analyze', 'spikes', '--since', '2027-01-01', '--json'],
        {
          cwd: tmp,
        },
      );
      expect(spikes.code).toBe(0);
      expect(JSON.parse(spikes.stdout)).toEqual([]);
    } finally {
      rmTmp(tmp);
    }
  });
});
