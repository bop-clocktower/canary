/**
 * Tests for WorkflowDiscovery -- heuristics, schema round-trip, error paths.
 *
 * Ported from tests/unit/test_workflow_discovery.py (every case preserved),
 * plus additional coverage for the network/subprocess seams that the Python
 * tests exercise only through `patch("urllib.request.urlopen")`.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  atlassianUrlFor,
  CommandNotFoundError,
  defaultHttpClient,
  defaultSubprocess,
  IssueType,
  resolveRole,
  SemanticRole,
  StatusEntry,
  SubprocessTimeoutError,
  TransitionEntry,
  WorkflowDiscovery,
  WorkflowDiscoveryError,
  WorkflowMapping,
  type HttpClient,
  type HttpResponse,
  type SubprocessResult,
  type SubprocessRun,
} from '../src/core/workflow-discovery.js';

// -- helpers -----------------------------------------------------------------

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'wf-'));
}

function makeMapping(
  projectKey = 'TEST',
  opts: {
    source?: string;
    statuses?: [string, string, string][];
    transitions?: [string, string, string, string][];
    semanticRoles?: Record<string, { status_name: string; issue_type: string }>;
    confirmed?: boolean;
  } = {},
): WorkflowMapping {
  const statuses = opts.statuses ?? [
    ['1', 'Open', 'new'],
    ['3', 'In Progress', 'indeterminate'],
    ['5', 'QA', 'indeterminate'],
    ['6', 'QA Passed', 'indeterminate'],
    ['4', 'Done', 'done'],
  ];
  const transitions = opts.transitions ?? [];
  const issueTypes = [
    new IssueType(
      '10001',
      'Bug',
      statuses.map(([i, n, c]) => new StatusEntry(i, n, c)),
      transitions.map(([i, n, f, t]) => new TransitionEntry(i, n, f, t)),
    ),
  ];
  const roles: Record<string, SemanticRole> = {};
  for (const [r, v] of Object.entries(opts.semanticRoles ?? {})) {
    roles[r] = new SemanticRole(v.status_name, v.issue_type);
  }
  return new WorkflowMapping({
    project_key: projectKey,
    source: opts.source ?? 'jira',
    discovered_at: '2026-05-27T00:00:00+00:00',
    issue_types: issueTypes,
    semantic_roles: roles,
    role_annotations_confirmed: opts.confirmed ?? false,
  });
}

/** An HTTP fake that dispatches on the first URL fragment that matches. */
function routedHttp(
  routes: [string, unknown | (() => Promise<HttpResponse>)][],
): HttpClient {
  return async (req) => {
    for (const [frag, body] of routes) {
      if (req.url.includes(frag)) {
        if (typeof body === 'function') {
          return (body as () => Promise<HttpResponse>)();
        }
        return { ok: true, status: 200, text: JSON.stringify(body) };
      }
    }
    return { ok: true, status: 200, text: 'null' };
  };
}

const ENV_KEYS = ['ATLASSIAN_URL', 'ATLASSIAN_USER', 'ATLASSIAN_TOKEN'];
let envBackup: Record<string, string | undefined> = {};
const tmpDirs: string[] = [];

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
    const d = tmpDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = makeTmp();
  tmpDirs.push(d);
  return d;
}

function setCreds(): void {
  process.env['ATLASSIAN_URL'] = 'https://fake.atlassian.net';
  process.env['ATLASSIAN_USER'] = 'user@example.com';
  process.env['ATLASSIAN_TOKEN'] = 'token123';
}

// -- schema round-trip -------------------------------------------------------

describe('WorkflowMapping schema', () => {
  it('to_dict has $schema field', () => {
    const d = makeMapping().toDict();
    expect('$schema' in d).toBe(true);
    expect(String(d['$schema'])).toContain('workflow-mapping/v1');
  });

  it('to_dict and from_dict round-trip', () => {
    const original = makeMapping('TEST', {
      transitions: [['21', 'Start', 'Open', 'In Progress']],
      semanticRoles: {
        qa_passed: { status_name: 'QA Passed', issue_type: 'Bug' },
      },
      confirmed: true,
    });
    const d = original.toDict();
    const restored = WorkflowMapping.fromDict(d);

    expect(restored.project_key).toBe(original.project_key);
    expect(restored.source).toBe(original.source);
    expect(restored.issue_types.length).toBe(1);
    expect(restored.issue_types[0]!.statuses.length).toBe(5);
    expect(restored.issue_types[0]!.transitions.length).toBe(1);
    expect(restored.issue_types[0]!.transitions[0]!.from_status).toBe('Open');
    expect(restored.issue_types[0]!.transitions[0]!.to_status).toBe(
      'In Progress',
    );
    expect(restored.role_annotations_confirmed).toBe(true);
    expect('qa_passed' in restored.semantic_roles).toBe(true);
    expect(restored.semantic_roles['qa_passed']!.status_name).toBe('QA Passed');
  });

  it('to_json is valid JSON', () => {
    const raw = makeMapping().toJson();
    const parsed = JSON.parse(raw);
    expect(parsed.project_key).toBe('TEST');
  });

  it('from_dict tolerates missing transitions', () => {
    const d = makeMapping().toDict();
    (d['issue_types'] as Record<string, unknown>[])[0]!['transitions'] = [];
    const m = WorkflowMapping.fromDict(d);
    expect(m.issue_types[0]!.transitions).toEqual([]);
  });

  it('from_dict handles from/to aliases', () => {
    const d = {
      project_key: 'X',
      source: 'jira',
      discovered_at: '2026-01-01T00:00:00+00:00',
      issue_types: [
        {
          id: '1',
          name: 'Bug',
          statuses: [],
          transitions: [
            { id: '11', name: 'Start', from: 'Open', to: 'In Progress' },
          ],
        },
      ],
      semantic_roles: {},
      role_annotations_confirmed: false,
    };
    const m = WorkflowMapping.fromDict(d);
    expect(m.issue_types[0]!.transitions[0]!.from_status).toBe('Open');
    expect(m.issue_types[0]!.transitions[0]!.to_status).toBe('In Progress');
  });

  it('to_json preserves Python field order and ensure_ascii', () => {
    const m = makeMapping('T', {
      statuses: [['1', 'Q\u00e9A', 'indeterminate']],
    });
    const raw = m.toJson();
    // ensure_ascii escapes the non-ASCII code point.
    expect(raw).toContain('Q\\u00e9A');
    // Key order: $schema first, role_annotations_confirmed before any tail.
    const keys = Object.keys(m.toDict());
    expect(keys).toEqual([
      '$schema',
      'project_key',
      'source',
      'discovered_at',
      'issue_types',
      'semantic_roles',
      'role_annotations_confirmed',
    ]);
  });

  it('atlassian_url is appended last only when present', () => {
    const m = makeMapping('T');
    m.atlassian_url = 'https://x.atlassian.net';
    const keys = Object.keys(m.toDict());
    expect(keys[keys.length - 1]).toBe('atlassian_url');
  });
});

// -- persistence -------------------------------------------------------------

describe('WorkflowDiscovery persistence', () => {
  it('write and load round-trip', () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    wd.write(makeMapping('PROJ'));
    expect(() => statSync(join(d, 'workflow-PROJ.json'))).not.toThrow();
    const loaded = wd.loadCached('PROJ');
    expect(loaded).not.toBeNull();
    expect(loaded!.project_key).toBe('PROJ');
  });

  it('load_cached returns null when missing', () => {
    expect(new WorkflowDiscovery(tmp()).loadCached('NOEXIST')).toBeNull();
  });

  it('load_cached returns null for corrupt file', () => {
    const d = tmp();
    writeFileSync(join(d, 'workflow-BAD.json'), 'not valid json', 'utf-8');
    expect(new WorkflowDiscovery(d).loadCached('BAD')).toBeNull();
  });

  it('load_cached returns null when required key missing', () => {
    const d = tmp();
    writeFileSync(join(d, 'workflow-NOKEY.json'), '{"source":"jira"}', 'utf-8');
    expect(new WorkflowDiscovery(d).loadCached('NOKEY')).toBeNull();
  });

  it('mapping_path sanitises slash in key', () => {
    const wd = new WorkflowDiscovery(tmp());
    const path = wd.mappingPath('owner/repo');
    expect(path).not.toContain('/owner/');
    expect(path).toContain('workflow-');
  });

  // Regression (adversarial review F2): Python builds StatusEntry(**s) /
  // SemanticRole(**sr_d); **-unpacking raises TypeError on a missing key, which
  // _load_cached catches -> returns null. A cache whose status/role is missing a
  // required field must therefore REJECT (re-discover), never resolve a partial
  // role and drive a state-changing Jira transition off stale data.
  it('load_cached returns null when a status entry is missing a field', () => {
    const d = tmp();
    // valid top-level keys, but a status entry omits `category`.
    const mapping = {
      project_key: 'BADSTATUS',
      source: 'jira',
      discovered_at: '2026-01-01T00:00:00+00:00',
      issue_types: [
        {
          id: '1',
          name: 'Story',
          statuses: [{ id: '10', name: 'In QA' }],
          transitions: [],
        },
      ],
      semantic_roles: {},
      role_annotations_confirmed: true,
    };
    writeFileSync(
      join(d, 'workflow-BADSTATUS.json'),
      JSON.stringify(mapping),
      'utf-8',
    );
    expect(new WorkflowDiscovery(d).loadCached('BADSTATUS')).toBeNull();
  });

  it('load_cached returns null when a semantic role is missing a field', () => {
    const d = tmp();
    const mapping = {
      project_key: 'BADROLE',
      source: 'jira',
      discovered_at: '2026-01-01T00:00:00+00:00',
      issue_types: [],
      semantic_roles: { qa_passed: { status_name: 'Done' } }, // no issue_type
      role_annotations_confirmed: true,
    };
    writeFileSync(
      join(d, 'workflow-BADROLE.json'),
      JSON.stringify(mapping),
      'utf-8',
    );
    expect(new WorkflowDiscovery(d).loadCached('BADROLE')).toBeNull();
  });

  // Regression (adversarial review F6): Python re.sub over code points maps an
  // astral char to ONE `_`; the port must too (the `u` flag), else a surrogate
  // pair becomes two `_` and the cache filename diverges.
  it('mapping_path replaces an astral char with a single underscore', () => {
    const wd = new WorkflowDiscovery(tmp());
    // U+1F3AF is two UTF-16 units but one code point -> exactly one `_`.
    const path = wd.mappingPath('\u{1F3AF}');
    expect(path).toContain('workflow-_.json');
    expect(path).not.toContain('workflow-__.json');
  });

  it('discover skips write in dry-run', async () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    wd.write(makeMapping('DRY'));
    const before = statSync(wd.mappingPath('DRY')).mtimeMs;
    vi.spyOn(wd, 'fetchJira').mockResolvedValue(makeMapping('DRY'));
    await new Promise((r) => setTimeout(r, 5));
    await wd.discover('DRY', { refresh: true, dryRun: true });
    const after = statSync(wd.mappingPath('DRY')).mtimeMs;
    expect(after).toBe(before);
  });
});

// -- heuristics --------------------------------------------------------------

describe('semantic-role heuristics', () => {
  function discoverFresh(
    statuses: [string, string, string][],
  ): WorkflowMapping {
    const m = makeMapping('TEST', { statuses });
    return new WorkflowDiscovery().applyHeuristics(m);
  }

  it('qa_passed detected by name', () => {
    const m = discoverFresh([
      ['1', 'Open', 'new'],
      ['2', 'QA Passed', 'indeterminate'],
      ['3', 'Done', 'done'],
    ]);
    expect('qa_passed' in m.semantic_roles).toBe(true);
    expect(m.semantic_roles['qa_passed']!.status_name).toBe('QA Passed');
  });

  it('ready_to_deploy detected from Done', () => {
    const m = discoverFresh([
      ['1', 'Open', 'new'],
      ['2', 'Done', 'done'],
    ]);
    expect('ready_to_deploy' in m.semantic_roles).toBe(true);
    expect(m.semantic_roles['ready_to_deploy']!.status_name).toBe('Done');
  });

  it('in_review detected', () => {
    const m = discoverFresh([
      ['1', 'Open', 'new'],
      ['2', 'In Review', 'indeterminate'],
    ]);
    expect('in_review' in m.semantic_roles).toBe(true);
  });

  it('in_qa detected', () => {
    const m = discoverFresh([['1', 'QA', 'indeterminate']]);
    expect('in_qa' in m.semantic_roles).toBe(true);
  });

  it('in_progress detected', () => {
    const m = discoverFresh([['1', 'In Progress', 'indeterminate']]);
    expect('in_progress' in m.semantic_roles).toBe(true);
  });

  it('blocked detected', () => {
    const m = discoverFresh([['1', 'Blocked', 'indeterminate']]);
    expect('blocked' in m.semantic_roles).toBe(true);
  });

  it('no match leaves role unset', () => {
    const m = discoverFresh([['1', 'Unicorn Status', 'indeterminate']]);
    expect('qa_passed' in m.semantic_roles).toBe(false);
  });

  it('existing role not overwritten', () => {
    const m = makeMapping('TEST', {
      statuses: [
        ['1', 'QA Passed', 'indeterminate'],
        ['2', 'Done', 'done'],
      ],
      semanticRoles: {
        qa_passed: { status_name: 'Custom', issue_type: 'Bug' },
      },
    });
    const result = new WorkflowDiscovery().applyHeuristics(m);
    expect(result.semantic_roles['qa_passed']!.status_name).toBe('Custom');
  });

  it('case-insensitive matching', () => {
    const m = discoverFresh([['1', 'QA PASSED', 'indeterminate']]);
    expect('qa_passed' in m.semantic_roles).toBe(true);
  });

  it('qa_passed set independently of ready_to_deploy', () => {
    const m = discoverFresh([
      ['1', 'QA Passed', 'indeterminate'],
      ['2', 'Done', 'done'],
    ]);
    expect(m.semantic_roles['qa_passed']!.status_name).toBe('QA Passed');
    expect(m.semantic_roles['ready_to_deploy']!.status_name).toBe('Done');
  });
});

// -- resolveRole -------------------------------------------------------------

describe('resolveRole', () => {
  it('returns status name', () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    wd.write(
      makeMapping('R', {
        semanticRoles: {
          qa_passed: { status_name: 'QA Passed', issue_type: 'Bug' },
        },
        confirmed: true,
      }),
    );
    expect(wd.resolveRole('R', 'qa_passed')).toBe('QA Passed');
  });

  it('returns null when mapping missing', () => {
    expect(
      new WorkflowDiscovery(tmp()).resolveRole('MISSING', 'qa_passed'),
    ).toBeNull();
  });

  it('returns null for unset role', () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    wd.write(makeMapping('S'));
    expect(wd.resolveRole('S', 'nonexistent_role')).toBeNull();
  });

  it('module-level resolveRole', () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    wd.write(
      makeMapping('MOD', {
        semanticRoles: {
          ready_to_deploy: { status_name: 'Done', issue_type: 'Bug' },
        },
      }),
    );
    expect(resolveRole('MOD', 'ready_to_deploy', d)).toBe('Done');
  });
});

// -- discover: cache-first ---------------------------------------------------

describe('discover cache-first', () => {
  it('returns cached without network call', async () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    wd.write(makeMapping('CACHED'));
    const spy = vi.spyOn(wd, 'fetchJira');
    const result = await wd.discover('CACHED');
    expect(spy).not.toHaveBeenCalled();
    expect(result.project_key).toBe('CACHED');
  });

  it('refresh calls fetch', async () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    wd.write(makeMapping('REFRESH'));
    const spy = vi
      .spyOn(wd, 'fetchJira')
      .mockResolvedValue(makeMapping('REFRESH'));
    await wd.discover('REFRESH', { refresh: true });
    expect(spy).toHaveBeenCalledWith('REFRESH');
  });

  it('missing cache calls fetch', async () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    vi.spyOn(wd, 'fetchJira').mockResolvedValue(makeMapping('NEW'));
    const result = await wd.discover('NEW');
    expect(result.project_key).toBe('NEW');
    expect(wd.loadCached('NEW')).not.toBeNull();
  });

  it('github repo routes to fetchGithub', async () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    const spy = vi
      .spyOn(wd, 'fetchGithub')
      .mockResolvedValue(makeMapping('owner/repo', { source: 'github' }));
    await wd.discover('owner/repo');
    expect(spy).toHaveBeenCalledWith('owner/repo');
  });

  it('refresh preserves confirmed roles', async () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    wd.write(
      makeMapping('PRES', {
        semanticRoles: {
          qa_passed: { status_name: 'Verified', issue_type: 'Bug' },
        },
        confirmed: true,
      }),
    );
    vi.spyOn(wd, 'fetchJira').mockResolvedValue(makeMapping('PRES'));
    const result = await wd.discover('PRES', { refresh: true });
    expect(result.semantic_roles['qa_passed']!.status_name).toBe('Verified');
  });
});

// -- Jira error paths --------------------------------------------------------

describe('Jira error paths', () => {
  it('missing credentials raises error', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const wd = new WorkflowDiscovery(tmp());
    await expect(wd.fetchJira('NOENV')).rejects.toThrow(/ATLASSIAN_URL/);
    await expect(wd.fetchJira('NOENV')).rejects.toBeInstanceOf(
      WorkflowDiscoveryError,
    );
  });

  it('http error raises WorkflowDiscoveryError', async () => {
    setCreds();
    const http: HttpClient = async () => ({
      ok: false,
      status: 404,
      text: '{"errorMessages": ["Project not found"]}',
    });
    const wd = new WorkflowDiscovery(tmp(), { http });
    await expect(wd.fetchJira('BAD')).rejects.toBeInstanceOf(
      WorkflowDiscoveryError,
    );
  });

  it('network error raises WorkflowDiscoveryError', async () => {
    setCreds();
    const http: HttpClient = async () => {
      throw new Error('connection refused');
    };
    const wd = new WorkflowDiscovery(tmp(), { http });
    await expect(wd.fetchJira('NET')).rejects.toThrow(/Network error/);
  });

  it('errorMessages in a 200 response raises error', async () => {
    setCreds();
    const http: HttpClient = async () => ({
      ok: true,
      status: 200,
      text: JSON.stringify({
        errorMessages: ["No project could be found with key 'X'"],
      }),
    });
    const wd = new WorkflowDiscovery(tmp(), { http });
    await expect(wd.fetchJira('X')).rejects.toThrow(
      /not found or access denied/,
    );
  });
});

// -- parseStatuses -----------------------------------------------------------

describe('parseStatuses', () => {
  const wd = new WorkflowDiscovery();

  it('matches issue type by name', () => {
    const raw = [
      {
        name: 'Bug',
        statuses: [
          { id: '1', name: 'Open', statusCategory: { key: 'new' } },
          { id: '2', name: 'Done', statusCategory: { key: 'done' } },
        ],
      },
      {
        name: 'Story',
        statuses: [
          {
            id: '3',
            name: 'In Progress',
            statusCategory: { key: 'indeterminate' },
          },
        ],
      },
    ];
    const result = wd.parseStatuses(raw, 'Bug');
    expect(result.length).toBe(2);
    expect(result[0]!.name).toBe('Open');
    expect(result[0]!.category).toBe('new');
  });

  it('falls back to all when no match', () => {
    const raw = [
      {
        name: 'OtherType',
        statuses: [
          { id: '1', name: 'Open', statusCategory: { key: 'new' } },
          { id: '2', name: 'Closed', statusCategory: { key: 'done' } },
        ],
      },
    ];
    expect(wd.parseStatuses(raw, 'Bug').length).toBe(2);
  });

  it('deduplicates on fallback', () => {
    const raw = [
      {
        name: 'T1',
        statuses: [{ id: '1', name: 'Open', statusCategory: { key: 'new' } }],
      },
      {
        name: 'T2',
        statuses: [{ id: '1', name: 'Open', statusCategory: { key: 'new' } }],
      },
    ];
    const names = wd.parseStatuses(raw, 'Unmatched').map((s) => s.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('returns empty for non-list input', () => {
    expect(wd.parseStatuses({ not: 'a list' }, 'Bug')).toEqual([]);
  });
});

// -- show --------------------------------------------------------------------

describe('show', () => {
  it('returns mapping when cached', () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    wd.write(makeMapping('SHOW'));
    const result = wd.show('SHOW');
    expect(result).not.toBeNull();
    expect(result!.project_key).toBe('SHOW');
  });

  it('returns null when not cached', () => {
    expect(new WorkflowDiscovery(tmp()).show('GHOST')).toBeNull();
  });
});

// -- fetchJira happy path + sampleTransitions (added coverage) ---------------

describe('fetchJira happy path', () => {
  it('assembles issue types with statuses and sampled transitions', async () => {
    setCreds();
    const http = routedHttp([
      ['issuetypes', [{ id: '1', name: 'Bug' }]],
      [
        'statuses',
        [
          {
            name: 'Bug',
            statuses: [
              { id: '1', name: 'Open', statusCategory: { key: 'new' } },
              {
                id: '2',
                name: 'QA Passed',
                statusCategory: { key: 'indeterminate' },
              },
            ],
          },
        ],
      ],
      ['issue/search', { issues: [{ key: 'BUG-1' }] }],
      [
        'BUG-1/transitions',
        {
          transitions: [
            {
              id: '31',
              name: 'QA Pass',
              from: { name: 'Open' },
              to: { name: 'QA Passed' },
            },
          ],
        },
      ],
    ]);
    const wd = new WorkflowDiscovery(tmp(), { http });
    const mapping = await wd.fetchJira('PROJ');
    expect(mapping.source).toBe('jira');
    expect(mapping.atlassian_url).toBe('https://fake.atlassian.net');
    expect(mapping.issue_types.length).toBe(1);
    const it = mapping.issue_types[0]!;
    expect(it.name).toBe('Bug');
    expect(it.statuses.map((s) => s.name)).toEqual(['Open', 'QA Passed']);
    expect(it.transitions[0]!.from_status).toBe('Open');
    expect(it.transitions[0]!.to_status).toBe('QA Passed');
  });

  it('skips unnamed issue types and trailing slash on URL', async () => {
    setCreds();
    process.env['ATLASSIAN_URL'] = 'https://fake.atlassian.net/';
    const http = routedHttp([['issuetypes', [{ id: '9', name: '' }]]]);
    const wd = new WorkflowDiscovery(tmp(), { http });
    const mapping = await wd.fetchJira('PROJ');
    expect(mapping.issue_types).toEqual([]);
    expect(mapping.atlassian_url).toBe('https://fake.atlassian.net');
  });

  it('sampleTransitions returns [] when no issues', async () => {
    const http = routedHttp([['search', { issues: [] }]]);
    const wd = new WorkflowDiscovery(tmp(), { http });
    expect(await wd.sampleTransitions('b', {}, 'P', 'Bug')).toEqual([]);
  });

  it('sampleTransitions returns [] when issue has no key', async () => {
    const http = routedHttp([['search', { issues: [{}] }]]);
    const wd = new WorkflowDiscovery(tmp(), { http });
    expect(await wd.sampleTransitions('b', {}, 'P', 'Bug')).toEqual([]);
  });

  it('sampleTransitions returns [] when search throws', async () => {
    const http: HttpClient = async () => {
      throw new Error('boom');
    };
    const wd = new WorkflowDiscovery(tmp(), { http });
    expect(await wd.sampleTransitions('b', {}, 'P', 'Bug')).toEqual([]);
  });

  it('sampleTransitions returns [] when transitions call throws', async () => {
    let call = 0;
    const http: HttpClient = async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ issues: [{ key: 'K-1' }] }),
        };
      }
      throw new Error('boom');
    };
    const wd = new WorkflowDiscovery(tmp(), { http });
    expect(await wd.sampleTransitions('b', {}, 'P', 'Bug')).toEqual([]);
  });

  it('jiraGet raises on non-2xx with truncated body by code point', async () => {
    const http: HttpClient = async () => ({
      ok: false,
      status: 500,
      text: 'x'.repeat(500),
    });
    const wd = new WorkflowDiscovery(tmp(), { http });
    await expect(wd.jiraGet('http://h/', {})).rejects.toThrow(
      /Jira API error 500/,
    );
  });
});

// -- fetchGithub (added coverage) --------------------------------------------

function fakeSub(handler: (cmd: string[]) => SubprocessResult): SubprocessRun {
  return (cmd) => handler(cmd);
}

describe('fetchGithub', () => {
  it('raises when gh is not installed', async () => {
    const subprocess: SubprocessRun = () => {
      throw new CommandNotFoundError('gh');
    };
    const wd = new WorkflowDiscovery(tmp(), { subprocess });
    await expect(wd.fetchGithub('o/r')).rejects.toThrow(/GitHub CLI/);
  });

  it('synthesizes open/closed mapping when no project board', async () => {
    const subprocess = fakeSub(() => ({
      returncode: 1,
      stdout: '',
      stderr: '',
    }));
    const wd = new WorkflowDiscovery(tmp(), { subprocess });
    const m = await wd.fetchGithub('o/r');
    expect(m.source).toBe('github');
    expect(m.issue_types[0]!.statuses.map((s) => s.name)).toEqual([
      'Open',
      'Closed',
    ]);
  });

  it('maps project columns to statuses with done detection', async () => {
    const subprocess = fakeSub((cmd) => {
      if (cmd.includes('repos/o/r/projects')) {
        return { returncode: 0, stdout: 'https://cols\n', stderr: '' };
      }
      return {
        returncode: 0,
        stdout: JSON.stringify([
          { id: '1', name: 'To Do' },
          { id: '2', name: 'Merged' },
        ]),
        stderr: '',
      };
    });
    const wd = new WorkflowDiscovery(tmp(), { subprocess });
    const m = await wd.fetchGithub('o/r');
    const st = m.issue_types[0]!.statuses;
    expect(st[0]!.category).toBe('indeterminate');
    expect(st[1]!.category).toBe('done');
  });

  it('raises when the columns call times out', async () => {
    const subprocess = fakeSub((cmd) => {
      if (cmd.includes('repos/o/r/projects')) {
        return { returncode: 0, stdout: 'https://cols', stderr: '' };
      }
      throw new SubprocessTimeoutError('timeout');
    });
    const wd = new WorkflowDiscovery(tmp(), { subprocess });
    await expect(wd.fetchGithub('o/r')).rejects.toThrow(/timed out/);
  });

  it('uses [] columns when the second call fails', async () => {
    const subprocess = fakeSub((cmd) => {
      if (cmd.includes('repos/o/r/projects')) {
        return { returncode: 0, stdout: 'https://cols', stderr: '' };
      }
      return { returncode: 1, stdout: '', stderr: 'err' };
    });
    const wd = new WorkflowDiscovery(tmp(), { subprocess });
    const m = await wd.fetchGithub('o/r');
    expect(m.issue_types[0]!.statuses).toEqual([]);
  });

  it('discover persists a github mapping end to end', async () => {
    const subprocess = fakeSub(() => ({
      returncode: 1,
      stdout: '',
      stderr: '',
    }));
    const d = tmp();
    const wd = new WorkflowDiscovery(d, { subprocess });
    const m = await wd.discover('o/r');
    expect(m.source).toBe('github');
    expect(wd.loadCached('o/r')).not.toBeNull();
  });
});

// -- atlassianUrlFor ---------------------------------------------------------

describe('atlassianUrlFor', () => {
  it('returns stored url or null', () => {
    const d = tmp();
    const wd = new WorkflowDiscovery(d);
    const m = makeMapping('AU');
    m.atlassian_url = 'https://au.atlassian.net';
    wd.write(m);
    expect(atlassianUrlFor('AU', d)).toBe('https://au.atlassian.net');
    expect(atlassianUrlFor('MISSING', d)).toBeNull();
  });
});

// -- default seams -----------------------------------------------------------

describe('default seams', () => {
  it('defaultHttpClient maps a fetch Response', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => 'hello',
    })) as unknown as typeof fetch;
    try {
      const resp = await defaultHttpClient({
        url: 'http://x/',
        method: 'POST',
        headers: { A: 'b' },
        body: 'p',
      });
      expect(resp).toEqual({ ok: true, status: 200, text: 'hello' });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('defaultSubprocess captures stdout and exit code', () => {
    const r = defaultSubprocess([
      process.execPath,
      '-e',
      'process.stdout.write("hi")',
    ]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toBe('hi');
  });

  it('defaultSubprocess surfaces a nonzero exit', () => {
    const r = defaultSubprocess([process.execPath, '-e', 'process.exit(3)']);
    expect(r.returncode).toBe(3);
  });

  it('defaultSubprocess throws CommandNotFoundError for a missing binary', () => {
    expect(() =>
      defaultSubprocess(['definitely-not-a-real-binary-xyz-123']),
    ).toThrow(CommandNotFoundError);
  });
});
