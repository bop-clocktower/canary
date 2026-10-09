/**
 * bug-fleet A1: `workflow discover` with no `--project` reads
 * `.canary/company.json` directly and casts `jira_projects` to `string[]`
 * without the validation the CompanyKnowledge loader applies. A string value
 * passes the empty check and `for...of` walks it one character at a time, so
 * `"jira_projects": "ACME"` runs discovery for A, C, M and E.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WorkflowDiscoveryError } from '../src/core/workflow-discovery.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

describe('workflow discover: jira_projects must be a list of keys', () => {
  it('never discovers single characters of a string jira_projects', async () => {
    const dir = mkTmp();
    try {
      mkdirSync(join(dir, '.canary'), { recursive: true });
      writeFileSync(
        join(dir, '.canary', 'company.json'),
        JSON.stringify({ jira_projects: 'ACME' }),
        'utf-8',
      );
      const seen: string[] = [];
      await invokeCanary(['workflow', 'discover'], {
        cwd: dir,
        deps: {
          makeWorkflowDiscovery: () =>
            ({
              discover: async (key: string) => {
                seen.push(key);
                throw new WorkflowDiscoveryError('stub');
              },
            }) as never,
        },
      });
      expect(seen).not.toContain('A');
    } finally {
      rmTmp(dir);
    }
  });
});
