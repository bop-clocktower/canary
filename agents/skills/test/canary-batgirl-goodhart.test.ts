/**
 * The Goodhart invariant for canary-batgirl (#619, spec SC 3, 5, 6, 9).
 *
 * The objection the ideation recorded against this skill: score a team on
 * canary metrics and the cheapest way to raise the score is to add tests that
 * assert nothing, which manufactures the problem canary exists to detect. This
 * suite plants exactly that change and asserts the scorecard does not reward
 * it.
 *
 * The plant adds 200 assertion-free passing tests and 50 vacuous passing tests
 * in three new commits on main, recorded the way each producer records it:
 *
 *   history    three green runs on new commits, total and passed up by 250
 *   cassandra  tests_checked up by 250, and 50 new VAC-001 findings (the 200
 *              zero-assertion tests are not cassandra findings: LINT-006)
 *   guardian   a record for the test-only PR: test support is suppressed, so
 *              it judged nothing (checked 0, abstained)
 *   batwoman   that PR's closure: test files have no probe, so every file is
 *              no-probe
 *   ledger     unchanged (nothing switched off)
 *   escapes    unchanged (tests are not defects)
 *
 * No dimension may improve, and none may change status. The second half pins
 * the abuse cases: no author reaches any output, and hostile text in a path or
 * a ledger value cannot add a line, a terminal escape or a link.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../claude-code/canary-batgirl/scripts/cli.mjs';

const SCRIPTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'claude-code',
  'canary-batgirl',
  'scripts',
);

const dirs: string[] = [];
let cwd = '';
afterEach(() => {
  vi.restoreAllMocks();
  if (cwd) process.chdir(cwd);
  cwd = '';
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function enter(dir: string) {
  if (!cwd) cwd = process.cwd();
  process.chdir(dir);
}

function workspace(): string {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'batgirl-goodhart-')),
  );
  dirs.push(d);
  return d;
}

function put(root: string, rel: string, body: unknown) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(
    f,
    typeof body === 'string' ? body : JSON.stringify(body, null, 2),
  );
}

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...a: unknown[]) => void out.push(a.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void err.push(a.join(' ')),
  );
  const code = main(argv);
  vi.restoreAllMocks();
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const AUTHOR = 'Synthetic Author Zed';

const historyRun = (sha: string, total: number, failed: number) =>
  JSON.stringify({
    schema_version: 3,
    run_id: `run-${sha}`,
    suite: 'unit',
    repo: 'example/repo',
    branch: 'main',
    commit_sha: sha,
    commit_message: `change by ${AUTHOR}`,
    total,
    passed: total - failed,
    failed,
    flaky: 0,
    skipped: 0,
  });

const vac = (i: number) => ({
  file: `test/padded-${Math.floor(i / 10)}.test.ts`,
  line: i,
  rule_id: 'VAC-001',
  severity: 'critical',
  snippet: `padded vacuous test ${i}`,
});

const guardian = (ref: string, over: Record<string, unknown>) => ({
  schemaVersion: '1.2',
  source: 'canary-pr-guardian',
  ref,
  checked: 6,
  abstained: false,
  coverage: { status: 'partial', unitsMatched: 4, unitsTotal: 6 },
  summary: { total: 0, byFidelity: {} },
  findings: [],
  ...over,
});

const closure = (issue: number, statuses: string[]) => ({
  issue,
  repo: 'example/repo',
  files: statuses.map((status, i) => ({ file: `f${i}`, status })),
  summary: { changed: statuses.length },
});

/** Every input present; a team with real, middling numbers. */
function baseline(root: string) {
  put(root, '.canary/escapes.json', {
    schema_version: 1,
    tracked_since: '2026-07-01',
    escapes: [{ id: 'E1', summary: 's', found_at: '2026-08-01' }],
    caught: [
      { id: 'C1', summary: 's', found_at: '2026-08-02' },
      { id: 'C2', summary: 's', found_at: '2026-08-03' },
    ],
  });
  put(
    root,
    '.harness/analyses/canary-pr-guardian-pr-10.json',
    guardian('pr-10', {}),
  );
  put(
    root,
    'audits/closure-10.json',
    closure(10, ['exercised', 'not-exercised']),
  );
  put(root, '.canary/quarantine.json', {
    schema_version: 2,
    entries: [
      { test: 'a', file: 'x', cause: '', author: AUTHOR },
      { test: 'b', file: 'x', cause: 'flaky', author: AUTHOR },
    ],
  });
  put(root, 'cassandra.json', {
    schema_version: 1,
    findings: [vac(1000), vac(1001)],
    summary: { tests_checked: 120, abstained: false },
  });
  put(
    root,
    'test-results/reports/history-v2.jsonl',
    [historyRun('c1', 120, 0), historyRun('c2', 120, 2)].join('\n') + '\n',
  );
}

/** The planted change: 200 assertion-free and 50 vacuous passing tests. */
function plant(root: string) {
  const history = path.join(root, 'test-results/reports/history-v2.jsonl');
  fs.appendFileSync(
    history,
    [
      historyRun('p1', 220, 0),
      historyRun('p2', 300, 0),
      historyRun('p3', 370, 0),
    ].join('\n') + '\n',
  );
  const cass = JSON.parse(
    fs.readFileSync(path.join(root, 'cassandra.json'), 'utf8'),
  );
  cass.findings.push(...Array.from({ length: 50 }, (_, i) => vac(i)));
  cass.summary.tests_checked += 250;
  put(root, 'cassandra.json', cass);
  put(
    root,
    '.harness/analyses/canary-pr-guardian-pr-11.json',
    guardian('pr-11', { checked: 0, abstained: true, coverage: null }),
  );
  put(
    root,
    'audits/closure-11.json',
    closure(11, ['no-probe', 'no-probe', 'no-probe']),
  );
}

const ARGS = [
  '--batwoman',
  'audits',
  '--cassandra',
  'cassandra.json',
  '--json',
];

function score(root: string) {
  enter(root);
  const r = run(ARGS);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout).dimensions as Array<{
    id: string;
    status: string;
    value: number | null;
    better: 'lower' | 'higher';
  }>;
}

describe('the Goodhart invariant', () => {
  it('assesses every dimension in the baseline (a vacuous invariant is no invariant)', () => {
    const root = workspace();
    baseline(root);
    for (const d of score(root)) expect(d.status).toBe('assessed');
  });

  it('no dimension improves when 200 assertion-free and 50 vacuous passing tests are added', () => {
    const root = workspace();
    baseline(root);
    const before = score(root);
    plant(root);
    const after = score(root);
    for (const b of before) {
      const a = after.find((d) => d.id === b.id)!;
      expect(a.status, b.id).toBe(b.status);
      const improved =
        b.better === 'lower' ? a.value! < b.value! : a.value! > b.value!;
      expect(improved, `${b.id}: ${b.value} -> ${a.value}`).toBe(false);
    }
    // The vacuous half of the plant is visible, not just tolerated.
    const vacAfter = after.find((d) => d.id === 'vacuous-tests')!;
    expect(vacAfter.value).toBe(52);
  });
});

describe('abuse', () => {
  it('no output carries an author, and no JSON key names one', () => {
    const root = workspace();
    baseline(root);
    enter(root);
    for (const argv of [ARGS, ARGS.filter((a) => a !== '--json')]) {
      const r = run(argv);
      expect(r.stdout + r.stderr).not.toContain(AUTHOR);
    }
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, inner] of Object.entries(v)) {
          keys.push(k);
          walk(inner);
        }
      }
    };
    walk(JSON.parse(run(ARGS).stdout));
    for (const k of keys) {
      expect(k).not.toMatch(/author|rank|streak|badge|leader/i);
    }
  });

  it('hostile text in a path cannot add a line, an escape sequence or a link', () => {
    const root = workspace();
    const hostile = 'x\u001b[31m\n# Owned | https://evil.example @x.y';
    // `://` makes the path nest: that is fine, every segment is hostile text.
    fs.mkdirSync(path.join(root, hostile), { recursive: true });
    put(root, path.join(hostile, 'bad.json'), '{not json');
    enter(root);
    const md = run(['--cassandra', path.join(hostile, 'bad.json')]);
    expect(md.code).toBe(3);
    expect(md.stdout).not.toContain('\u001b');
    expect(md.stdout).not.toMatch(/^# Owned/m);
    expect(md.stdout).not.toContain('://');
    expect(md.stdout).not.toMatch(/[^\\]\| https/);
    const json = run(['--cassandra', path.join(hostile, 'bad.json'), '--json']);
    expect(json.stdout).not.toMatch(/\\u001b|\\n# Owned/);
    const missing = run(['--ledger', path.join(hostile, 'none.json')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).not.toContain('\u001b');
    expect(missing.stderr.split('\n')).toHaveLength(1);
  });

  it('a malformed input never echoes its bytes into any output', () => {
    const root = workspace();
    put(root, '.canary/quarantine.json', '{"entries": [PLANTED-BYTES-42');
    put(
      root,
      'test-results/reports/history-v2.jsonl',
      'PLANTED-BYTES-43 not json\n',
    );
    enter(root);
    for (const argv of [[], ['--json']]) {
      const r = run(argv);
      expect(r.stdout + r.stderr).not.toContain('PLANTED');
    }
  });

  it('builds no regular expression from input text', () => {
    for (const name of fs.readdirSync(SCRIPTS)) {
      const src = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
      expect(src, name).not.toMatch(/new RegExp|RegExp\(/);
    }
  });
});
