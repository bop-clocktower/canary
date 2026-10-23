// canary-unquarantine, the producer side (#1455): `migrate` turns markers that
// have no ledger row (tag-style `@known-failure`, bare skips) into rows with
// no loss of ticket links, and `quarantine` writes a marker and its row
// together. Both are offline: no tracker is asked anything.

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../claude-code/canary-unquarantine/scripts/cli.mjs';
import { planMigration } from '../claude-code/canary-unquarantine/scripts/produce.mjs';
import { planQuarantine } from '../claude-code/canary-unquarantine/scripts/lift.mjs';

const tmps: string[] = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'unq-produce-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** A runner that records calls and answers nothing: these commands must not need it. */
function silentRunner() {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return {
      status: 1,
      stdout: '',
      stderr: 'no network in this test',
      error: '',
    };
  };
  return { run, calls };
}

function callMain(argv: string[], run = silentRunner().run) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...a: unknown[]) => void out.push(a.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void err.push(a.join(' ')),
  );
  const code = main(argv, { run, env: {} });
  vi.restoreAllMocks();
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** A tag-quarantine suite with no ledger at all: the shape the migration exists for. */
const TAGGED = `import { test, expect } from '@playwright/test';

test.describe('refunds', () => {
  // Known failure: https://acme.atlassian.net/browse/CORE-202
  test('a refund posts a credit @known-failure', async ({ request }) => {
    expect((await request.post('/refunds')).status()).toBe(200);
  });

  // Known failure, tracked in https://github.com/acme/suite/issues/41
  // and upstream as https://acme.atlassian.net/browse/UP-9
  test('a refund is idempotent @known-failure', async ({ request }) => {
    expect((await request.post('/refunds')).status()).toBe(200);
  });

  test('a partial refund keeps the rest @known-failure', async () => {});

  // Blocked by #12
  test.skip('a refund to a closed card fails cleanly', async () => {});

  test('a refund is listed', async ({ request }) => {
    expect((await request.get('/refunds')).status()).toBe(200);
  });
});
`;

const LINKS = [
  'https://acme.atlassian.net/browse/CORE-202',
  'https://github.com/acme/suite/issues/41',
  'https://acme.atlassian.net/browse/UP-9',
  '#12',
];

function taggedSuite() {
  const repo = mkTmp();
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'tests', 'refunds.spec.ts'), TAGGED);
  return repo;
}

const ledgerOf = (repo: string) =>
  JSON.parse(
    fs.readFileSync(path.join(repo, '.canary', 'quarantine.json'), 'utf8'),
  );

describe('migrate', () => {
  it('dry run: shows the rows, writes nothing, asks no tracker', () => {
    const repo = taggedSuite();
    const runner = silentRunner();
    const r = callMain(['migrate', '--repo', repo, '--json'], runner.run);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({
      checked: 4,
      linked: 3,
      written: false,
      scanned_files: 1,
    });
    expect(fs.existsSync(path.join(repo, '.canary', 'quarantine.json'))).toBe(
      false,
    );
    expect(runner.calls).toEqual([]);
  });

  it('--yes writes one row per marker and loses no ticket link', () => {
    const repo = taggedSuite();
    const r = callMain(['migrate', '--repo', repo, '--yes']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /^Migrated 4 unledgered marker\(s\) into .*: 3 with a ticket link, 1 unlinked\./,
    );
    const rows = ledgerOf(repo).entries;
    // katana's appendEntries stores a batch sorted by (file, test).
    expect(rows.map((e: any) => [e.test, e.marker, e.issue])).toEqual([
      ['a partial refund keeps the rest', '@known-failure', ''],
      [
        'a refund is idempotent',
        '@known-failure',
        'https://github.com/acme/suite/issues/41',
      ],
      [
        'a refund posts a credit',
        '@known-failure',
        'https://acme.atlassian.net/browse/CORE-202',
      ],
      ['a refund to a closed card fails cleanly', 'test.skip', '#12'],
    ]);
    // No loss: every reference in the source is in some row, verbatim.
    const text = JSON.stringify(rows);
    for (const link of LINKS) expect(text).toContain(link);
  });

  it('after migration the audit finds every row in place and nothing unledgered', () => {
    const repo = taggedSuite();
    callMain(['migrate', '--repo', repo, '--yes']);
    const doc = JSON.parse(
      callMain([
        'audit',
        '--repo',
        repo,
        '--json',
        '--github-repo',
        'acme/suite',
      ]).stdout,
    );
    expect(doc.unledgered).toEqual([]);
    expect(doc.counts.stale).toBe(0);
    expect(doc.counts.unlinked).toBe(1); // the one marker that named no ticket, now visible
    expect(doc.checked).toBe(4);
  });

  it('a second run migrates nothing (no duplicate rows)', () => {
    const repo = taggedSuite();
    callMain(['migrate', '--repo', repo, '--yes']);
    const r = callMain(['migrate', '--repo', repo, '--yes']);
    expect(r.stdout).toMatch(
      /Nothing to migrate: 1 test file\(s\) read and every marker already has a row/,
    );
    expect(ledgerOf(repo).entries).toHaveLength(4);
  });

  it('a suite with no test files abstains rather than reporting nothing to migrate', () => {
    const r = callMain(['migrate', '--repo', mkTmp(), '--strict']);
    expect(r.code).toBe(3);
    expect(r.stdout).toMatch(/Abstained .* no test files were read/);
  });

  it('planMigration keeps extra references in the reason', () => {
    const [row] = planMigration(
      [
        {
          test: 't @known-failure',
          file: 'a.spec.ts',
          marker: '@known-failure',
          links: ['#1', 'UP-2', 'https://x/y'],
        },
      ],
      { tags: ['@known-failure'], now: new Date('2026-10-22T00:00:00Z') },
    );
    expect(row).toMatchObject({
      test: 't',
      issue: '#1',
      date: '2026-10-22T00:00:00.000Z',
    });
    expect(row.reason).toBe(
      'migrated from an unledgered @known-failure marker; also UP-2, https://x/y',
    );
  });
});

// --- quarantine: marker and row together ---------------------------------------

const PLAIN = `import { test, expect } from '@playwright/test';

test.describe('points', () => {
  test('a sale earns points', async () => {
    expect(1).toBe(1);
  });
});
`;

function plainSuite() {
  const repo = mkTmp();
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'tests', 'points.spec.ts'), PLAIN);
  return repo;
}
const source = (repo: string, f = 'tests/points.spec.ts') =>
  fs.readFileSync(path.join(repo, f), 'utf8');

describe('quarantine', () => {
  const args = (repo: string, ...extra: string[]) => [
    'quarantine',
    '--repo',
    repo,
    '--file',
    'tests/points.spec.ts',
    '--test',
    'a sale earns points',
    ...extra,
  ];

  it('writes the skip, a comment naming the ticket, and a caused ledger row', () => {
    const repo = plainSuite();
    const r = callMain(
      args(repo, '--cause', 'product-defect', '--issue', '#7'),
    );
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(source(repo)).toContain(
      "  // Quarantined against #7 (product-defect) by canary-unquarantine\n  test.skip('a sale earns points', async () => {",
    );
    const [row] = ledgerOf(repo).entries;
    expect(row).toMatchObject({
      test: 'a sale earns points',
      kind: 'skipped',
      marker: 'test.skip',
      cause: 'product-defect',
      issue: '#7',
    });
  });

  it('the audit then reads it as a quarantine waiting on its ticket', () => {
    const repo = plainSuite();
    callMain(args(repo, '--cause', 'product-defect', '--issue', '#7'));
    const doc = JSON.parse(
      callMain([
        'audit',
        '--repo',
        repo,
        '--json',
        '--github-repo',
        'acme/suite',
      ]).stdout,
    );
    expect(doc.rows[0]).toMatchObject({
      class: 'abstain',
      source: 'issue',
      named: ['#7'],
    });
    expect(doc.unledgered).toEqual([]);
  });

  it('--as-tag quarantines by title tag, and records the title without it', () => {
    const repo = plainSuite();
    callMain(args(repo, '--cause', 'flaky', '--as-tag'));
    expect(source(repo)).toContain(
      "test('a sale earns points @known-failure', async () => {",
    );
    expect(ledgerOf(repo).entries[0]).toMatchObject({
      test: 'a sale earns points',
      marker: '@known-failure',
      cause: 'flaky',
    });
  });

  it('a describe becomes describe.skip, recorded the way katana records it', () => {
    const repo = plainSuite();
    const r = callMain([
      'quarantine',
      '--repo',
      repo,
      '--file',
      'tests/points.spec.ts',
      '--test',
      'points',
      '--cause',
      'obsolete',
    ]);
    expect(r.code).toBe(0);
    expect(source(repo)).toContain("test.describe.skip('points', () => {");
    expect(ledgerOf(repo).entries[0].marker).toBe('describe.skip');
  });

  it('a pytest test gets a skip decorator', () => {
    const repo = mkTmp();
    fs.mkdirSync(path.join(repo, 'tests'));
    fs.writeFileSync(
      path.join(repo, 'tests', 'test_points.py'),
      'def test_earns():\n    assert True\n',
    );
    const r = callMain([
      'quarantine',
      '--repo',
      repo,
      '--file',
      'tests/test_points.py',
      '--test',
      'test_earns',
      '--cause',
      'blocked-data',
      '--issue',
      'UP-3',
    ]);
    expect(r.code).toBe(0);
    expect(source(repo, 'tests/test_points.py')).toBe(
      '# Quarantined against UP-3 (blocked-data) by canary-unquarantine\n' +
        '@pytest.mark.skip(reason="Quarantined against UP-3 (blocked-data) by canary-unquarantine")\n' +
        'def test_earns():\n    assert True\n',
    );
  });

  it.each([
    [
      ['--cause', 'product-defect'],
      /a product-defect quarantine needs --issue/,
    ],
    [['--cause', 'broken'], /--cause must be one of flaky, product-defect/],
    [[], /--cause must be one of/],
  ])('refuses %j and touches nothing', (extra, message) => {
    const repo = plainSuite();
    const r = callMain(args(repo, ...(extra as string[])));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(message);
    expect(source(repo)).toBe(PLAIN);
    expect(fs.existsSync(path.join(repo, '.canary', 'quarantine.json'))).toBe(
      false,
    );
  });

  it('refuses a test that is not there, or is already switched off', () => {
    const repo = plainSuite();
    expect(
      callMain([
        'quarantine',
        '--repo',
        repo,
        '--file',
        'tests/points.spec.ts',
        '--test',
        'nope',
        '--cause',
        'flaky',
      ]).stderr,
    ).toMatch(/no test titled "nope"/);
    callMain(args(repo, '--cause', 'flaky'));
    const again = callMain(args(repo, '--cause', 'flaky'));
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already switched off/);
    expect(ledgerOf(repo).entries).toHaveLength(1);
  });

  it('a corrupt ledger is refused before the test file is touched', () => {
    const repo = plainSuite();
    fs.mkdirSync(path.join(repo, '.canary'));
    fs.writeFileSync(path.join(repo, '.canary', 'quarantine.json'), '{oops');
    const r = callMain(args(repo, '--cause', 'flaky'));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ledger is not valid JSON/);
    expect(source(repo)).toBe(PLAIN);
  });

  it('planQuarantine refuses a tag when the title is not on the declaration line', () => {
    const lines = ['test(', "  'split title',", '  async () => {});'];
    expect(
      planQuarantine(
        lines,
        { line: 1, title: 'split title', lang: 'js' },
        { note: 'n', tag: '@quarantine' },
      ),
    ).toMatchObject({
      why: expect.stringMatching(/not on the declaration line/),
    });
  });

  it('planQuarantine refuses a callee it cannot add .skip to', () => {
    const lines = ["test.describe.serial('t', () => {"];
    expect(
      planQuarantine(lines, { line: 1, title: 't', lang: 'js' }, { note: 'n' }),
    ).toMatchObject({
      why: expect.stringMatching(/not a plain test\/it\/describe call/),
    });
  });
});
