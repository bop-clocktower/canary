/**
 * Contract tests for `scripts/check_doc_links.mjs` (#686).
 *
 * Why this script exists at all: the dead-link capability it provides is
 * already *supposed* to come from harness's `checkStructureDrift`, and on this
 * repo that detector emits 27 findings of which zero are drift. Two defects,
 * both in `@harness-engineering/core` and neither ours to patch:
 *
 * 1. **No fence awareness.** `extractFileLinks` scans raw file content, so a
 *    link quoted inside a ```markdown fence — the shape every plan doc in
 *    `docs/changes/` uses to show the file it creates — is resolved relative
 *    to the *plan* instead of the file being quoted. 24 of the 27.
 *
 * 2. **`slugifyHeading` trims before hyphenating.** `## 📖 Usage` slugs to
 *    `usage`, where GitHub strips the emoji and turns the orphaned leading
 *    space into a hyphen: `#-usage`. The three links to it in
 *    `agents/skills/README.md` work in a browser and are reported broken. 3
 *    of the 27.
 *
 * The upstream fix is filed. Until it ships, 27 is a floor (ADR 0012), and a
 * floor that size means finding #28 — a genuinely dead link — is invisible.
 * This script restores the signal locally by re-implementing the same check
 * *correctly*, on the same denominator, with no allowlist.
 *
 * The denominator is the property under test as much as the detection is. The
 * one lever harness offers for muting the noise is `entropy.drift.docPaths`,
 * an **allowlist** — narrowing it to drop `docs/changes/` would also drop
 * every doc directory nobody remembered to name. `docs/changes/` is precisely
 * where #676 found 26 genuinely dead links, so that trade is not available.
 * This script therefore takes no path allowlist, and abstains (exit 3) rather
 * than passing when it scanned nothing.
 *
 * Exit codes follow the repo's gate convention (#508) and ADR 0009:
 *   0 = verified — every link resolves
 *   1 = findings — at least one dead link or missing anchor
 *   2 = error — the scan root is unreadable
 *   3 = ABSTENTION — zero Markdown files scanned, so nothing was measured
 *
 * Offline: every case builds its own fixture tree in a temp directory.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec, kitFor, parseContract, type Kit } from './doc-links-testkit';

let root: string;
let write: Kit['write'];
let run: Kit['run'];
let report: Kit['report'];
let findings: Kit['findings'];

describe('check_doc_links', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doc-links-'));
    ({ write, run, report, findings } = kitFor(root));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe('the two upstream defects this script exists to route around', () => {
    it('does not resolve links quoted inside a fenced block (Class A)', () => {
      // The exact shape of the 24: a plan quoting a README it creates. The
      // link is correct relative to the README, nonsense relative to the plan.
      write(
        'docs/changes/thing/plans/plan.md',
        [
          '# Plan',
          '',
          '````markdown',
          '# The README this creates',
          '',
          'See [Getting Started](../../../docs/wiki/Getting-Started.md).',
          '````',
          '',
        ].join('\n'),
      );

      expect(run().status).toBe(0);
      expect(findings()).toEqual([]);
    });

    it('still flags a dead link outside the fence in the same file', () => {
      // Fence awareness must not become a blanket amnesty for plan docs: the
      // 26 links #676 repaired were real, and several lived in these files.
      write(
        'docs/changes/thing/plans/plan.md',
        [
          '# Plan',
          '',
          'See [the spec](./nope.md).',
          '',
          '```markdown',
          'See [Getting Started](../../../docs/wiki/Getting-Started.md).',
          '```',
          '',
        ].join('\n'),
      );

      const found = findings();
      expect(found).toHaveLength(1);
      expect(found[0]?.target).toBe('./nope.md');
      expect(run().status).toBe(1);
    });

    it('closes a fence only on a fence at least as long as the opener', () => {
      // ````markdown wrapping ``` blocks is how a doc shows Markdown output
      // that itself contains code. A naive toggle re-opens on the inner fence
      // and exposes the second half of the quoted block.
      write(
        'docs/plans/plan.md',
        [
          '````markdown',
          '# Quoted file',
          '',
          '```bash',
          'echo hi',
          '```',
          '',
          'See [Getting Started](../../../docs/wiki/Getting-Started.md).',
          '````',
          '',
        ].join('\n'),
      );

      expect(findings()).toEqual([]);
    });

    it('matches GitHub on an emoji heading anchor (Class B)', () => {
      // `## 📖 Usage` -> GitHub drops the emoji and hyphenates the orphaned
      // leading space -> `#-usage`. Trimming first yields `usage` and reports
      // three working links as broken.
      write('README.md', '## 📖 Usage\n\ntext\n');
      write(
        'agents/skills/README.md',
        'See [Usage](../../README.md#-usage).\n',
      );

      expect(run().status).toBe(0);
      expect(findings()).toEqual([]);
    });

    it('still flags an anchor that really is absent', () => {
      write('README.md', '## 📖 Usage\n\ntext\n');
      write('docs/a.md', 'See [Install](../README.md#install).\n');

      const found = findings();
      expect(found).toHaveLength(1);
      expect(found[0]?.kind).toBe('anchor');
      expect(found[0]?.target).toBe('../README.md#install');
    });
  });

  describe('anchor slugging', () => {
    it('handles punctuation, casing, and duplicate headings like GitHub', () => {
      write(
        'docs/target.md',
        ['# Setup', '## Setup', "## What's New?", '## a b', ''].join('\n'),
      );
      write(
        'docs/a.md',
        [
          '[1](./target.md#setup)',
          '[2](./target.md#setup-1)',
          '[3](./target.md#whats-new)',
          '[4](./target.md#a-b)',
          '',
        ].join('\n'),
      );

      expect(findings()).toEqual([]);
    });

    it('does not check anchors on a non-Markdown target', () => {
      write('docs/thing.ts', 'export const x = 1;\n');
      write('docs/a.md', '[code](./thing.ts#L4)\n');

      expect(findings()).toEqual([]);
    });
  });

  describe('what counts as a link', () => {
    it('ignores external, mailto, and in-page-only links', () => {
      write(
        'docs/a.md',
        [
          '# Top',
          '[web](https://example.com/nope.md)',
          '[mail](mailto:nobody@example.com)',
          '[self](#top)',
          '',
        ].join('\n'),
      );

      expect(findings()).toEqual([]);
    });

    it('ignores a link inside an inline code span', () => {
      write('docs/a.md', 'Write `[text](./nope.md)` to link a file.\n');

      expect(findings()).toEqual([]);
    });

    it('resolves a directory target', () => {
      write('docs/sub/b.md', 'x\n');
      write('docs/a.md', '[dir](./sub)\n');

      expect(findings()).toEqual([]);
    });

    it('checks reference-style definitions, not just inline links', () => {
      // This repo carries 21 of them, and one was genuinely dead — a
      // `docs/adr/` target left behind by the move to
      // `docs/knowledge/decisions/`. Checking only `[text](path)` would have
      // let this class through while reporting a confident zero.
      write(
        'docs/a.md',
        ['See [the ADR][adr].', '', '[adr]: ../adr/1.md', ''].join('\n'),
      );

      const found = findings();
      expect(found).toHaveLength(1);
      expect(found[0]?.target).toBe('../adr/1.md');
      expect(found[0]?.line).toBe(3);
    });

    it('checks the anchor on a reference-style definition too', () => {
      write('docs/target.md', '## Setup\n');
      write('docs/a.md', '[t]: ./target.md#nope\n');

      const found = findings();
      expect(found).toHaveLength(1);
      expect(found[0]?.kind).toBe('anchor');
    });

    it('ignores a reference definition inside a fence', () => {
      write(
        'docs/a.md',
        ['```markdown', '[adr]: ../adr/1.md', '```', ''].join('\n'),
      );

      expect(findings()).toEqual([]);
    });
  });

  describe('the denominator', () => {
    it('abstains rather than passing when it scanned no Markdown', () => {
      // Silence and success must not look alike. An empty root means the
      // walker broke or the root moved, not that every link resolves.
      const { status, out } = run();
      expect(status).toBe(3);
      expect(out).toMatch(/ABSTAIN/i);
    });

    it('errors when the scan root does not exist', () => {
      expect(exec(['--root', join(root, 'missing')]).status).toBe(2);
    });

    it('excludes gitignored Markdown — those files are not this repo', () => {
      // Found on `main` immediately after #696 merged: the walker read
      // `.github/instructions/`, a gitignored editor-extension directory that
      // exists on one laptop and in no checkout, and reported two dead links
      // in it. Green in CI, red locally, for a file the repo does not own.
      //
      // This is #688 inverted. There, gitignored files were invisible to a
      // gate that should have seen them; here they are visible to one that
      // should not. Both are the same unanswered question — what is this
      // gate's denominator — failed in opposite directions.
      spawnSync('git', ['init', '-q'], { cwd: root });
      write('.gitignore', 'ignored/\n');
      write('ignored/local.md', '[dead](./nope.md)\n');
      write('real.md', '# Real\n');

      const r = report();
      expect(r.findings).toEqual([]);
      // And the file must not merely be un-flagged — it must be unscanned,
      // or a later dead link inside it would count toward the denominator.
      expect(r.filesScanned).toBe(1);
    });

    it('still scans everything when the root is not a git repository', () => {
      // No git means no ignore rules to consult, not an excuse to scan
      // nothing. Abstaining here would turn a tarball export into a silent
      // pass.
      write('a.md', '[dead](./nope.md)\n');
      expect(findings()).toHaveLength(1);
    });

    it('reports the file count it actually scanned', () => {
      write('docs/a.md', '# a\n');
      write('docs/b.md', '# b\n');
      expect(report().filesScanned).toBe(2);
    });

    it('takes no path allowlist — every doc directory is scanned', () => {
      // The regression this pins is `entropy.drift.docPaths`: an allowlist
      // that silently stops covering directories added after it was written.
      write('docs/knowledge/a.md', '[x](./nope.md)\n');
      write('docs/runbooks/b.md', '[x](./nope.md)\n');
      write('docs/changes/c.md', '[x](./nope.md)\n');
      write('a-directory-invented-later/d.md', '[x](./nope.md)\n');

      const dirs = findings().map((f) => f.file.split('/')[0]);
      expect(new Set(dirs)).toEqual(
        new Set(['docs', 'docs', 'docs', 'a-directory-invented-later']),
      );
      expect(findings()).toHaveLength(4);
    });

    it('skips build and dependency directories only', () => {
      write('node_modules/pkg/README.md', '[x](./nope.md)\n');
      write('ts/dist/doc.md', '[x](./nope.md)\n');
      write('docs/real.md', '[x](./nope.md)\n');

      const found = findings();
      expect(found).toHaveLength(1);
      expect(found[0]?.file).toBe('docs/real.md');
    });
  });

  describe('generator output', () => {
    // `harness generate-agent-definitions` writes 30 links to `references/*.md`
    // files it never emits. Those are not this repo's prose to repair, and
    // `docs-lint.yml` already excludes the same trees from markdownlint. The
    // exclusion keys off the generator's own stamp rather than a path list, so
    // it cannot go stale, and the findings are still counted and printed.
    const STAMP = '<!-- Generated by harness gen. Do not edit. -->';

    it('does not gate on a generator-stamped file', () => {
      write('agents/agents/x.md', `${STAMP}\n\n[x](./references/nope.md)\n`);
      write('docs/a.md', '# a\n');

      expect(run().status).toBe(0);
      expect(findings()).toEqual([]);
    });

    it('still counts and reports what it found there', () => {
      write('agents/agents/x.md', `${STAMP}\n\n[x](./references/nope.md)\n`);
      write('docs/a.md', '# a\n');

      const { out } = run(['--json']);
      const parsed = parseContract(out);
      expect(parsed.generatedFiles).toBe(1);
      expect(parsed.generatedFindings).toHaveLength(1);
      expect(out).toMatch(/generator-stamped/);
    });

    it('gates on the same path once the stamp is gone', () => {
      write('agents/agents/x.md', '[x](./references/nope.md)\n');

      expect(run().status).toBe(1);
      expect(findings()).toHaveLength(1);
    });
  });

  describe('the repository itself', () => {
    it('has no dead documentation links', () => {
      const parsed = parseContract(exec(['--json']).out);
      expect(parsed.filesScanned).toBeGreaterThan(0);
      expect(parsed.findings).toEqual([]);
    }, 60_000);
  });
});
