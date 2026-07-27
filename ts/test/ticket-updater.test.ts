/**
 * Tests for TicketUpdater -- linkage detection, comment formatting, transition
 * logic, dry-run, safety gate, and per-project Atlassian URL resolution.
 *
 * Ported from tests/unit/test_ticket_updater.py (every case preserved). Python
 * `patch("agent.core.ticket_updater._jira_*")` maps to `vi.spyOn` on the
 * instance-method seams; `patch("...urlopen")` maps to an injected `http` spy.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  jiraAuth,
  RunSummary,
  TicketUpdater,
} from '../src/core/ticket-updater.js';
import type { HttpClient } from '../src/core/workflow-discovery.js';

// -- helpers -----------------------------------------------------------------

const tmpDirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tk-'));
  tmpDirs.push(d);
  return d;
}

/** A `.canary` dir inside a fresh temp dir. */
function canaryDir(): string {
  const d = join(tmp(), '.canary');
  mkdirSync(d, { recursive: true });
  return d;
}

function makeSummary(
  overrides: Partial<ConstructorParameters<typeof RunSummary>[0]> = {},
): RunSummary {
  return new RunSummary({
    suite_name: 'challenge-tests',
    env: 'stage',
    result: 'PASS',
    passed: 3,
    total: 3,
    flaky_count: 0,
    duration_s: 12.5,
    test_file: 'tests/challenge.spec.ts',
    report_url: null,
    passed_names: ['test_a', 'test_b', 'test_c'],
    failed_names: [],
    ticket_key: null,
    project_key: null,
    linkage_source: 'none',
    ...overrides,
  });
}

function writeTransitionMapping(
  dir: string,
  projectKey: string,
  qaPassedStatus: string,
  atlassianUrl?: string,
): void {
  const mapping: Record<string, unknown> = {
    project_key: projectKey,
    source: 'jira',
    discovered_at: '2026-01-01T00:00:00+00:00',
    issue_types: [
      {
        id: '10001',
        name: 'Story',
        statuses: [
          { id: '1', name: 'In QA', category: 'indeterminate' },
          { id: '2', name: qaPassedStatus, category: 'indeterminate' },
        ],
        transitions: [
          { id: '31', name: 'QA Pass', from: 'In QA', to: qaPassedStatus },
        ],
      },
    ],
    semantic_roles: {
      qa_passed: { status_name: qaPassedStatus, issue_type: 'Story' },
      in_qa: { status_name: 'In QA', issue_type: 'Story' },
    },
    role_annotations_confirmed: true,
  };
  if (atlassianUrl) mapping['atlassian_url'] = atlassianUrl;
  writeFileSync(
    join(dir, `workflow-${projectKey}.json`),
    JSON.stringify(mapping),
    'utf-8',
  );
}

const ENV_KEYS = ['ATLASSIAN_URL', 'ATLASSIAN_USER', 'ATLASSIAN_TOKEN'];
let envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup = {};
  for (const k of ENV_KEYS) envBackup[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  vi.restoreAllMocks();
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

// A check mark, ballot X, and em-dash used byte-exact by the comment builder.
const CHECK = '\u2713';
const CROSS = '\u2717';
const DASH = '\u2014';

// -- linkage detection: frontmatter -----------------------------------------

describe('detect_linkage frontmatter', () => {
  function write(name: string, content: string): string {
    const base = tmp();
    const p = join(base, name);
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('frontmatter ticket only, infers project', () => {
    const f = write(
      'test.spec.ts',
      "# canary:ticket: PROJ-42\n\ntest('foo', () => {});\n",
    );
    const [key, project, source] = new TicketUpdater().detectLinkage(f);
    expect(key).toBe('PROJ-42');
    expect(project).toBe('PROJ');
    expect(source).toBe('frontmatter');
  });

  it('explicit canary:project overrides inferred project', () => {
    const f = write(
      'test.spec.ts',
      "# canary:ticket: OPTM-99\n# canary:project: OPTM\n\ntest('x', () => {});\n",
    );
    const [key, project, source] = new TicketUpdater().detectLinkage(f);
    expect(key).toBe('OPTM-99');
    expect(project).toBe('OPTM');
    expect(source).toBe('frontmatter');
  });

  it('frontmatter wins over tag', () => {
    const f = write(
      'test.spec.ts',
      "# canary:ticket: FRONT-1\n\ntest('@ticket:TAG-2 something', () => {});\n",
    );
    const [key, , source] = new TicketUpdater().detectLinkage(f);
    expect(key).toBe('FRONT-1');
    expect(source).toBe('frontmatter');
  });
});

// -- linkage detection: tag --------------------------------------------------

describe('detect_linkage tag', () => {
  function write(content: string): string {
    const p = join(tmp(), 'test.spec.ts');
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('@ticket tag (typescript)', () => {
    const f = write("test('@ticket:ACME-7 user can login', async () => {});\n");
    const [key, project, source] = new TicketUpdater().detectLinkage(f);
    expect(key).toBe('ACME-7');
    expect(project).toBe('ACME');
    expect(source).toBe('tag');
  });

  it('@jira tag (python)', () => {
    const content =
      'def test_something():\n    """@jira:DEMO-100 does the thing"""\n';
    const f = write(content);
    const [key, project, source] = new TicketUpdater().detectLinkage(f);
    expect(key).toBe('DEMO-100');
    expect(project).toBe('DEMO');
    expect(source).toBe('tag');
  });

  it('tag infers project from key', () => {
    const f = write("test('@ticket:XY-3 something', () => {});\n");
    const [, project] = new TicketUpdater().detectLinkage(f);
    expect(project).toBe('XY');
  });

  it('no linkage in file falls through to branch', () => {
    const f = write("test('no ticket here', () => {});\n");
    const updater = new TicketUpdater();
    vi.spyOn(updater, 'branchTicket').mockReturnValue([null, null, 'none']);
    const [key, , source] = updater.detectLinkage(f);
    expect(key).toBeNull();
    expect(source).toBe('none');
  });
});

// -- linkage detection: branch (file absent) --------------------------------

describe('detect_linkage branch', () => {
  it('branch ticket extracted', () => {
    const f = join(tmp(), 'nonexistent.spec.ts');
    const updater = new TicketUpdater();
    vi.spyOn(updater, 'branchTicket').mockReturnValue([
      'FEAT-55',
      'FEAT',
      'branch',
    ]);
    const [key, project, source] = updater.detectLinkage(f);
    expect(key).toBe('FEAT-55');
    expect(project).toBe('FEAT');
    expect(source).toBe('branch');
  });

  it('no branch match returns none', () => {
    const f = join(tmp(), 'nonexistent.spec.ts');
    const updater = new TicketUpdater();
    vi.spyOn(updater, 'branchTicket').mockReturnValue([null, null, 'none']);
    const [key, , source] = updater.detectLinkage(f);
    expect(key).toBeNull();
    expect(source).toBe('none');
  });
});

// -- comment formatting ------------------------------------------------------

describe('build_comment', () => {
  const updater = new TicketUpdater();

  it('pass comment shape', () => {
    const body = updater.buildComment(
      makeSummary({
        result: 'PASS',
        passed: 3,
        total: 3,
        passed_names: ['login', 'logout', 'reset'],
        failed_names: [],
      }),
    );
    expect(body).toContain('PASS (3/3 tests)');
    expect(body).toContain(`${CHECK} login`);
    expect(body).not.toContain(CROSS);
  });

  it('fail comment shape', () => {
    const body = updater.buildComment(
      makeSummary({
        result: 'FAIL',
        passed: 1,
        total: 2,
        passed_names: ['login'],
        failed_names: [['checkout', 'assertion_error']],
      }),
    );
    expect(body).toContain('FAIL (1/2 tests)');
    expect(body).toContain(`${CROSS} checkout ${DASH} assertion_error`);
    expect(body).toContain(`${CHECK} login`);
  });

  it('partial comment shape', () => {
    const body = updater.buildComment(
      makeSummary({
        result: 'PARTIAL',
        passed: 2,
        total: 3,
        passed_names: ['a', 'b'],
        failed_names: [['c', 'timeout']],
      }),
    );
    expect(body).toContain('PARTIAL (2/3 tests)');
  });

  it('report url included when present', () => {
    const body = updater.buildComment(
      makeSummary({ report_url: 'https://reports.example.com/run/42' }),
    );
    expect(body).toContain('https://reports.example.com/run/42');
  });

  it('no report url omits line', () => {
    const body = updater.buildComment(makeSummary({ report_url: null }));
    expect(body).not.toContain('Report:');
  });

  it('flaky count in comment', () => {
    const body = updater.buildComment(makeSummary({ flaky_count: 2 }));
    expect(body).toContain('Flaky: 2');
  });

  it('suite name in header', () => {
    const body = updater.buildComment(
      makeSummary({ suite_name: 'my-custom-suite' }),
    );
    expect(body).toContain(`Canary Test Run ${DASH} my-custom-suite`);
  });

  it('no LLM-style commentary markers', () => {
    const body = updater.buildComment(makeSummary());
    expect(body).not.toContain('As an AI');
    expect(body).not.toContain('I can help');
  });

  // Regression (adversarial review F4): duration_s is a Python float, so an
  // integral value renders a trailing `.0` (str(0.0) === '0.0'). JS String(0)
  // drops it. The default 0.0 and whole-second durations are reachable and are
  // interpolated into the posted comment, so the `.0` must survive.
  it('renders an integral duration with a trailing .0 (Python str(float))', () => {
    expect(updater.buildComment(makeSummary({ duration_s: 0 }))).toContain(
      'Duration: 0.0s',
    );
    expect(updater.buildComment(makeSummary({ duration_s: 12 }))).toContain(
      'Duration: 12.0s',
    );
    // Non-integral is unchanged.
    expect(updater.buildComment(makeSummary({ duration_s: 12.5 }))).toContain(
      'Duration: 12.5s',
    );
  });
});

// -- port-fidelity fixes (adversarial review) --------------------------------

describe('Jira request-body / ticket-key fidelity', () => {
  // Regression (F1): Python json.dumps uses default separators (', ', ': ') --
  // a space after every ':' and ','. JSON.stringify emits none. The POST body
  // must match the oracle byte-for-byte.
  it('transition POST body uses Python json.dumps separators', async () => {
    let captured = '';
    const http: HttpClient = async (req) => {
      captured = req.body ?? '';
      return { ok: true, status: 204, text: '' };
    };
    const updater = new TicketUpdater(canaryDir(), { http });
    await updater.jiraDoTransition(
      'https://j.example.com',
      'Basic x',
      'ACME-1',
      '31',
    );
    expect(captured).toBe('{"transition": {"id": "31"}}');
  });

  // Regression (F3): Python `$` (no MULTILINE) leniently matches before a
  // trailing \n, so a caller-supplied "PROJ-10\n" routes to Jira there; the
  // port strips it at ingest so routing matches AND the key stays clean.
  it('normalizes a trailing newline in a caller-supplied ticket key', async () => {
    const dir = canaryDir();
    writeTransitionMapping(dir, 'PROJ', 'QA Passed');
    const http = vi.fn<HttpClient>(async () => ({
      ok: true,
      status: 200,
      text: '{}',
    }));
    const updater = new TicketUpdater(dir, { http });
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://j.example.com',
      'Basic dGVzdA==',
    ]);
    vi.spyOn(updater, 'jiraCurrentStatus').mockResolvedValue('In QA');
    vi.spyOn(updater, 'jiraFindTransition').mockResolvedValue('31');

    const summary = makeSummary({
      ticket_key: 'PROJ-10\n',
      project_key: 'PROJ',
      linkage_source: 'frontmatter',
    });
    const result = await updater.update(summary, { dryRun: true });
    // Routed to Jira (not "unrecognised") and the key is clean.
    expect(result.ticket_key).toBe('PROJ-10');
    expect(result.comment_posted).toBe(true);
  });
});

// -- transition logic --------------------------------------------------------

describe('transition logic', () => {
  it('FAIL result does not transition', async () => {
    const dir = canaryDir();
    writeTransitionMapping(dir, 'PROJ', 'QA Passed');
    const result = await new TicketUpdater(dir).transitionJira(
      'PROJ-1',
      'PROJ',
      'FAIL',
      true,
    );
    expect(result.attempted).toBe(false);
    expect(result.reason).toContain('FAIL');
  });

  it('PARTIAL result does not transition', async () => {
    const dir = canaryDir();
    writeTransitionMapping(dir, 'PROJ', 'QA Passed');
    const result = await new TicketUpdater(dir).transitionJira(
      'PROJ-1',
      'PROJ',
      'PARTIAL',
      true,
    );
    expect(result.attempted).toBe(false);
    expect(result.reason).toContain('PARTIAL');
  });

  it('PASS with missing mapping surfaces guidance', async () => {
    const dir = canaryDir();
    const result = await new TicketUpdater(dir).transitionJira(
      'PROJ-1',
      'PROJ',
      'PASS',
      true,
    );
    expect(result.attempted).toBe(false);
    expect(result.reason).toContain('canary workflow-discover');
    expect(result.reason).toContain('PROJ');
  });

  it('PASS dry-run returns proposed transition', async () => {
    const dir = canaryDir();
    writeTransitionMapping(dir, 'ACME', 'QA Passed');
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://j.example.com',
      'Basic dGVzdA==',
    ]);
    vi.spyOn(updater, 'jiraCurrentStatus').mockResolvedValue('In QA');
    vi.spyOn(updater, 'jiraFindTransition').mockResolvedValue('31');

    const result = await updater.transitionJira('ACME-1', 'ACME', 'PASS', true);
    expect(result.attempted).toBe(true);
    expect(result.succeeded).toBe(false);
    expect(result.from_status).toBe('In QA');
    expect(result.to_status).toBe('QA Passed');
    expect(result.reason).toBe('dry-run');
  });

  it('PASS not-reachable transition', async () => {
    const dir = canaryDir();
    writeTransitionMapping(dir, 'ACME', 'QA Passed');
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://j.example.com',
      'Basic dGVzdA==',
    ]);
    vi.spyOn(updater, 'jiraCurrentStatus').mockResolvedValue('Done');
    vi.spyOn(updater, 'jiraFindTransition').mockResolvedValue(null);

    const result = await updater.transitionJira(
      'ACME-2',
      'ACME',
      'PASS',
      false,
    );
    expect(result.attempted).toBe(true);
    expect(result.succeeded).toBe(false);
    expect(result.reason).toContain('not reachable');
  });

  it('PASS transition executes on live', async () => {
    const dir = canaryDir();
    writeTransitionMapping(dir, 'ACME', 'QA Passed');
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://j.example.com',
      'Basic dGVzdA==',
    ]);
    vi.spyOn(updater, 'jiraCurrentStatus').mockResolvedValue('In QA');
    vi.spyOn(updater, 'jiraFindTransition').mockResolvedValue('31');
    vi.spyOn(updater, 'jiraDoTransition').mockResolvedValue(true);

    const result = await updater.transitionJira(
      'ACME-3',
      'ACME',
      'PASS',
      false,
    );
    expect(result.attempted).toBe(true);
    expect(result.succeeded).toBe(true);
  });

  it('no jira creds blocks the transition', async () => {
    const dir = canaryDir();
    writeTransitionMapping(dir, 'ACME', 'QA Passed');
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([null, null]);
    const result = await updater.transitionJira('ACME-4', 'ACME', 'PASS', true);
    expect(result.attempted).toBe(false);
    expect(result.reason).toContain('credentials not configured');
  });

  it('unfetchable current status blocks the transition', async () => {
    const dir = canaryDir();
    writeTransitionMapping(dir, 'ACME', 'QA Passed');
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://j.example.com',
      'Basic x',
    ]);
    vi.spyOn(updater, 'jiraCurrentStatus').mockResolvedValue(null);
    const result = await updater.transitionJira('ACME-5', 'ACME', 'PASS', true);
    expect(result.attempted).toBe(false);
    expect(result.reason).toContain('Could not fetch current status');
  });

  it('live transition failure reports API failure', async () => {
    const dir = canaryDir();
    writeTransitionMapping(dir, 'ACME', 'QA Passed');
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://j.example.com',
      'Basic x',
    ]);
    vi.spyOn(updater, 'jiraCurrentStatus').mockResolvedValue('In QA');
    vi.spyOn(updater, 'jiraFindTransition').mockResolvedValue('31');
    vi.spyOn(updater, 'jiraDoTransition').mockResolvedValue(false);
    const result = await updater.transitionJira(
      'ACME-6',
      'ACME',
      'PASS',
      false,
    );
    expect(result.succeeded).toBe(false);
    expect(result.reason).toBe('transition API call failed');
  });
});

// -- dry-run mode ------------------------------------------------------------

describe('dry-run mode', () => {
  function writeMapping(dir: string): void {
    const mapping = {
      project_key: 'PROJ',
      source: 'jira',
      discovered_at: '2026-01-01T00:00:00+00:00',
      issue_types: [{ id: '1', name: 'Story', statuses: [], transitions: [] }],
      semantic_roles: {
        qa_passed: { status_name: 'QA Passed', issue_type: 'Story' },
      },
      role_annotations_confirmed: true,
    };
    writeFileSync(
      join(dir, 'workflow-PROJ.json'),
      JSON.stringify(mapping),
      'utf-8',
    );
  }

  it('makes no external calls', async () => {
    const dir = canaryDir();
    writeMapping(dir);
    const http = vi.fn<HttpClient>(async () => ({
      ok: true,
      status: 200,
      text: '{}',
    }));
    const updater = new TicketUpdater(dir, { http });
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://j.example.com',
      'Basic dGVzdA==',
    ]);
    vi.spyOn(updater, 'jiraCurrentStatus').mockResolvedValue('In QA');
    vi.spyOn(updater, 'jiraFindTransition').mockResolvedValue('31');

    const summary = makeSummary({
      ticket_key: 'PROJ-10',
      project_key: 'PROJ',
      linkage_source: 'frontmatter',
    });
    const result = await updater.update(summary, { dryRun: true });

    expect(http).not.toHaveBeenCalled();
    expect(result.dry_run).toBe(true);
    expect(result.comment_posted).toBe(true);
  });

  it('output contains comment content', async () => {
    const dir = canaryDir();
    writeMapping(dir);
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://j.example.com',
      'Basic dGVzdA==',
    ]);
    vi.spyOn(updater, 'jiraCurrentStatus').mockResolvedValue('In QA');
    vi.spyOn(updater, 'jiraFindTransition').mockResolvedValue('31');

    const result = await updater.update(
      makeSummary({
        ticket_key: 'PROJ-10',
        project_key: 'PROJ',
        linkage_source: 'frontmatter',
      }),
      { dryRun: true },
    );
    const combined = result.messages.join('\n');
    expect(combined).toContain('Would post comment');
    expect(combined).toContain('PROJ-10');
  });

  it('shows transition intent', async () => {
    const dir = canaryDir();
    writeMapping(dir);
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://j.example.com',
      'Basic dGVzdA==',
    ]);
    vi.spyOn(updater, 'jiraCurrentStatus').mockResolvedValue('In QA');
    vi.spyOn(updater, 'jiraFindTransition').mockResolvedValue('31');

    const result = await updater.update(
      makeSummary({
        ticket_key: 'PROJ-10',
        project_key: 'PROJ',
        linkage_source: 'frontmatter',
      }),
      { dryRun: true },
    );
    const combined = result.messages.join('\n');
    expect(combined).toContain('Would transition');
    expect(combined).toContain('QA Passed');
  });
});

// -- safety gate -------------------------------------------------------------

describe('safety gate', () => {
  it('missing mapping surfaces workflow-discover command', async () => {
    const dir = canaryDir();
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://j.example.com',
      'Basic dGVzdA==',
    ]);
    const result = await updater.update(
      makeSummary({
        ticket_key: 'NOPE-1',
        project_key: 'NOPE',
        linkage_source: 'frontmatter',
      }),
      { dryRun: false },
    );
    expect(result.transition.attempted).toBe(false);
    const combined = result.messages.join('\n') + result.transition.reason;
    expect(combined).toContain('canary workflow-discover');
  });

  it('no linkage skips entirely', async () => {
    const dir = canaryDir();
    const updater = new TicketUpdater(dir);
    const result = await updater.update(
      makeSummary({
        ticket_key: null,
        project_key: null,
        linkage_source: 'none',
        test_file: '',
      }),
    );
    expect(result.ticket_key).toBeNull();
    expect(result.comment_posted).toBe(false);
    expect(result.transition.attempted).toBe(false);
    expect(result.messages.join('\n')).toContain('No ticket linkage found');
  });

  it('unknown ticket format produces message', async () => {
    const dir = canaryDir();
    const updater = new TicketUpdater(dir);
    const result = await updater.update(
      makeSummary({
        ticket_key: 'not-a-valid-key',
        project_key: null,
        linkage_source: 'frontmatter',
      }),
      { commentOnly: true },
    );
    expect(result.messages.join('\n')).toContain(
      'Unrecognised ticket key format',
    );
  });

  it('comment-only skips transition', async () => {
    const dir = canaryDir();
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([null, null]);
    const result = await updater.update(
      makeSummary({
        ticket_key: 'PROJ-5',
        project_key: 'PROJ',
        linkage_source: 'frontmatter',
      }),
      { dryRun: true, commentOnly: true },
    );
    expect(result.transition.reason).toBe('skipped (comment-only mode)');
  });

  it('github issue key routes to the github comment surface (dry-run)', async () => {
    const dir = canaryDir();
    const updater = new TicketUpdater(dir);
    const result = await updater.update(
      makeSummary({
        ticket_key: '42',
        project_key: 'owner/repo',
        linkage_source: 'frontmatter',
      }),
      { dryRun: true, commentOnly: true },
    );
    expect(result.comment_posted).toBe(true);
    expect(result.messages.join('\n')).toContain('GitHub Issue');
  });
});

// -- per-project Atlassian URL ----------------------------------------------

describe('per-project Atlassian URL (jiraAuth)', () => {
  function writeMapping(
    dir: string,
    projectKey: string,
    atlassianUrl?: string,
  ): void {
    const mapping: Record<string, unknown> = {
      project_key: projectKey,
      source: 'jira',
      discovered_at: '2026-01-01T00:00:00+00:00',
      issue_types: [],
      semantic_roles: {
        qa_passed: { status_name: 'QA Passed', issue_type: 'Story' },
        in_qa: { status_name: 'In QA', issue_type: 'Story' },
      },
      role_annotations_confirmed: true,
    };
    if (atlassianUrl) mapping['atlassian_url'] = atlassianUrl;
    writeFileSync(
      join(dir, `workflow-${projectKey}.json`),
      JSON.stringify(mapping),
      'utf-8',
    );
  }

  it('stored url preferred over env var', () => {
    const dir = canaryDir();
    writeMapping(dir, 'ACME', 'https://acme.atlassian.net');
    process.env['ATLASSIAN_URL'] = 'https://wrong.atlassian.net';
    process.env['ATLASSIAN_USER'] = 'user@example.com';
    process.env['ATLASSIAN_TOKEN'] = 'token123';
    const [baseUrl] = jiraAuth('ACME', dir);
    expect(baseUrl).toBe('https://acme.atlassian.net');
  });

  it('env var used when no stored url', () => {
    const dir = canaryDir();
    writeMapping(dir, 'ACME');
    process.env['ATLASSIAN_URL'] = 'https://fallback.atlassian.net';
    process.env['ATLASSIAN_USER'] = 'user@example.com';
    process.env['ATLASSIAN_TOKEN'] = 'token123';
    const [baseUrl] = jiraAuth('ACME', dir);
    expect(baseUrl).toBe('https://fallback.atlassian.net');
  });

  it('two projects on different instances', () => {
    const dir = canaryDir();
    writeMapping(dir, 'INTERNAL', 'https://internal.atlassian.net');
    writeMapping(dir, 'CUSTOMER', 'https://customer.atlassian.net');
    process.env['ATLASSIAN_USER'] = 'user@example.com';
    process.env['ATLASSIAN_TOKEN'] = 'tok';
    delete process.env['ATLASSIAN_URL'];
    const [internal] = jiraAuth('INTERNAL', dir);
    const [customer] = jiraAuth('CUSTOMER', dir);
    expect(internal).toBe('https://internal.atlassian.net');
    expect(customer).toBe('https://customer.atlassian.net');
  });

  it('no project key falls back to env', () => {
    const dir = canaryDir();
    process.env['ATLASSIAN_URL'] = 'https://env.atlassian.net';
    process.env['ATLASSIAN_USER'] = 'user@example.com';
    process.env['ATLASSIAN_TOKEN'] = 'tok';
    const [baseUrl] = jiraAuth(null, dir);
    expect(baseUrl).toBe('https://env.atlassian.net');
  });

  it('returns [null, null] when credentials incomplete', () => {
    const dir = canaryDir();
    delete process.env['ATLASSIAN_URL'];
    delete process.env['ATLASSIAN_USER'];
    delete process.env['ATLASSIAN_TOKEN'];
    expect(jiraAuth('ACME', dir)).toEqual([null, null]);
  });
});

// -- workflow-init (static role config) -------------------------------------

describe('static workflow-init mapping', () => {
  it('hand-authored mapping is respected by transition logic', async () => {
    const dir = canaryDir();
    writeTransitionMapping(
      dir,
      'HAND',
      'Testing Complete',
      'https://hand.atlassian.net',
    );
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://hand.atlassian.net',
      'Basic dGVzdA==',
    ]);
    vi.spyOn(updater, 'jiraCurrentStatus').mockResolvedValue('In Testing');
    vi.spyOn(updater, 'jiraFindTransition').mockResolvedValue('99');

    const result = await updater.transitionJira('HAND-1', 'HAND', 'PASS', true);
    expect(result.attempted).toBe(true);
    expect(result.to_status).toBe('Testing Complete');
  });
});

// -- github comment surface (added coverage) --------------------------------

describe('postGithubComment', () => {
  it('dry-run short-circuits to true', () => {
    expect(new TicketUpdater().postGithubComment('o/r#1', 'body', true)).toBe(
      true,
    );
  });

  it('owner/repo#NNN invokes gh with --repo', () => {
    const calls: string[][] = [];
    const updater = new TicketUpdater(null, {
      subprocess: (cmd) => {
        calls.push(cmd);
        return { returncode: 0, stdout: '', stderr: '' };
      },
    });
    expect(updater.postGithubComment('o/r#5', 'hi', false)).toBe(true);
    expect(calls[0]).toEqual([
      'gh',
      'issue',
      'comment',
      '5',
      '--body',
      'hi',
      '--repo',
      'o/r',
    ]);
  });

  it('bare NNN invokes gh without --repo', () => {
    const updater = new TicketUpdater(null, {
      subprocess: () => ({ returncode: 0, stdout: '', stderr: '' }),
    });
    expect(updater.postGithubComment('7', 'hi', false)).toBe(true);
  });

  it('unparseable ref returns false', () => {
    expect(new TicketUpdater().postGithubComment('bad ref', 'b', false)).toBe(
      false,
    );
  });
});

// -- jira network helpers (added coverage) ----------------------------------

describe('jira network helpers', () => {
  function httpReturning(resp: {
    ok: boolean;
    status: number;
    text: string;
  }): HttpClient {
    return async () => resp;
  }

  it('jiraCurrentStatus returns the status name', async () => {
    const updater = new TicketUpdater(null, {
      http: httpReturning({
        ok: true,
        status: 200,
        text: JSON.stringify({ fields: { status: { name: 'In QA' } } }),
      }),
    });
    expect(await updater.jiraCurrentStatus('b', 'a', 'K-1')).toBe('In QA');
  });

  it('jiraCurrentStatus returns null on non-2xx', async () => {
    const updater = new TicketUpdater(null, {
      http: httpReturning({ ok: false, status: 404, text: '' }),
    });
    expect(await updater.jiraCurrentStatus('b', 'a', 'K-1')).toBeNull();
  });

  it('jiraCurrentStatus returns null when body throws', async () => {
    const updater = new TicketUpdater(null, {
      http: async () => {
        throw new Error('net');
      },
    });
    expect(await updater.jiraCurrentStatus('b', 'a', 'K-1')).toBeNull();
  });

  it('jiraFindTransition returns the matching transition id', async () => {
    const updater = new TicketUpdater(null, {
      http: httpReturning({
        ok: true,
        status: 200,
        text: JSON.stringify({
          transitions: [
            { id: '10', to: { name: 'Other' } },
            { id: '31', to: { name: 'qa passed' } },
          ],
        }),
      }),
    });
    // case-insensitive match against "QA Passed".
    expect(await updater.jiraFindTransition('b', 'a', 'K-1', 'QA Passed')).toBe(
      '31',
    );
  });

  it('jiraFindTransition returns null when none match', async () => {
    const updater = new TicketUpdater(null, {
      http: httpReturning({
        ok: true,
        status: 200,
        text: JSON.stringify({ transitions: [{ id: '1', to: { name: 'X' } }] }),
      }),
    });
    expect(
      await updater.jiraFindTransition('b', 'a', 'K-1', 'QA Passed'),
    ).toBeNull();
  });

  it('jiraFindTransition returns null on non-2xx', async () => {
    const updater = new TicketUpdater(null, {
      http: httpReturning({ ok: false, status: 500, text: '' }),
    });
    expect(
      await updater.jiraFindTransition('b', 'a', 'K-1', 'QA Passed'),
    ).toBeNull();
  });

  it('jiraDoTransition returns true on ok, false otherwise', async () => {
    const okUpdater = new TicketUpdater(null, {
      http: httpReturning({ ok: true, status: 204, text: '' }),
    });
    expect(await okUpdater.jiraDoTransition('b', 'a', 'K-1', '31')).toBe(true);

    const failUpdater = new TicketUpdater(null, {
      http: async () => {
        throw new Error('net');
      },
    });
    expect(await failUpdater.jiraDoTransition('b', 'a', 'K-1', '31')).toBe(
      false,
    );
  });

  it('postJiraComment posts and returns ok', async () => {
    const dir = canaryDir();
    process.env['ATLASSIAN_URL'] = 'https://j.example.com';
    process.env['ATLASSIAN_USER'] = 'u@example.com';
    process.env['ATLASSIAN_TOKEN'] = 't';
    const updater = new TicketUpdater(dir, {
      http: httpReturning({ ok: true, status: 201, text: '' }),
    });
    expect(await updater.postJiraComment('ACME-1', 'body', false)).toBe(true);
  });

  it('postJiraComment returns false without credentials', async () => {
    const dir = canaryDir();
    delete process.env['ATLASSIAN_URL'];
    delete process.env['ATLASSIAN_USER'];
    delete process.env['ATLASSIAN_TOKEN'];
    const updater = new TicketUpdater(dir);
    expect(await updater.postJiraComment('ACME-1', 'body', false)).toBe(false);
  });

  it('update posts a Jira comment on a live PASS run', async () => {
    const dir = canaryDir();
    writeTransitionMapping(dir, 'ACME', 'QA Passed');
    const updater = new TicketUpdater(dir);
    vi.spyOn(updater, 'postJiraComment').mockResolvedValue(true);
    vi.spyOn(updater, 'jiraAuth').mockReturnValue([
      'https://j.example.com',
      'Basic x',
    ]);
    vi.spyOn(updater, 'jiraCurrentStatus').mockResolvedValue('In QA');
    vi.spyOn(updater, 'jiraFindTransition').mockResolvedValue('31');
    vi.spyOn(updater, 'jiraDoTransition').mockResolvedValue(true);

    const result = await updater.update(
      makeSummary({
        ticket_key: 'ACME-1',
        project_key: 'ACME',
        linkage_source: 'frontmatter',
      }),
      { dryRun: false },
    );
    expect(result.comment_posted).toBe(true);
    expect(result.transition.succeeded).toBe(true);
  });
});
