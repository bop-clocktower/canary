/**
 * Workflow Discovery -- discovers per-project Jira / GitHub issue workflows
 * and persists the mapping to `.canary/workflow-<key>.json`.
 *
 * Faithful TypeScript port of `agent/core/workflow_discovery.py`.
 *
 * Canary never hardcodes Jira status names or GitHub board columns. Instead, it
 * calls `resolveRole()` which looks up the persisted mapping. If the mapping is
 * missing, `WorkflowDiscovery.discover()` must be called first.
 *
 * Jira REST API is called directly using credentials from the environment
 * (`ATLASSIAN_URL`, `ATLASSIAN_USER`, `ATLASSIAN_TOKEN`). GitHub Projects v2 is
 * called via the `gh` CLI. Both are optional.
 *
 * Python->TS nuances:
 *   - **subprocess -> child_process**: Python `subprocess.run(cmd, ...)` maps to
 *     Node's `spawnSync(cmd[0], cmd.slice(1), { maxBuffer: Infinity })`. Node's
 *     1 MiB default `maxBuffer` differs from Python (unbounded), so it is
 *     lifted. FileNotFoundError/TimeoutExpired become {@link CommandNotFoundError}
 *     / {@link SubprocessTimeoutError}.
 *   - **urllib -> fetch seam**: Python's synchronous `urllib.request.urlopen`
 *     has no Node analog; the HTTP calls are modelled through an injectable
 *     async {@link HttpClient} (default {@link defaultHttpClient} over global
 *     `fetch`), mirroring how `guardian/hard-gate.ts` injects its REST client.
 *     A non-2xx response reproduces Python's `HTTPError` branch; a rejected
 *     fetch reproduces the `URLError` branch.
 *   - **JSON shape is a contract.** `toJson()` mirrors `json.dumps(indent=2)`
 *     with the library-default `ensure_ascii=True` reproduced via
 *     {@link ensureAscii}. Object key insertion order preserves Python's field
 *     order exactly (see {@link WorkflowMapping.toDict}).
 *   - **Python truthiness** (`""`/`[]`/`{}`/`None` falsy) via {@link pyTruthy};
 *     missing dict keys via {@link pyGet}.
 *   - **String slicing by code point**: `body[:200]` uses `[...s]` so an astral
 *     character in an error body is never split mid-surrogate.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureAscii } from '../util/ensure-ascii.js';

// ---------------------------------------------------------------------------
// Python-compatibility helpers (copied locally per-module, matching reporter.ts)
// ---------------------------------------------------------------------------

/**
 * Python-truthiness for JSON-shaped values: `None`/`undefined`, `false`, `0`,
 * `""`, empty array, and empty object are all falsy (mirrors `if x:`).
 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `dict.get(key, default)`: default only on a missing key. */
function pyGet(
  obj: Record<string, unknown>,
  key: string,
  fallback: unknown,
): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/** Python `str[:n]` by CODE POINT (never splits a surrogate pair). */
function codePointSlice(s: string, n: number): string {
  return [...s].slice(0, n).join('');
}

/** Python `str.rstrip(ch)` -- remove all trailing runs of `ch`. */
function rstripChar(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}

// ---------------------------------------------------------------------------
// HTTP + subprocess seams
// ---------------------------------------------------------------------------

/** A single HTTP request (Python `urllib.request.Request`). */
export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number; // seconds (informational; matches Python's timeout arg)
}

/** A read HTTP response (body already consumed). */
export interface HttpResponse {
  ok: boolean; // status in [200, 300)
  status: number;
  text: string;
}

/** Injectable HTTP transport. A rejected promise models Python's `URLError`. */
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

/** Result of a subprocess run (Python `subprocess.CompletedProcess`). */
export interface SubprocessResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

/** Injectable subprocess runner (Python `subprocess.run`). */
export type SubprocessRun = (
  cmd: string[],
  opts?: { timeout?: number },
) => SubprocessResult;

/** Analog of Python `FileNotFoundError` for a missing executable. */
export class CommandNotFoundError extends Error {}

/** Analog of Python `subprocess.TimeoutExpired`. */
export class SubprocessTimeoutError extends Error {}

/** Default HTTP transport over global `fetch`. */
export const defaultHttpClient: HttpClient = async (req) => {
  const init: RequestInit = { method: req.method ?? 'GET' };
  if (req.headers !== undefined) init.headers = req.headers;
  if (req.body !== undefined) init.body = req.body;
  const resp = await fetch(req.url, init);
  return { ok: resp.ok, status: resp.status, text: await resp.text() };
};

/** Default subprocess runner over `spawnSync` with an unbounded output buffer. */
export const defaultSubprocess: SubprocessRun = (cmd, opts = {}) => {
  const result = spawnSync(cmd[0]!, cmd.slice(1), {
    encoding: 'utf-8',
    timeout: opts.timeout !== undefined ? opts.timeout * 1000 : undefined,
    // Python's subprocess.run has no output ceiling; Node defaults maxBuffer to
    // 1 MiB and kills the child on overflow. Remove the cap for parity.
    maxBuffer: Infinity,
  });
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new CommandNotFoundError(err.message);
    }
    if (err.code === 'ETIMEDOUT') {
      throw new SubprocessTimeoutError(err.message);
    }
    throw err;
  }
  return {
    returncode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/** Seams injected into {@link WorkflowDiscovery}. */
export interface WorkflowDiscoveryDeps {
  http?: HttpClient;
  subprocess?: SubprocessRun;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_VERSION =
  'https://github.com/bop-clocktower/canary/schemas/workflow-mapping/v1';

// Word-list used for automatic semantic-role heuristics.
const ROLE_TRIGGERS: Record<string, string[]> = {
  qa_passed: ['qa pass', 'qa passed', 'qa done', 'tested', 'verified'],
  ready_to_deploy: ['deploy', 'release', 'ship', 'done', 'closed', 'merged'],
  in_review: ['review', 'pr open', 'code review', 'awaiting review'],
  in_qa: ['qa', 'testing', 'in test', 'in qa'],
  in_progress: ['progress', 'active', 'started', 'in development'],
  blocked: ['blocked', 'on hold', 'waiting'],
};

// Priority order when resolving ambiguous matches (earlier = higher priority).
const ROLE_PRIORITY = [
  'qa_passed',
  'ready_to_deploy',
  'in_qa',
  'in_review',
  'in_progress',
  'blocked',
];

/** Python: `StatusEntry` dataclass. */
export class StatusEntry {
  id: string;
  name: string;
  category: string; // "new" | "indeterminate" | "done"

  constructor(id: string, name: string, category: string) {
    this.id = id;
    this.name = name;
    this.category = category;
  }
}

/** Python: `TransitionEntry` dataclass. */
export class TransitionEntry {
  id: string;
  name: string;
  from_status: string;
  to_status: string;

  constructor(id: string, name: string, fromStatus: string, toStatus: string) {
    this.id = id;
    this.name = name;
    this.from_status = fromStatus;
    this.to_status = toStatus;
  }
}

/** Python: `IssueType` dataclass. */
export class IssueType {
  id: string;
  name: string;
  statuses: StatusEntry[];
  transitions: TransitionEntry[];

  constructor(
    id: string,
    name: string,
    statuses: StatusEntry[] = [],
    transitions: TransitionEntry[] = [],
  ) {
    this.id = id;
    this.name = name;
    this.statuses = statuses;
    this.transitions = transitions;
  }
}

/** Python: `SemanticRole` dataclass. */
export class SemanticRole {
  status_name: string;
  issue_type: string;

  constructor(statusName: string, issueType: string) {
    this.status_name = statusName;
    this.issue_type = issueType;
  }
}

/** Python: `WorkflowMapping` dataclass + (de)serialisation. */
export class WorkflowMapping {
  project_key: string;
  source: string; // "jira" | "github"
  discovered_at: string;
  issue_types: IssueType[];
  semantic_roles: Record<string, SemanticRole>;
  role_annotations_confirmed: boolean;
  atlassian_url: string | null; // per-project Jira base URL; overrides env

  constructor(init: {
    project_key: string;
    source: string;
    discovered_at: string;
    issue_types?: IssueType[];
    semantic_roles?: Record<string, SemanticRole>;
    role_annotations_confirmed?: boolean;
    atlassian_url?: string | null;
  }) {
    this.project_key = init.project_key;
    this.source = init.source;
    this.discovered_at = init.discovered_at;
    this.issue_types = init.issue_types ?? [];
    this.semantic_roles = init.semantic_roles ?? {};
    this.role_annotations_confirmed = init.role_annotations_confirmed ?? false;
    this.atlassian_url = init.atlassian_url ?? null;
  }

  /** Python: `WorkflowMapping.to_dict`. Key insertion order is a contract. */
  toDict(): Record<string, unknown> {
    const d: Record<string, unknown> = {
      $schema: SCHEMA_VERSION,
      project_key: this.project_key,
      source: this.source,
      discovered_at: this.discovered_at,
      issue_types: [] as unknown[],
      semantic_roles: {} as Record<string, unknown>,
      role_annotations_confirmed: this.role_annotations_confirmed,
    };
    // atlassian_url is appended LAST, only when truthy (Python `if self.atlassian_url`).
    if (pyTruthy(this.atlassian_url)) {
      d['atlassian_url'] = this.atlassian_url;
    }
    const issueTypes = d['issue_types'] as unknown[];
    for (const it of this.issue_types) {
      issueTypes.push({
        id: it.id,
        name: it.name,
        statuses: it.statuses.map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
        })),
        transitions: it.transitions.map((t) => ({
          id: t.id,
          name: t.name,
          from: t.from_status,
          to: t.to_status,
        })),
      });
    }
    const roles = d['semantic_roles'] as Record<string, unknown>;
    for (const [role, sr] of Object.entries(this.semantic_roles)) {
      roles[role] = { status_name: sr.status_name, issue_type: sr.issue_type };
    }
    return d;
  }

  /** Python: `WorkflowMapping.to_json`. */
  toJson(indent = 2): string {
    return ensureAscii(JSON.stringify(this.toDict(), null, indent));
  }

  /** Python: `WorkflowMapping.from_dict`. Throws on a malformed shape (KeyError). */
  static fromDict(data: Record<string, unknown>): WorkflowMapping {
    if (!Object.prototype.hasOwnProperty.call(data, 'project_key')) {
      throw new Error("missing key 'project_key'");
    }
    const issueTypes: IssueType[] = [];
    const rawIssueTypes = pyGet(data, 'issue_types', []) as Record<
      string,
      unknown
    >[];
    for (const itD of rawIssueTypes) {
      const statuses = (
        pyGet(itD, 'statuses', []) as Record<string, unknown>[]
      ).map((s) => {
        // Python builds StatusEntry(**s); **-unpacking raises TypeError on a
        // missing key, which _load_cached catches -> returns null. Mirror that
        // so a malformed cache is REJECTED (re-discovered from Jira) rather than
        // served with undefined fields, which would let resolveRole proceed to a
        // real state-changing Jira transition.
        if (
          !Object.prototype.hasOwnProperty.call(s, 'id') ||
          !Object.prototype.hasOwnProperty.call(s, 'name') ||
          !Object.prototype.hasOwnProperty.call(s, 'category')
        ) {
          throw new Error('malformed status entry');
        }
        return new StatusEntry(
          s['id'] as string,
          s['name'] as string,
          s['category'] as string,
        );
      });
      const transitions = (
        pyGet(itD, 'transitions', []) as Record<string, unknown>[]
      ).map((t) => {
        if (
          !Object.prototype.hasOwnProperty.call(t, 'id') ||
          !Object.prototype.hasOwnProperty.call(t, 'name')
        ) {
          throw new Error('malformed transition');
        }
        return new TransitionEntry(
          t['id'] as string,
          t['name'] as string,
          pyGet(t, 'from', pyGet(t, 'from_status', '')) as string,
          pyGet(t, 'to', pyGet(t, 'to_status', '')) as string,
        );
      });
      if (
        !Object.prototype.hasOwnProperty.call(itD, 'id') ||
        !Object.prototype.hasOwnProperty.call(itD, 'name')
      ) {
        throw new Error('malformed issue type');
      }
      issueTypes.push(
        new IssueType(
          itD['id'] as string,
          itD['name'] as string,
          statuses,
          transitions,
        ),
      );
    }
    const semanticRoles: Record<string, SemanticRole> = {};
    const rawRoles = pyGet(data, 'semantic_roles', {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [role, srD] of Object.entries(rawRoles)) {
      // Python SemanticRole(**sr_d) raises TypeError on a missing key ->
      // _load_cached returns null. Mirror it so a role missing status_name/
      // issue_type rejects the whole cache instead of resolving to a partial
      // role and attempting a state-changing transition.
      if (
        !Object.prototype.hasOwnProperty.call(srD, 'status_name') ||
        !Object.prototype.hasOwnProperty.call(srD, 'issue_type')
      ) {
        throw new Error('malformed semantic role');
      }
      semanticRoles[role] = new SemanticRole(
        srD['status_name'] as string,
        srD['issue_type'] as string,
      );
    }
    return new WorkflowMapping({
      project_key: data['project_key'] as string,
      source: pyGet(data, 'source', 'jira') as string,
      discovered_at: pyGet(data, 'discovered_at', '') as string,
      issue_types: issueTypes,
      semantic_roles: semanticRoles,
      role_annotations_confirmed: pyGet(
        data,
        'role_annotations_confirmed',
        false,
      ) as boolean,
      atlassian_url:
        (pyGet(data, 'atlassian_url', null) as string | null) ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when discovery cannot proceed due to a configuration problem. */
export class WorkflowDiscoveryError extends Error {}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/** Discovers and caches per-project issue-workflow mappings. */
export class WorkflowDiscovery {
  canaryDir: string;
  private http: HttpClient;
  private subprocess: SubprocessRun;

  constructor(canaryDir?: string | null, deps: WorkflowDiscoveryDeps = {}) {
    this.canaryDir =
      canaryDir !== undefined && canaryDir !== null
        ? canaryDir
        : join(process.cwd(), '.canary');
    this.http = deps.http ?? defaultHttpClient;
    this.subprocess = deps.subprocess ?? defaultSubprocess;
  }

  // -- public ----------------------------------------------------------------

  /** Python: `WorkflowDiscovery.discover`. */
  async discover(
    projectKey: string,
    opts: { refresh?: boolean; dryRun?: boolean } = {},
  ): Promise<WorkflowMapping> {
    const refresh = opts.refresh ?? false;
    const dryRun = opts.dryRun ?? false;

    const cached = refresh ? null : this.loadCached(projectKey);
    if (cached !== null) {
      return cached;
    }

    let mapping: WorkflowMapping;
    if (projectKey.includes('/')) {
      mapping = await this.fetchGithub(projectKey);
    } else {
      mapping = await this.fetchJira(projectKey);
    }

    // Preserve user-confirmed semantic roles from any previous mapping.
    if (refresh) {
      const prev = this.loadCached(projectKey);
      if (prev && prev.role_annotations_confirmed) {
        for (const [role, sr] of Object.entries(prev.semantic_roles)) {
          if (
            !Object.prototype.hasOwnProperty.call(mapping.semantic_roles, role)
          ) {
            mapping.semantic_roles[role] = sr;
          }
        }
        mapping.role_annotations_confirmed = true;
      }
    }

    mapping = this.applyHeuristics(mapping);

    if (!dryRun) {
      this.write(mapping);
    }

    return mapping;
  }

  /** Python: `WorkflowDiscovery.show`. */
  show(projectKey: string): WorkflowMapping | null {
    return this.loadCached(projectKey);
  }

  /** Python: `WorkflowDiscovery.resolve_role`. */
  resolveRole(projectKey: string, role: string): string | null {
    const mapping = this.loadCached(projectKey);
    if (mapping === null) {
      return null;
    }
    const sr = mapping.semantic_roles[role];
    return sr ? sr.status_name : null;
  }

  // -- private: persistence --------------------------------------------------

  /** Python: `WorkflowDiscovery._mapping_path`. */
  mappingPath(projectKey: string): string {
    // `u` flag: an astral code point is ONE unit (one `_`), matching Python's
    // re.sub over code points; without it a surrogate pair becomes two `_`.
    const safeKey = projectKey.replace(/[^A-Za-z0-9_-]/gu, '_');
    return join(this.canaryDir, `workflow-${safeKey}.json`);
  }

  /** Python: `WorkflowDiscovery._load_cached`. */
  loadCached(projectKey: string): WorkflowMapping | null {
    const path = this.mappingPath(projectKey);
    if (!existsSync(path)) {
      return null;
    }
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      return WorkflowMapping.fromDict(data);
    } catch {
      // JSONDecodeError / KeyError / TypeError -> None
      return null;
    }
  }

  /** Python: `WorkflowDiscovery._write`. */
  write(mapping: WorkflowMapping): void {
    mkdirSync(this.canaryDir, { recursive: true });
    const path = this.mappingPath(mapping.project_key);
    writeFileSync(path, mapping.toJson(), 'utf-8');
  }

  // -- private: Jira ---------------------------------------------------------

  /** Python: `WorkflowDiscovery._fetch_jira`. */
  async fetchJira(projectKey: string): Promise<WorkflowMapping> {
    const baseUrl = rstripChar(process.env['ATLASSIAN_URL'] ?? '', '/');
    const user = process.env['ATLASSIAN_USER'] ?? '';
    const token = process.env['ATLASSIAN_TOKEN'] ?? '';

    if (!pyTruthy(baseUrl) || !pyTruthy(user) || !pyTruthy(token)) {
      throw new WorkflowDiscoveryError(
        'Jira credentials not configured.  Set ATLASSIAN_URL, ' +
          'ATLASSIAN_USER, and ATLASSIAN_TOKEN environment variables.\n' +
          'Tip: add them to .canary/company.local.json or your shell profile.',
      );
    }

    const auth = Buffer.from(`${user}:${token}`).toString('base64');
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    };
    // Capture the URL so ticket_updater can use it without requiring the env var.
    const discoveredBaseUrl = baseUrl;

    // 1. Get issue types for this project.
    const issueTypesRaw = await this.jiraGet(
      `${baseUrl}/rest/api/3/project/${projectKey}/issuetypes`,
      headers,
    );
    if (
      !Array.isArray(issueTypesRaw) &&
      typeof issueTypesRaw === 'object' &&
      issueTypesRaw !== null &&
      'errorMessages' in issueTypesRaw
    ) {
      throw new WorkflowDiscoveryError(
        `Jira project ${pyRepr(projectKey)} not found or access denied: ` +
          `${pyRepr((issueTypesRaw as Record<string, unknown>)['errorMessages'])}`,
      );
    }

    const issueTypes: IssueType[] = [];
    const list = Array.isArray(issueTypesRaw)
      ? (issueTypesRaw as Record<string, unknown>[])
      : [];
    for (const itRaw of list) {
      const itId = String(pyGet(itRaw, 'id', ''));
      const itName = String(pyGet(itRaw, 'name', ''));
      if (!pyTruthy(itName)) {
        continue;
      }

      // 2. Get statuses for this issue type.
      const statusesRaw = await this.jiraGet(
        `${baseUrl}/rest/api/3/project/${projectKey}/statuses`,
        headers,
      );
      const statuses = this.parseStatuses(statusesRaw, itName);

      // 3. Try to get transitions by sampling one issue of this type.
      const transitions = await this.sampleTransitions(
        baseUrl,
        headers,
        projectKey,
        itName,
      );

      issueTypes.push(new IssueType(itId, itName, statuses, transitions));
    }

    return new WorkflowMapping({
      project_key: projectKey,
      source: 'jira',
      discovered_at: nowIso(),
      issue_types: issueTypes,
      atlassian_url: discoveredBaseUrl,
    });
  }

  /** Python: `WorkflowDiscovery._parse_statuses`. */
  parseStatuses(statusesRaw: unknown, issueTypeName: string): StatusEntry[] {
    if (!Array.isArray(statusesRaw)) {
      return [];
    }
    const entries = statusesRaw as Record<string, unknown>[];
    for (const entry of entries) {
      const entryName = (pyGet(entry, 'name', '') as string) ?? '';
      if (entryName.toLowerCase() === issueTypeName.toLowerCase()) {
        return (pyGet(entry, 'statuses', []) as Record<string, unknown>[]).map(
          (s) =>
            new StatusEntry(
              String(pyGet(s, 'id', '')),
              pyGet(s, 'name', '') as string,
              pyGet(
                pyGet(s, 'statusCategory', {}) as Record<string, unknown>,
                'key',
                'indeterminate',
              ) as string,
            ),
        );
      }
    }
    // Fallback: return all statuses from all types (deduplicated by name).
    const seen = new Set<string>();
    const result: StatusEntry[] = [];
    for (const entry of entries) {
      for (const s of pyGet(entry, 'statuses', []) as Record<
        string,
        unknown
      >[]) {
        const name = pyGet(s, 'name', '') as string;
        if (pyTruthy(name) && !seen.has(name)) {
          seen.add(name);
          result.push(
            new StatusEntry(
              String(pyGet(s, 'id', '')),
              name,
              pyGet(
                pyGet(s, 'statusCategory', {}) as Record<string, unknown>,
                'key',
                'indeterminate',
              ) as string,
            ),
          );
        }
      }
    }
    return result;
  }

  /** Python: `WorkflowDiscovery._sample_transitions`. */
  async sampleTransitions(
    baseUrl: string,
    headers: Record<string, string>,
    projectKey: string,
    issueTypeName: string,
  ): Promise<TransitionEntry[]> {
    const jql =
      `project = ${projectKey} AND issuetype = "${issueTypeName}" ` +
      `AND statusCategory != Done ORDER BY created DESC`;
    const params = new URLSearchParams({
      jql,
      maxResults: '1',
      fields: 'id',
    }).toString();
    let searchResult: unknown;
    try {
      searchResult = await this.jiraGet(
        `${baseUrl}/rest/api/3/issue/search?${params}`,
        headers,
      );
    } catch {
      return [];
    }

    const isDict =
      searchResult !== null &&
      typeof searchResult === 'object' &&
      !Array.isArray(searchResult);
    const issues = isDict
      ? (pyGet(
          searchResult as Record<string, unknown>,
          'issues',
          [],
        ) as unknown[])
      : [];
    if (!pyTruthy(issues)) {
      return [];
    }

    const issueKey = pyGet(
      issues[0] as Record<string, unknown>,
      'key',
      '',
    ) as string;
    if (!pyTruthy(issueKey)) {
      return [];
    }

    let transitionsRaw: unknown;
    try {
      transitionsRaw = await this.jiraGet(
        `${baseUrl}/rest/api/3/issue/${issueKey}/transitions`,
        headers,
      );
    } catch {
      return [];
    }

    if (
      transitionsRaw === null ||
      typeof transitionsRaw !== 'object' ||
      Array.isArray(transitionsRaw)
    ) {
      return [];
    }
    const rawList = pyGet(
      transitionsRaw as Record<string, unknown>,
      'transitions',
      [],
    ) as Record<string, unknown>[];
    return rawList.map((t) => {
      const from = pyGet(t, 'from', null);
      const to = pyGet(t, 'to', null);
      return new TransitionEntry(
        String(pyGet(t, 'id', '')),
        pyGet(t, 'name', '') as string,
        from !== null && typeof from === 'object'
          ? (pyGet(from as Record<string, unknown>, 'name', '') as string)
          : '',
        to !== null && typeof to === 'object'
          ? (pyGet(to as Record<string, unknown>, 'name', '') as string)
          : '',
      );
    });
  }

  /** Python: `WorkflowDiscovery._jira_get`. */
  async jiraGet(
    url: string,
    headers: Record<string, string>,
  ): Promise<unknown> {
    let resp: HttpResponse;
    try {
      resp = await this.http({ url, headers, method: 'GET', timeout: 10 });
    } catch (exc) {
      // urllib.error.URLError branch.
      throw new WorkflowDiscoveryError(
        `Network error calling Jira API: ${reasonOf(exc)}`,
      );
    }
    if (!resp.ok) {
      // urllib.error.HTTPError branch.
      throw new WorkflowDiscoveryError(
        `Jira API error ${resp.status} for ${url}: ${codePointSlice(resp.text, 200)}`,
      );
    }
    return JSON.parse(resp.text);
  }

  // -- private: GitHub -------------------------------------------------------

  /** Python: `WorkflowDiscovery._fetch_github`. */
  async fetchGithub(repoSlug: string): Promise<WorkflowMapping> {
    let result: SubprocessResult;
    try {
      result = this.subprocess(
        [
          'gh',
          'api',
          `repos/${repoSlug}/projects`,
          '--jq',
          '.[0].columns_url // empty',
        ],
        { timeout: 10 },
      );
    } catch (exc) {
      if (
        exc instanceof CommandNotFoundError ||
        exc instanceof SubprocessTimeoutError
      ) {
        throw new WorkflowDiscoveryError(
          'GitHub CLI (gh) is not installed or timed out.  ' +
            'Install gh and run `gh auth login` before discovering GitHub workflows.',
        );
      }
      throw exc;
    }

    if (result.returncode !== 0 || !pyTruthy(result.stdout.trim())) {
      // No project board found -- synthesize a minimal "open / closed" mapping.
      return new WorkflowMapping({
        project_key: repoSlug,
        source: 'github',
        discovered_at: nowIso(),
        issue_types: [
          new IssueType('github_issue', 'GitHub Issue', [
            new StatusEntry('open', 'Open', 'new'),
            new StatusEntry('closed', 'Closed', 'done'),
          ]),
        ],
      });
    }

    const columnsUrl = result.stdout.trim();
    let colResult: SubprocessResult;
    try {
      colResult = this.subprocess(
        [
          'gh',
          'api',
          columnsUrl,
          '--jq',
          '[.[] | {id: .id|tostring, name: .name}]',
        ],
        { timeout: 10 },
      );
    } catch (exc) {
      if (exc instanceof SubprocessTimeoutError) {
        throw new WorkflowDiscoveryError(
          'gh API timed out fetching project columns',
        );
      }
      throw exc;
    }

    const columns: Record<string, unknown>[] =
      colResult.returncode === 0 ? JSON.parse(colResult.stdout) : [];

    const statuses = columns.map(
      (col) =>
        new StatusEntry(
          col['id'] as string,
          col['name'] as string,
          /done|closed|merged|shipped/i.test(col['name'] as string)
            ? 'done'
            : 'indeterminate',
        ),
    );

    return new WorkflowMapping({
      project_key: repoSlug,
      source: 'github',
      discovered_at: nowIso(),
      issue_types: [new IssueType('github_issue', 'GitHub Issue', statuses)],
    });
  }

  // -- private: heuristics ---------------------------------------------------

  /** Python: `WorkflowDiscovery._apply_heuristics`. */
  applyHeuristics(mapping: WorkflowMapping): WorkflowMapping {
    // Collect all (issue_type_name, status_name) pairs.
    const candidates: [string, string][] = [];
    for (const it of mapping.issue_types) {
      for (const s of it.statuses) {
        candidates.push([it.name, s.name]);
      }
    }

    const assigned: Record<string, SemanticRole> = {};
    for (const role of ROLE_PRIORITY) {
      if (Object.prototype.hasOwnProperty.call(mapping.semantic_roles, role)) {
        continue; // Already set (e.g. from a previous confirmed mapping).
      }
      const triggers = ROLE_TRIGGERS[role] ?? [];
      for (const [itName, statusName] of candidates) {
        const low = statusName.toLowerCase();
        if (triggers.some((trigger) => low.includes(trigger))) {
          assigned[role] = new SemanticRole(statusName, itName);
          break; // first match wins for this role
        }
      }
    }

    mapping.semantic_roles = { ...assigned, ...mapping.semantic_roles };
    return mapping;
  }
}

// ---------------------------------------------------------------------------
// Module-level convenience
// ---------------------------------------------------------------------------

/** Python: module-level `resolve_role`. */
export function resolveRole(
  projectKey: string,
  role: string,
  canaryDir?: string | null,
): string | null {
  return new WorkflowDiscovery(canaryDir).resolveRole(projectKey, role);
}

/** Python: module-level `atlassian_url_for`. */
export function atlassianUrlFor(
  projectKey: string,
  canaryDir?: string | null,
): string | null {
  const mapping = new WorkflowDiscovery(canaryDir).show(projectKey);
  return mapping ? mapping.atlassian_url : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Python: `_now_iso` -- UTC ISO-8601 to seconds precision (`+00:00` suffix). */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
}

/** Extract a human-readable reason from a thrown value (Python `exc.reason`). */
function reasonOf(exc: unknown): string {
  if (exc !== null && typeof exc === 'object' && 'message' in exc) {
    return String((exc as { message: unknown }).message);
  }
  return String(exc);
}

/**
 * Minimal Python `repr()` for the values that reach the Jira error message
 * (a string project key and a list of error strings). Not a general repr.
 */
function pyRepr(value: unknown): string {
  if (typeof value === 'string') {
    // Python prefers single quotes unless the string has a single quote but no
    // double quote.
    if (value.includes("'") && !value.includes('"')) {
      return '"' + value.replace(/\\/g, '\\\\') + '"';
    }
    return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => pyRepr(v)).join(', ') + ']';
  }
  if (value === null || value === undefined) {
    return 'None';
  }
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}
