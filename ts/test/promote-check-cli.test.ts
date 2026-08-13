/**
 * `canary promote-check` — the CLI surface of the promotion gate (#477).
 *
 * This one IS a gate, unlike `vacuity-check`, and the asymmetry is the point.
 * `vacuity-check` scans a repository, where a finding is a backlog item.
 * `promote-check` judges ONE generated draft on its way into the committed
 * suite, where a blocking finding is a reason not to import it. Nothing existing
 * turns red either way: the command is new and only ever aimed at
 * `tests/generated/`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_ABSTAINED } from '../src/core/gate-result.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

const HEAD = [
  `import { it, expect } from 'vitest';`,
  `import { save } from './store.js';`,
].join('\n');

function withFile(
  content: string,
  name = 'gen.test.ts',
): { dir: string; path: string } {
  const dir = mkTmp();
  const gen = join(dir, 'tests', 'generated');
  mkdirSync(gen, { recursive: true });
  const path = join(gen, name);
  writeFileSync(path, content, 'utf-8');
  return { dir, path };
}

describe('canary promote-check', () => {
  it('exits 0 and says PROMOTE for a clean draft', async () => {
    const { dir, path } = withFile(
      `${HEAD}\nit('saves the row', () => {\n  expect(save({ id: 7 })).toBe(7);\n});\n`,
    );
    try {
      const res = await invokeCanary(['promote-check', path]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('PROMOTE');
    } finally {
      rmTmp(dir);
    }
  });

  it('exits 1 and says BLOCK on a gating finding', async () => {
    const { dir, path } = withFile(
      `${HEAD}\nit('saves', () => {\n  expect(save({}).id).toBe(crypto.randomUUID());\n});\n`,
    );
    try {
      const res = await invokeCanary(['promote-check', path]);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('BLOCK');
      expect(res.stdout).toContain('SOUND-001');
      // The remedy must say what to do, not merely that something is wrong.
      expect(res.stdout).toMatch(/regenerate|Fix the test/);
    } finally {
      rmTmp(dir);
    }
  });

  it('labels an advisory finding as advisory and still promotes', async () => {
    const { dir, path } = withFile(
      `${HEAD}\nit('saves', () => {\n  page.locator('.btn');\n  expect(save({})).toBe(1);\n});\n`,
    );
    try {
      const res = await invokeCanary(['promote-check', path]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('ADVISORY');
      expect(res.stdout).toContain('PROMOTE');
    } finally {
      rmTmp(dir);
    }
  });

  it('exits 3 and says ABSTAIN when there is no verdict to give', async () => {
    const { dir, path } = withFile('export const fixture = 1;\n');
    try {
      const res = await invokeCanary(['promote-check', path]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).toContain('ABSTAIN');
      // Not silently looser: the reader is told promotion was NOT approved.
      expect(res.stdout).toMatch(/NOT been approved/);
    } finally {
      rmTmp(dir);
    }
  });

  it('exits 3 on a file no ruleset can parse', async () => {
    const { dir, path } = withFile('# notes\n', 'notes.md');
    try {
      const res = await invokeCanary(['promote-check', path]);
      expect(res.code).toBe(EXIT_ABSTAINED);
      expect(res.stdout).toContain('ABSTAIN');
    } finally {
      rmTmp(dir);
    }
  });

  it('emits the whole verdict as JSON, axes included', async () => {
    const { dir, path } = withFile(
      `${HEAD}\nit('saves', () => {\n  expect(save({}).id).toBe(crypto.randomUUID());\n});\n`,
    );
    try {
      const res = await invokeCanary(['promote-check', path, '--json']);
      expect(res.code).toBe(1);
      const v = JSON.parse(res.stdout);
      expect(v.decision).toBe('block');
      expect(v.source).toBe('deterministic');
      expect(v.checked).toBe(1);
      expect(v.blocked).toContain('SOUND-001');
      // Every axis, not only the failing one — a payload listing failures alone
      // cannot be told apart from one where only a single check ran.
      expect(v.axes).toHaveLength(6);
    } finally {
      rmTmp(dir);
    }
  });

  it('keeps the JSON parseable when it abstains', async () => {
    const { dir, path } = withFile('export const fixture = 1;\n');
    try {
      const res = await invokeCanary(['promote-check', path, '--json']);
      expect(res.code).toBe(EXIT_ABSTAINED);
      const v = JSON.parse(res.stdout);
      expect(v.decision).toBe('abstain');
      expect(v.checked).toBe(0);
    } finally {
      rmTmp(dir);
    }
  });
});
