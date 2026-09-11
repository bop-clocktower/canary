/**
 * Contract tests for `scripts/docs-ratchet.mjs` (#865).
 *
 * `harness check-docs --min-coverage 3` was an ABSOLUTE floor set at the day's
 * measurement, and main sat on it: 5/199 = 2.51% printed as 3.0% and passed.
 * #864 added two undocumented source files (5/201 = 2.49%) and failed a PR
 * that did nothing wrong except add code. The floor taxed new files instead of
 * catching regressions.
 *
 * The ratchet compares documented-file IDENTITIES against the merge base, the
 * shape the perf ratchet moved to in #853: a PR fails only when a file that was
 * documented at the base is still present and no longer documented. Adding an
 * undocumented file is free; deleting a documented one is free. A report that
 * cannot be read, or that measured nothing, is an abstention (exit 3).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'docs-ratchet.mjs');

/** The shape `harness check-docs --json` prints, verified against CLI 12. */
function report(documented: string[], undocumented: string[]): string {
  const total = documented.length + undocumented.length;
  const pct = total === 0 ? 0 : Math.round((documented.length / total) * 100);
  return JSON.stringify(
    { valid: true, coveragePercent: pct, documented, undocumented },
    null,
    2,
  );
}

describe('docs-ratchet', () => {
  let dir: string;
  let head: string;
  let base: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'docs-ratchet-'));
    head = join(dir, 'head.json');
    base = join(dir, 'base.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(extra: string[] = []): { status: number; out: string } {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--report', head, ...extra],
      {
        encoding: 'utf8',
      },
    );
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  const withBase = (): string[] => ['--base-report', base];

  it('passes when a PR only adds undocumented files (the #864 case)', () => {
    writeFileSync(base, report(['a.ts', 'b.ts'], ['c.ts']));
    writeFileSync(head, report(['a.ts', 'b.ts'], ['c.ts', 'd.ts', 'e.ts']));
    const r = run(withBase());
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/2\/5 documented/);
  });

  it('fails when a file documented at the base loses its doc link', () => {
    writeFileSync(base, report(['a.ts', 'b.ts'], ['c.ts']));
    writeFileSync(head, report(['a.ts'], ['b.ts', 'c.ts']));
    const r = run(withBase());
    expect(r.status).toBe(1);
    expect(r.out).toContain('b.ts');
  });

  it('explains that only markdown links count, since nothing else says so', () => {
    writeFileSync(base, report(['a.ts', 'b.ts'], []));
    writeFileSync(head, report(['a.ts'], ['b.ts']));
    expect(run(withBase()).out).toMatch(/\[\.\.\]\(path\)/);
  });

  it('does not count a deleted or renamed documented file as a loss', () => {
    writeFileSync(base, report(['a.ts', 'gone.ts'], []));
    writeFileSync(head, report(['a.ts'], ['renamed.ts']));
    expect(run(withBase()).status).toBe(0);
  });

  it('reports without gating when there is no merge base (push to main)', () => {
    writeFileSync(head, report(['a.ts'], ['b.ts']));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/no merge base/i);
  });

  it('tolerates a banner before the JSON body', () => {
    writeFileSync(base, report(['a.ts'], []));
    writeFileSync(head, `npm warn something\n${report(['a.ts'], ['b.ts'])}`);
    expect(run(withBase()).status).toBe(0);
  });

  describe('abstains (exit 3) rather than passing on nothing', () => {
    it('on an empty head report', () => {
      writeFileSync(head, '');
      expect(run().status).toBe(3);
    });

    it('on a missing report file', () => {
      expect(run().status).toBe(3);
    });

    it('on a base report that cannot be parsed', () => {
      writeFileSync(head, report(['a.ts'], []));
      writeFileSync(base, 'x Documentation check crashed');
      expect(run(withBase()).status).toBe(3);
    });

    it('on a head that measured zero files', () => {
      writeFileSync(head, report([], []));
      expect(run().status).toBe(3);
    });

    it('on a base with no documented files at all', () => {
      // This repo has carried documented files since #718. A base reading zero
      // means the instrument stopped seeing links, and with an empty base
      // every loss is invisible, so the delta rule would be green over nothing.
      writeFileSync(base, report([], ['a.ts']));
      writeFileSync(head, report([], ['a.ts']));
      expect(run(withBase()).status).toBe(3);
    });

    it('on a head that suddenly documents nothing', () => {
      writeFileSync(base, report(['a.ts', 'b.ts'], []));
      writeFileSync(head, report([], ['a.ts', 'b.ts']));
      expect(run(withBase()).status).toBe(3);
    });
  });
});

describe('the docs merge-base ratchet is wired (#865)', () => {
  const WORKFLOW = join(
    REPO_ROOT,
    '.github',
    'workflows',
    'harness-quality.yml',
  );
  const yaml = (): string => readFileSync(WORKFLOW, 'utf8');

  it('no longer gates on an absolute --min-coverage floor above zero', () => {
    // Comments narrate the old `--min-coverage 3` floor; only commands count.
    const code = yaml()
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    for (const m of code.matchAll(/--min-coverage\s+(\d+)/g)) {
      expect(Number(m[1])).toBe(0);
    }
  });

  it('measures head and base with the same floating pin, as JSON', () => {
    const scans = [
      ...yaml().matchAll(
        /npx --yes -p "\$HARNESS_CLI" harness check-docs --json/g,
      ),
    ];
    expect(scans.length).toBe(2);
  });

  it('puts the base worktree outside the checkout', () => {
    expect(yaml()).toMatch(
      /git worktree add --detach "\$RUNNER_TEMP\/docs-base"/,
    );
  });

  it('gates the base scan on pull_request and hands it to the ratchet', () => {
    expect(yaml()).toMatch(
      /Harness Docs Coverage \(merge base\)[\s\S]{0,200}?if:\s*github\.event_name == 'pull_request'/,
    );
    expect(yaml()).toMatch(/docs-ratchet\.mjs[\s\S]{0,200}?\$DOCS_BASE_FLAG/);
  });
});
