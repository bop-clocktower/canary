/**
 * manhunter's quarantine section mirrors canary-katana's
 * CAUSES_REQUIRING_ISSUE (ts/src/analysis/manhunter/ledger.ts), because the
 * published `ts/` package does not ship agents/skills and cannot import
 * ledger.mjs at runtime. This test checks the mirror against katana's own
 * lists (#1330). For EVERY cause katana knows, an issueless row must raise
 * the "no linked issue" eye if and only if katana requires an issue for that
 * cause. The check is on behaviour, not on the mirror's array, so a reorder
 * or a refactor of rowEyes cannot hide a missing cause.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ledgerSection } from '../src/analysis/manhunter/ledger.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KATANA_LEDGER = join(
  REPO_ROOT,
  'agents',
  'skills',
  'claude-code',
  'canary-katana',
  'scripts',
  'ledger.mjs',
);

interface KatanaLedger {
  CAUSES: string[];
  CAUSES_REQUIRING_ISSUE: string[];
}

let katana: KatanaLedger;
beforeAll(async () => {
  katana = (await import(pathToFileURL(KATANA_LEDGER).href)) as KatanaLedger;
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'manhunter-parity-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function issueEyes(cause: string, issue: string): string[] {
  const path = join(tmp, `q-${cause}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: 2,
      entries: [
        {
          test: 't',
          file: 'tests/t.py',
          kind: 'skipped',
          marker: 'skip',
          commit: 'c',
          author: 'Ada',
          date: '2026-09-01',
          reason: 'r',
          cause,
          issue,
          expiry: '',
        },
      ],
    }),
  );
  const s = ledgerSection(path, '2026-09-28T00:00:00Z');
  expect(s.status).toBe('fed');
  return s.eyes.filter((e) => e.includes('no linked issue'));
}

describe('manhunter mirrors katana CAUSES_REQUIRING_ISSUE (#1330)', () => {
  it('has a real denominator: katana names at least five causes', () => {
    expect(katana.CAUSES.length).toBeGreaterThanOrEqual(5);
    for (const c of katana.CAUSES_REQUIRING_ISSUE) {
      expect(katana.CAUSES).toContain(c);
    }
  });

  it('flags an issueless row iff katana requires an issue for its cause', () => {
    const mismatches = katana.CAUSES.filter((cause) => {
      const flagged = issueEyes(cause, '').length > 0;
      return flagged !== katana.CAUSES_REQUIRING_ISSUE.includes(cause);
    });
    expect(mismatches).toEqual([]);
  });

  it('never flags a linked row, whatever its cause', () => {
    const flagged = katana.CAUSES.filter(
      (cause) => issueEyes(cause, 'acme/widgets#1').length > 0,
    );
    expect(flagged).toEqual([]);
  });
});
