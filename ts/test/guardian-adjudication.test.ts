/**
 * Tests for finding adjudication collection (#490): reaction tallying,
 * comment-body attribution, the persisted record, precision aggregation with
 * the zero-denominator discipline, and the CLI surfaces (`pr-check` inline
 * collection, `collect-adjudications`, `precision`, `harden-gate` readiness).
 *
 * Network-free: every collection path runs against {@link FakeReactionsClient}
 * fixture payloads.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ADJUDICATION_SOURCE,
  AdjudicationRecord,
  FakeReactionsClient,
  Reaction,
  activeFindingPaths,
  adjudicationFilename,
  buildAdjudicationRecord,
  collectAdjudications,
  loadAdjudicationRecords,
  renderPrecision,
  summarizePrecision,
  tallyAdjudications,
} from '../src/guardian/adjudication.js';
import { GuardianFinding, renderFindings } from '../src/guardian/pr-check.js';
import { FakeGitHubClient, STICKY_MARKER } from '../src/guardian/pr-comment.js';
import { invokeGuardian, mkTmp, rmTmp } from './guardian-cli-testkit.js';

let tmp: string;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => rmTmp(tmp));

// --- fixtures -------------------------------------------------------------

const up = (user: string): Reaction => ({ user, content: '+1' });
const down = (user: string): Reaction => ({ user, content: '-1' });

function finding(
  path: string,
  init: Partial<GuardianFinding> = {},
): GuardianFinding {
  return new GuardianFinding({
    path,
    unit: path,
    evidence: 'no test references this file',
    ...init,
  });
}

/** A rendered sticky-comment body carrying the given active findings. */
function stickyBody(findings: GuardianFinding[]): string {
  return renderFindings(findings, 'comment', 0, null);
}

/** Analyses dir under an existing `.harness/` home (channel available). */
function mkAnalysesDir(): string {
  const dir = join(tmp, '.harness', 'analyses');
  mkdirSync(join(tmp, '.harness'), { recursive: true });
  return dir;
}

// --- tallyAdjudications -----------------------------------------------------

describe('tallyAdjudications', () => {
  it('counts thumbs-up as TP and thumbs-down as FP', () => {
    const tally = tallyAdjudications([up('alice'), up('bob'), down('carol')]);
    expect(tally).toEqual({ tp: 2, fp: 1, ambiguous: 0 });
  });

  it('is one vote per user (duplicate reactions collapse)', () => {
    const tally = tallyAdjudications([up('alice'), up('alice'), up('alice')]);
    expect(tally.tp).toBe(1);
  });

  it('a user reacting both ways is ambiguous, excluded from TP and FP', () => {
    const tally = tallyAdjudications([up('alice'), down('alice'), up('bob')]);
    expect(tally).toEqual({ tp: 1, fp: 0, ambiguous: 1 });
  });

  it('bot reactions never count', () => {
    const tally = tallyAdjudications([
      up('github-actions[bot]'),
      down('some-other[bot]'),
      up('human'),
    ]);
    expect(tally).toEqual({ tp: 1, fp: 0, ambiguous: 0 });
  });

  it('non-verdict reactions (heart, laugh, ...) are ignored', () => {
    const tally = tallyAdjudications([
      { user: 'alice', content: 'heart' },
      { user: 'bob', content: 'laugh' },
      { user: 'carol', content: 'confused' },
    ]);
    expect(tally).toEqual({ tp: 0, fp: 0, ambiguous: 0 });
  });

  it('empty reactions tally to zero', () => {
    expect(tallyAdjudications([])).toEqual({ tp: 0, fp: 0, ambiguous: 0 });
  });
});

// --- activeFindingPaths (parses the real rendered comment) -------------------

describe('activeFindingPaths', () => {
  it('extracts every active finding path from a rendered comment', () => {
    const body = stickyBody([finding('pkg/a.py'), finding('pkg/b.py')]);
    expect(activeFindingPaths(body)).toEqual(['pkg/a.py', 'pkg/b.py']);
  });

  it('a path-with-unit label yields the path, not the unit', () => {
    const body = stickyBody([finding('pkg/a.py', { unit: 'frobnicate' })]);
    expect(activeFindingPaths(body)).toEqual(['pkg/a.py']);
  });

  it('a no-gaps body has no attributable findings', () => {
    expect(activeFindingPaths(stickyBody([]))).toEqual([]);
  });

  it('suppressed findings are not attributable (not table rows)', () => {
    const body = stickyBody([
      finding('pkg/a.py'),
      finding('pkg/b.py', { suppressed: true, suppression_reason: 'ok' }),
    ]);
    expect(activeFindingPaths(body)).toEqual(['pkg/a.py']);
  });

  it('never mistakes the table header or separator for a finding', () => {
    const body = stickyBody([finding('pkg/a.py')]);
    const paths = activeFindingPaths(body);
    expect(paths).not.toContain(' File ');
    expect(paths).not.toContain(' --- ');
  });
});

// --- buildAdjudicationRecord: attribution granularity -------------------------

describe('buildAdjudicationRecord attribution', () => {
  const base = {
    repo: 'o/r',
    prNumber: 7,
    commentId: 1001,
    tally: { tp: 1, fp: 0, ambiguous: 0 },
    collectedAt: '2026-07-30T00:00:00+00:00',
  };

  it('exactly one active finding -> finding-level attribution', () => {
    const record = buildAdjudicationRecord({
      ...base,
      commentBody: stickyBody([finding('pkg/only.py')]),
    });
    expect(record.granularity).toBe('finding');
    expect(record.attributedPath).toBe('pkg/only.py');
    expect(record.findingPaths).toEqual(['pkg/only.py']);
  });

  it('several active findings -> run-level (cannot name which was wrong)', () => {
    const record = buildAdjudicationRecord({
      ...base,
      commentBody: stickyBody([finding('pkg/a.py'), finding('pkg/b.py')]),
    });
    expect(record.granularity).toBe('run');
    expect(record.attributedPath).toBeNull();
    expect(record.findingPaths).toEqual(['pkg/a.py', 'pkg/b.py']);
  });

  it('a no-gaps comment -> run-level with no paths', () => {
    const record = buildAdjudicationRecord({
      ...base,
      commentBody: stickyBody([]),
    });
    expect(record.granularity).toBe('run');
    expect(record.attributedPath).toBeNull();
  });
});

// --- collectAdjudications ------------------------------------------------------

describe('collectAdjudications', () => {
  const BODY = stickyBody([finding('pkg/widget.py')]);

  it('writes the record for a reacted-to sticky comment', async () => {
    const analysesDir = mkAnalysesDir();
    const client = new FakeReactionsClient({
      comments: [
        { id: 1, body: 'unrelated human comment' },
        { id: 2, body: BODY },
      ],
      reactions: { 2: [up('alice'), down('bob')] },
    });
    const res = await collectAdjudications(client, {
      repo: 'o/r',
      prNumber: 7,
      analysesDir,
    });
    expect(res.action).toBe('collected');
    expect(res.path).toBe(join(analysesDir, adjudicationFilename(7)));
    const record = JSON.parse(
      readFileSync(res.path!, 'utf-8'),
    ) as AdjudicationRecord;
    expect(record.source).toBe(ADJUDICATION_SOURCE);
    expect(record.tp).toBe(1);
    expect(record.fp).toBe(1);
    expect(record.commentId).toBe(2);
    expect(record.granularity).toBe('finding');
    expect(record.attributedPath).toBe('pkg/widget.py');
  });

  it('is idempotent per PR: re-collection overwrites, never duplicates', async () => {
    const analysesDir = mkAnalysesDir();
    const client = new FakeReactionsClient({
      comments: [{ id: 2, body: BODY }],
      reactions: { 2: [up('alice')] },
    });
    const args = { repo: 'o/r', prNumber: 7, analysesDir };
    await collectAdjudications(client, args);
    client.reactionsByComment.set(2, [up('alice'), down('bob')]);
    await collectAdjudications(client, args);
    const files = readdirSync(analysesDir).filter((n) => !n.startsWith('.'));
    expect(files).toEqual([adjudicationFilename(7)]);
    const record = JSON.parse(
      readFileSync(join(analysesDir, files[0]!), 'utf-8'),
    ) as AdjudicationRecord;
    expect([record.tp, record.fp]).toEqual([1, 1]);
  });

  it('no sticky comment -> no-comment, nothing written', async () => {
    const analysesDir = mkAnalysesDir();
    const client = new FakeReactionsClient({
      comments: [{ id: 1, body: 'no marker here' }],
    });
    const res = await collectAdjudications(client, {
      repo: 'o/r',
      prNumber: 7,
      analysesDir,
    });
    expect(res.action).toBe('no-comment');
    expect(existsSync(analysesDir)).toBe(false); // nothing even created
  });

  it('zero verdicts -> no-reactions, nothing written (neutral, not a vote)', async () => {
    const analysesDir = mkAnalysesDir();
    const client = new FakeReactionsClient({
      comments: [{ id: 2, body: BODY }],
      reactions: { 2: [{ user: 'alice', content: 'heart' }] },
    });
    const res = await collectAdjudications(client, {
      repo: 'o/r',
      prNumber: 7,
      analysesDir,
    });
    expect(res.action).toBe('no-reactions');
    expect(existsSync(analysesDir)).toBe(false); // neutral: no record at all
  });

  it('absent .harness/ channel -> unavailable with a loud notice', async () => {
    const client = new FakeReactionsClient({
      comments: [{ id: 2, body: BODY }],
      reactions: { 2: [up('alice')] },
    });
    const res = await collectAdjudications(client, {
      repo: 'o/r',
      prNumber: 7,
      analysesDir: join(tmp, 'no-harness-home', 'analyses'),
    });
    expect(res.action).toBe('unavailable');
    expect(res.notice).toContain('.harness/ absent');
  });
});

// --- loadAdjudicationRecords ----------------------------------------------------

describe('loadAdjudicationRecords', () => {
  it('reads only adjudication records; findings records and junk are skipped', () => {
    const analysesDir = mkAnalysesDir();
    mkdirSync(analysesDir, { recursive: true });
    const good: Partial<AdjudicationRecord> = {
      source: ADJUDICATION_SOURCE,
      tp: 2,
      fp: 1,
      ambiguous: 0,
    };
    writeFileSync(
      join(analysesDir, adjudicationFilename(7)),
      JSON.stringify(good),
    );
    // A pr-check FINDINGS record shares the parent prefix but not this source.
    writeFileSync(
      join(analysesDir, 'canary-pr-guardian-pr-7.json'),
      JSON.stringify({ source: 'canary-pr-guardian', findings: [] }),
    );
    writeFileSync(
      join(analysesDir, `${ADJUDICATION_SOURCE}-pr-8.json`),
      'not json at all {',
    );
    const records = loadAdjudicationRecords(analysesDir);
    expect(records).toHaveLength(1);
    expect(records[0]!.tp).toBe(2);
  });

  it('a missing dir yields no records, not a crash', () => {
    expect(loadAdjudicationRecords(join(tmp, 'nope'))).toEqual([]);
  });
});

// --- precision summary: the zero-denominator discipline --------------------------

describe('summarizePrecision / renderPrecision', () => {
  const record = (tp: number, fp: number): AdjudicationRecord => ({
    schemaVersion: '1.0',
    source: ADJUDICATION_SOURCE,
    repo: 'o/r',
    prNumber: 1,
    commentId: 1,
    granularity: 'run',
    attributedPath: null,
    findingPaths: [],
    tp,
    fp,
    ambiguous: 0,
    collectedAt: 'now',
  });

  it('zero adjudications -> precision is null, NOT 1.0', () => {
    const summary = summarizePrecision([]);
    expect(summary.precision).toBeNull();
    expect(summary.adjudicated).toBe(0);
  });

  it('zero adjudications render as unknown and never imply 100%', () => {
    const text = renderPrecision(summarizePrecision([]));
    expect(text).toContain('unknown');
    expect(text).toContain('no adjudications yet');
    expect(text).not.toContain('100');
    expect(text).not.toContain('%');
  });

  it('aggregates TP/FP across PRs and carries the sample size', () => {
    const summary = summarizePrecision([record(4, 1), record(1, 0)]);
    expect(summary).toMatchObject({
      tp: 5,
      fp: 1,
      adjudicated: 6,
      prCount: 2,
    });
    expect(summary.precision).toBeCloseTo(5 / 6);
    const text = renderPrecision(summary);
    expect(text).toContain('83.3%');
    expect(text).toContain('n=6');
    expect(text).toContain('2 PR(s)');
    expect(text).toContain('self-selected');
  });

  it('an all-FP sample reads 0%, not unknown (measured, just bad)', () => {
    const summary = summarizePrecision([record(0, 3)]);
    expect(summary.precision).toBe(0);
    expect(renderPrecision(summary)).toContain('0%');
  });
});

// --- CLI: precision command -------------------------------------------------------

describe('guardian precision (CLI)', () => {
  it('with no records says unknown, exits 0', async () => {
    const res = await invokeGuardian(
      ['precision', '--analyses-dir', join(tmp, 'empty')],
      { cwd: tmp },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('guardian precision: unknown');
    expect(res.stdout).toContain('no adjudications yet');
  });

  it('--json reports precision null (unknown), never 1.0, on zero records', async () => {
    const res = await invokeGuardian(
      ['precision', '--json', '--analyses-dir', join(tmp, 'empty')],
      { cwd: tmp },
    );
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      precision: number | null;
      adjudicated: number;
    };
    expect(payload.precision).toBeNull();
    expect(payload.adjudicated).toBe(0);
  });

  it('reports the aggregate over persisted records', async () => {
    const analysesDir = mkAnalysesDir();
    mkdirSync(analysesDir, { recursive: true });
    writeFileSync(
      join(analysesDir, adjudicationFilename(7)),
      JSON.stringify({ source: ADJUDICATION_SOURCE, tp: 3, fp: 1 }),
    );
    const res = await invokeGuardian(
      ['precision', '--analyses-dir', analysesDir],
      { cwd: tmp },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('75%');
    expect(res.stdout).toContain('n=4');
  });
});

// --- CLI: collect-adjudications ----------------------------------------------------

describe('guardian collect-adjudications (CLI)', () => {
  const BODY = stickyBody([finding('pkg/widget.py')]);

  it('collects via --repo/--pr and persists the record', async () => {
    const analysesDir = mkAnalysesDir();
    const fake = new FakeReactionsClient({
      comments: [{ id: 5, body: BODY }],
      reactions: { 5: [up('alice')] },
    });
    const res = await invokeGuardian(
      [
        'collect-adjudications',
        '--repo',
        'o/r',
        '--pr',
        '7',
        '--analyses-dir',
        analysesDir,
      ],
      { cwd: tmp, deps: { buildReactionsClient: () => fake } },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('adjudication recorded');
    expect(readdirSync(analysesDir)).toContain(adjudicationFilename(7));
  });

  it('resolves the PR from Actions env when flags are omitted', async () => {
    const analysesDir = mkAnalysesDir();
    const fake = new FakeReactionsClient({
      comments: [{ id: 5, body: BODY }],
      reactions: { 5: [down('bob')] },
    });
    const res = await invokeGuardian(
      ['collect-adjudications', '--analyses-dir', analysesDir],
      {
        cwd: tmp,
        env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/9/merge' },
        deps: { buildReactionsClient: () => fake },
      },
    );
    expect(res.code).toBe(0);
    expect(readdirSync(analysesDir)).toContain(adjudicationFilename(9));
  });

  it('no PR context anywhere exits 2', async () => {
    const res = await invokeGuardian(['collect-adjudications'], { cwd: tmp });
    expect(res.code).toBe(2);
    expect(res.stdout).toContain('no PR context');
  });

  it('an unavailable channel fails LOUDLY (exit 1) on the explicit surface', async () => {
    const fake = new FakeReactionsClient({
      comments: [{ id: 5, body: BODY }],
      reactions: { 5: [up('alice')] },
    });
    const res = await invokeGuardian(
      [
        'collect-adjudications',
        '--repo',
        'o/r',
        '--pr',
        '7',
        '--analyses-dir',
        join(tmp, 'no-home', 'analyses'),
      ],
      { cwd: tmp, deps: { buildReactionsClient: () => fake } },
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('not persisted');
  });

  it('no reactions yet reports neutrally, writes nothing, exits 0', async () => {
    const analysesDir = mkAnalysesDir();
    const fake = new FakeReactionsClient({ comments: [{ id: 5, body: BODY }] });
    const res = await invokeGuardian(
      [
        'collect-adjudications',
        '--repo',
        'o/r',
        '--pr',
        '7',
        '--analyses-dir',
        analysesDir,
      ],
      { cwd: tmp, deps: { buildReactionsClient: () => fake } },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('no reviewer verdicts');
  });
});

// --- CLI: pr-check inline collection (the #490 loop) --------------------------------

describe('pr-check inline adjudication collection', () => {
  const DIFF_NEW_UNIT = `diff --git a/pkg/widget.py b/pkg/widget.py
index 1111111..2222222 100644
--- a/pkg/widget.py
+++ b/pkg/widget.py
@@ -0,0 +1,3 @@
+def widget():
+    return 42
+
`;

  const CI_ENV = {
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_REF: 'refs/pull/7/merge',
    GITHUB_TOKEN: 't',
  };

  it('harvests reactions off the previous sticky comment before reposting', async () => {
    const analysesDir = mkAnalysesDir();
    const previousBody = `${STICKY_MARKER}\nprevious run\n| \u{1F534} high | \`pkg/widget.py\` | untested | heuristic |`;
    const comments = [{ id: 42, body: previousBody }];
    const reactions = new FakeReactionsClient({
      comments,
      reactions: { 42: [up('alice'), down('bob')] },
    });
    const poster = new FakeGitHubClient({ comments });
    const res = await invokeGuardian(
      [
        'pr-check',
        '--diff',
        '-',
        '--post-comment',
        '--analyses-dir',
        analysesDir,
      ],
      {
        input: DIFF_NEW_UNIT,
        env: CI_ENV,
        cwd: tmp,
        deps: {
          buildCommentClient: () => poster,
          buildReactionsClient: () => reactions,
        },
      },
    );
    expect(res.code).toBe(0); // soft gate: collection never changes the exit
    expect(res.stdout).toContain('adjudication recorded (1 up / 1 down)');
    const record = JSON.parse(
      readFileSync(join(analysesDir, adjudicationFilename(7)), 'utf-8'),
    ) as AdjudicationRecord;
    expect([record.tp, record.fp]).toEqual([1, 1]);
    // The sticky comment was still upserted (single marked comment remains).
    const marked = poster.comments.filter((c) =>
      c.body.includes(STICKY_MARKER),
    );
    expect(marked).toHaveLength(1);
  });

  it('a collection failure warns and never turns the gate red', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--post-comment'],
      {
        input: DIFF_NEW_UNIT,
        env: CI_ENV,
        cwd: tmp,
        deps: {
          buildCommentClient: () => new FakeGitHubClient(),
          buildReactionsClient: () => {
            throw new Error('boom');
          },
        },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('adjudication collection failed');
    expect(res.stdout).toContain('gate unaffected');
  });

  it('without a token it skips LOUDLY instead of calling the API', async () => {
    const res = await invokeGuardian(
      ['pr-check', '--diff', '-', '--post-comment'],
      {
        input: DIFF_NEW_UNIT,
        env: { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' },
        cwd: tmp,
        deps: {
          buildCommentClient: () => new FakeGitHubClient(),
          buildReactionsClient: () => {
            throw new Error('must not be constructed without a token');
          },
        },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('adjudications not collected');
  });
});

// --- CLI: harden-gate consults the evidence ------------------------------------------

describe('harden-gate precision readiness (#490)', () => {
  it('dry-run reports unknown precision when nothing is collected', async () => {
    const res = await invokeGuardian(
      ['harden-gate', '--repo', 'o/r', '--analyses-dir', join(tmp, 'empty')],
      { cwd: tmp },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('guardian precision: unknown');
    expect(res.stdout).toContain('no adjudications yet');
  });

  it('dry-run reports the measured precision with its sample size', async () => {
    const analysesDir = mkAnalysesDir();
    mkdirSync(analysesDir, { recursive: true });
    writeFileSync(
      join(analysesDir, adjudicationFilename(3)),
      JSON.stringify({ source: ADJUDICATION_SOURCE, tp: 9, fp: 1 }),
    );
    const res = await invokeGuardian(
      ['harden-gate', '--repo', 'o/r', '--analyses-dir', analysesDir],
      { cwd: tmp },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('90%');
    expect(res.stdout).toContain('n=10');
  });
});
