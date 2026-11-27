/**
 * The evidence pack renders text taken from ledgers, run history and saved
 * reports, and auditors and agents read it (#855). Every such value must come
 * out as inert text: no table break, no markup, no link, no terminal control.
 * Fixtures are synthetic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPack, exportPack } from '../src/analysis/evidence/pack.js';
import { renderMarkdown, writePack } from '../src/analysis/evidence/render.js';
import {
  CAUSES,
  readBatwoman,
  readLedger,
} from '../src/analysis/evidence/sources.js';
import type {
  CatalogueRow,
  EvidenceItem,
  Scope,
  SourceReport,
} from '../src/analysis/evidence/types.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const SHA = 'a'.repeat(40);
const AT = '2026-02-01T00:00:00.000Z';

const CATALOGUE: CatalogueRow[] = [
  {
    id: 'soc2-cc8.1',
    framework: 'SOC 2',
    reference: 'CC8.1, change management',
    supports: 'Removed tests were recorded',
    sources: ['katana'],
  },
];

const SCOPE: Scope = {
  since: '2026-01-01T00:00:00.000Z',
  until: '2026-06-15T12:00:00.000Z',
  root: '/repo',
  out: '/repo/out',
  at: '2026-06-15T12:00:00.000Z',
  commit: SHA,
};

function item(
  summary: string,
  ref: Partial<EvidenceItem['ref']>,
): EvidenceItem {
  return {
    source: 'katana',
    at: AT,
    summary,
    ref: { kind: 'ledger-entry', id: 'a.test.ts::adds', ...ref },
  };
}

function katana(items: EvidenceItem[], reason?: string): SourceReport {
  return {
    id: 'katana',
    path: '.canary/quarantine.json',
    state: reason === undefined ? 'read' : 'partial',
    ...(reason === undefined ? {} : { reason }),
    read: items.length,
    inWindow: items.length,
    undated: 0,
    items,
  };
}

function render(items: EvidenceItem[], reason?: string): string {
  return renderMarkdown(buildPack([katana(items, reason)], SCOPE, CATALOGUE));
}

const lineWith = (md: string, text: string): string =>
  md.split('\n').find((line) => line.includes(text)) ?? '';

describe('untrusted text in the Markdown pack', () => {
  it('keeps a trailing backslash and a pipe inside one table cell', () => {
    const row = lineWith(render([], 'tail\\|more|end\\'), 'katana (');
    expect(row).toContain('tail');
    // Five cells: six pipes, and no backslash left to un-escape one of them.
    expect(row.split('|')).toHaveLength(7);
    expect(row).not.toContain('\\');
  });

  it('keeps a newline followed by a heading on the row it came from', () => {
    const md = render([], 'ok\n# Owned\n\n## Also owned');
    const headings = md.split('\n').filter((line) => /^#+ /.test(line));
    expect(headings.join(' ')).not.toContain('wned');
    expect(lineWith(md, 'katana (')).toContain('Owned');
  });

  it('renders an HTML tag and an entity as text', () => {
    const md = render([item('<img src=x onerror=alert(1)> &lt;b&gt;', {})]);
    expect(md).not.toContain('<img');
    expect(md).not.toContain('&lt;b');
    expect(lineWith(md, 'onerror')).toContain('&#60;img');
  });

  it('renders Markdown link, image and emphasis syntax as text', () => {
    const md = render([
      item('[click](https://evil.example) ![i](x) *b* _c_', {}),
    ]);
    expect(md).not.toContain('[click]');
    expect(md).not.toContain('![');
    expect(md).not.toContain('*b*');
    expect(md).not.toContain('_c_');
  });

  it('leaves no bare URL, www host or e-mail address for a viewer to autolink', () => {
    const md = render([
      item('see https://evil.example www.evil.example a@b.example', {}),
    ]);
    expect(md).not.toContain('://evil');
    expect(md).not.toContain('www.evil');
    expect(md).not.toContain('a@b');
  });

  it('keeps a backtick in a ledger id or a commit inside its code span', () => {
    const md = render([
      item('skipped', { id: 'a.test.ts::adds `x` [y](z)', commit: '`rm`' }),
    ]);
    const line = lineWith(md, 'skipped');
    // Two code spans, so exactly four backticks.
    expect(line.split('`')).toHaveLength(5);
    expect(line).toContain("`a.test.ts::adds 'x' [y](z)`");
  });

  it.each([
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a non-GitHub URL', `https://evil.example/acme/widgets/commit/${SHA}`],
    [
      'a GitHub URL with a trailing path',
      `https://github.com/acme/widgets/commit/${SHA}/../x`,
    ],
    [
      'a GitHub URL that closes the link',
      `https://github.com/acme/widgets/commit/${SHA}) [x](y`,
    ],
  ])('renders no link for %s', (_name, url) => {
    const md = render([item('skipped', { commit: SHA, url })]);
    expect(md).not.toContain('](');
    expect(md).not.toContain('javascript');
    expect(md).not.toContain('evil.example');
  });

  it('still links the exact GitHub commit URL', () => {
    const url = `https://github.com/acme/widgets/commit/${SHA}`;
    const md = render([item('skipped', { commit: SHA, url })]);
    expect(md).toContain(`([commit](${url}))`);
  });
});

describe('header values are checked at the boundary', () => {
  it.each([
    ['since', { since: '2026-01-01\n# Owned' }],
    ['until', { until: 'tomorrow' }],
    ['the export time', { at: '2026-06-15 12:00' }],
    ['the commit', { commit: `${SHA}\n# Owned` }],
    ['a commit that is not hex', { commit: 'main; rm -rf' }],
  ])('buildPack refuses a malformed %s', (_name, patch) => {
    const scope = { ...SCOPE, ...patch };
    expect(() => buildPack([], scope, CATALOGUE)).toThrow(/evidence:/);
  });

  it('buildPack refuses an item whose time is not an ISO instant', () => {
    const odd = { ...item('skipped', {}), at: '2026-02-01\n# Owned' };
    expect(() => buildPack([katana([odd])], SCOPE, CATALOGUE)).toThrow(
      /evidence:/,
    );
  });

  it('exportPack exits 2 on a malformed commit and writes nothing', () => {
    const root = mkTmp();
    try {
      const scope = { ...SCOPE, root, out: join(root, 'out'), commit: 'zz zz' };
      const done = exportPack(scope, () => {
        throw new Error('the scorer must not run');
      });
      expect(done.exit).toBe(2);
      expect(done.lines.join('\n')).toContain('commit');
    } finally {
      rmTmp(root);
    }
  });
});

describe('untrusted text on stdout', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => rmTmp(root));

  it('prints one inert line per source for a reason with a newline and an ANSI escape', () => {
    const reason =
      'line 2\nsource history: read\u001B[31m red \u001B]0;title\u0007\r!';
    const pack = buildPack([katana([], reason)], SCOPE, CATALOGUE);
    const done = writePack(join(root, 'out'), pack);
    expect(done.exit).toBe(0);
    for (const line of done.lines) {
      // eslint-style control check without a regex literal of control chars.
      const codes = [...line].map((ch) => ch.charCodeAt(0));
      expect(codes.every((c) => c >= 32 && (c < 127 || c > 159))).toBe(true);
    }
    const sources = done.lines.filter((line) => line.startsWith('source '));
    expect(sources).toHaveLength(1);
    expect(sources[0]).toContain('red');
    expect(sources[0]).not.toContain('[31m');
  });

  it('clamps a very long reason', () => {
    const pack = buildPack([katana([], 'x'.repeat(5000))], SCOPE, CATALOGUE);
    const done = writePack(join(root, 'out'), pack);
    const [line] = done.lines.filter((l) => l.startsWith('source '));
    expect(line?.length).toBeLessThan(500);
  });
});

describe('repository identity comes from the caller, never from a data file', () => {
  let root: string;
  const scope = (): Scope => ({ ...SCOPE, root, out: join(root, 'out') });

  function saveReport(repo: string | undefined): void {
    const file = join(root, '.canary', 'batwoman', '12.json');
    mkdirSync(dirname(file), { recursive: true });
    const report = {
      issue: 12,
      pullRequest: 34,
      ...(repo === undefined ? {} : { repo }),
      mergeSha: SHA,
      mergedAt: '2026-03-01T00:00:00Z',
      files: [{ file: 'a.yml', status: 'exercised' }],
    };
    writeFileSync(file, JSON.stringify(report));
  }

  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => rmTmp(root));

  it('links a report that names the repository the caller gave', () => {
    saveReport('acme/widgets');
    const [got] = readBatwoman({ ...scope(), repo: 'acme/widgets' }).items;
    expect(got?.ref.url).toBe(`https://github.com/acme/widgets/commit/${SHA}`);
    expect(got?.summary).not.toContain('unverified');
  });

  it('does not link a report that names a different repository, and says so', () => {
    saveReport('evil/widgets');
    const [got] = readBatwoman({ ...scope(), repo: 'acme/widgets' }).items;
    expect(got?.ref.url).toBeUndefined();
    expect(got?.summary).toContain('unverified');
    expect(got?.summary).toContain('evil/widgets');
  });

  it('builds no URL from the report alone when the caller gave no repository', () => {
    saveReport('acme/widgets');
    const [got] = readBatwoman(scope()).items;
    expect(got?.ref.url).toBeUndefined();
  });
});

describe('ledger cause', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => rmTmp(root));

  function summaryFor(cause: string): string {
    const file = join(root, '.canary', 'quarantine.json');
    mkdirSync(dirname(file), { recursive: true });
    const row = {
      test: 'adds',
      file: 'a.test.ts',
      kind: 'skipped',
      commit: SHA,
      author: 'Sam Example',
      date: '2026-03-01T00:00:00Z',
      reason: 'skip the adder test',
      cause,
    };
    writeFileSync(file, JSON.stringify({ schema_version: 2, entries: [row] }));
    return readLedger({ ...SCOPE, root }).items[0]?.summary ?? '';
  }

  it('prints a cause katana knows', () => {
    expect(summaryFor('flaky')).toContain(': flaky');
  });

  it('does not print a cause katana does not know', () => {
    const summary = summaryFor('[click](https://evil.example)');
    expect(summary).toContain('unrecognised cause');
    expect(summary).not.toContain('evil');
  });

  it('mirrors the cause list canary-katana ships', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const ledger = join(
      here,
      '..',
      '..',
      'agents',
      'skills',
      'claude-code',
      'canary-katana',
      'scripts',
      'ledger.mjs',
    );
    const katanaLedger = (await import(pathToFileURL(ledger).href)) as {
      CAUSES: string[];
    };
    expect([...CAUSES].sort()).toEqual([...katanaLedger.CAUSES].sort());
  });
});
