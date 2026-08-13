/**
 * Ticket Updater -- posts a structured run comment and optionally transitions
 * the linked ticket after a Canary test run.
 *
 * Faithful TypeScript port of `agent/core/ticket_updater.py`.
 *
 * Canary never hardcodes Jira status names. Transition targets are resolved via
 * the semantic-role mapping persisted by `WorkflowDiscovery`.
 *
 * Python->TS nuances:
 *   - **Regex line anchors.** Python `re.MULTILINE` `^` matches only at string
 *     start and immediately after `\n`. JS `^` under `/m` also breaks on `\r`,
 *     `U+2028`, and `U+2029`, so the frontmatter patterns anchor on `\n`
 *     explicitly via `(?:^|(?<=\n))` and drop `/m`. `re.IGNORECASE` -> `/i`.
 *   - **subprocess -> child_process** via the injectable {@link SubprocessRun}
 *     seam (default `spawnSync` with `maxBuffer: Infinity`); Python's
 *     FileNotFoundError/TimeoutExpired -> {@link CommandNotFoundError}/
 *     {@link SubprocessTimeoutError}.
 *   - **urllib -> fetch seam.** Jira REST calls run through the injectable async
 *     {@link HttpClient}. Python's `urlopen` raises `HTTPError` (a `URLError`
 *     subclass) on a non-2xx status; the fetch seam does not, so callers treat
 *     `!resp.ok` exactly as Python's caught-exception path.
 *   - **JSON payload shape** mirrors `json.dumps` with library-default
 *     `ensure_ascii=True` reproduced by {@link ensureAscii}.
 *   - **Python truthiness** (`""`/`[]`/`None` falsy) via {@link pyTruthy}.
 *   - **`{value!r}`** reproduced by {@link pyRepr} for the one user-facing
 *     `repr()` in the "unrecognised key" message.
 *   - `duration_s` prints via JS `String(number)`; unlike Python's `float`
 *     `repr`, an integral value like `12` yields `"12"`, not `"12.0"` (JS has no
 *     int/float distinction). Non-integral values match.
 */

import {
  atlassianUrlFor,
  CommandNotFoundError,
  defaultHttpClient,
  defaultSubprocess,
  resolveRole,
  SubprocessTimeoutError,
  type HttpClient,
  type SubprocessRun,
} from './workflow-discovery.js';
import { ensureAscii } from '../util/ensure-ascii.js';

// ---------------------------------------------------------------------------
// Python-compatibility helpers (copied locally per-module, matching reporter.ts)
// ---------------------------------------------------------------------------

/**
 * Python-truthiness for the values used here: `None`/`undefined`, `false`, `0`,
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

/**
 * Python `json.dumps(obj)` (no indent) with library-default separators
 * `(', ', ': ')` -- a space after every ',' and ':'. JS `JSON.stringify` emits
 * none. A regex over stringify output would corrupt separators inside string
 * values (comment text contains ':' and ','), so serialize structurally. Wrap
 * the result in {@link ensureAscii} for `ensure_ascii=True` parity. These
 * payloads carry no floats, so the `str(float)` `.0` question does not arise.
 */
function pyJsonDumps(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(pyJsonDumps).join(', ') + ']';
  }
  const parts = Object.entries(value as Record<string, unknown>).map(
    ([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`,
  );
  return '{' + parts.join(', ') + '}';
}

/**
 * Python `str(float)`: an integral float still renders a trailing `.0`
 * (`str(12.0) === '12.0'`, `str(0.0) === '0.0'`), but JS `String(12)` -> `'12'`.
 * duration_s is a float interpolated into the posted comment, and its default
 * (`0.0`) and whole-second values are integral and reachable, so restore `.0`.
 * Non-integral values match `String(d)` for the realistic seconds domain.
 */
function pyFloatStr(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/** Python `str.rstrip(ch)` -- remove all trailing runs of `ch`. */
function rstripChar(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}

/** Python `str.lstrip(ch)` -- remove all leading runs of `ch`. */
function lstripChar(s: string, ch: string): string {
  let start = 0;
  while (start < s.length && s[start] === ch) start++;
  return s.slice(start);
}

/** Minimal Python `repr()` for a string (single-quoted unless it needs double). */
function pyRepr(value: string): string {
  if (value.includes("'") && !value.includes('"')) {
    return '"' + value.replace(/\\/g, '\\\\') + '"';
  }
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Python: `TransitionResult` dataclass. */
export class TransitionResult {
  attempted: boolean;
  succeeded: boolean;
  from_status: string | null;
  to_status: string | null;
  reason: string; // human-readable explanation

  constructor(
    attempted: boolean,
    succeeded: boolean,
    fromStatus: string | null,
    toStatus: string | null,
    reason: string,
  ) {
    this.attempted = attempted;
    this.succeeded = succeeded;
    this.from_status = fromStatus;
    this.to_status = toStatus;
    this.reason = reason;
  }
}

/** Python: `UpdateResult` dataclass. */
export class UpdateResult {
  ticket_key: string | null;
  project_key: string | null;
  linkage_source: string; // "frontmatter" | "tag" | "branch" | "none"
  comment_posted: boolean;
  transition: TransitionResult;
  dry_run: boolean;
  messages: string[];

  constructor(init: {
    ticket_key: string | null;
    project_key: string | null;
    linkage_source: string;
    comment_posted: boolean;
    transition: TransitionResult;
    dry_run: boolean;
    messages?: string[];
  }) {
    this.ticket_key = init.ticket_key;
    this.project_key = init.project_key;
    this.linkage_source = init.linkage_source;
    this.comment_posted = init.comment_posted;
    this.transition = init.transition;
    this.dry_run = init.dry_run;
    this.messages = init.messages ?? [];
  }
}

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

/** Python: `RunSummary` dataclass. Describes a completed Canary test run. */
export class RunSummary {
  suite_name: string;
  env: string;
  result: 'PASS' | 'FAIL' | 'PARTIAL';
  passed: number;
  total: number;
  flaky_count: number;
  duration_s: number;
  test_file: string;
  report_url: string | null;
  passed_names: string[];
  failed_names: [string, string][]; // (name, failure_category) pairs
  ticket_key: string | null;
  project_key: string | null;
  linkage_source: string;

  constructor(init: {
    suite_name: string;
    env: string;
    result: 'PASS' | 'FAIL' | 'PARTIAL';
    passed: number;
    total: number;
    flaky_count: number;
    duration_s: number;
    test_file: string;
    report_url: string | null;
    passed_names: string[];
    failed_names: [string, string][];
    ticket_key?: string | null;
    project_key?: string | null;
    linkage_source?: string;
  }) {
    this.suite_name = init.suite_name;
    this.env = init.env;
    this.result = init.result;
    this.passed = init.passed;
    this.total = init.total;
    this.flaky_count = init.flaky_count;
    this.duration_s = init.duration_s;
    this.test_file = init.test_file;
    this.report_url = init.report_url;
    this.passed_names = init.passed_names;
    this.failed_names = init.failed_names;
    this.ticket_key = init.ticket_key ?? null;
    this.project_key = init.project_key ?? null;
    this.linkage_source = init.linkage_source ?? 'none';
  }
}

// ---------------------------------------------------------------------------
// Patterns for ticket linkage detection.
// ---------------------------------------------------------------------------

// Python `re.MULTILINE` `^` anchors on `\n` only -- reproduced via
// `(?:^|(?<=\n))` (JS `/m` would also break on `\r`/`U+2028`/`U+2029`).
const FRONTMATTER_TICKET = /(?:^|(?<=\n))#\s*canary:ticket:\s*(\S+)/;
const FRONTMATTER_PROJECT = /(?:^|(?<=\n))#\s*canary:project:\s*(\S+)/;
// No `^`/`$` anchors, so `re.MULTILINE` was a no-op -- ported without `/m`.
const TAG_TICKET = /@(?:ticket|jira):([A-Z][A-Z0-9]*-\d+)/;
const BRANCH_TICKET = /(?:feature|fix|chore)\/([A-Z][A-Z0-9]*-\d+)/;
const TICKET_PROJECT = /^([A-Z][A-Z0-9]*)-\d+$/;

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Seams injected into {@link TicketUpdater}. */
export interface TicketUpdaterDeps {
  http?: HttpClient;
  subprocess?: SubprocessRun;
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/** Posts a run comment and optionally transitions the linked ticket. */
export class TicketUpdater {
  canaryDir: string;
  private http: HttpClient;
  private subprocess: SubprocessRun;

  constructor(canaryDir?: string | null, deps: TicketUpdaterDeps = {}) {
    this.canaryDir =
      canaryDir !== undefined && canaryDir !== null
        ? canaryDir
        : joinCwdCanary();
    this.http = deps.http ?? defaultHttpClient;
    this.subprocess = deps.subprocess ?? defaultSubprocess;
  }

  // -- public ----------------------------------------------------------------

  /** Python: `TicketUpdater.update`. */
  async update(
    summary: RunSummary,
    opts: {
      dryRun?: boolean;
      commentOnly?: boolean;
      transitionOnly?: boolean;
    } = {},
  ): Promise<UpdateResult> {
    const dryRun = opts.dryRun ?? false;
    const commentOnly = opts.commentOnly ?? false;
    const transitionOnly = opts.transitionOnly ?? false;

    const messages: string[] = [];

    // 1. Resolve linkage if not already set.
    // Strip a trailing newline from a caller-supplied ticket key. Python's `$`
    // (no MULTILINE) leniently matches before a trailing \n, so "ABC-123\n"
    // routes to Jira there; JS `$` does not, so the port would misroute it to
    // "unrecognised". Normalizing at ingest makes routing match AND keeps the
    // key clean for the request URL (Python would 404 on the raw newline).
    let ticketKey =
      typeof summary.ticket_key === 'string'
        ? rstripChar(summary.ticket_key, '\n')
        : summary.ticket_key;
    let projectKey = summary.project_key;
    let linkageSource = summary.linkage_source;

    if (!pyTruthy(ticketKey) && pyTruthy(summary.test_file)) {
      [ticketKey, projectKey, linkageSource] = this.detectLinkage(
        summary.test_file,
      );
    }

    // 2. Safety gate -- no ticket found.
    if (!pyTruthy(ticketKey)) {
      messages.push(
        'No ticket linkage found \u2014 skipping comment and transition.\n' +
          "Add '# canary:ticket: PROJ-123' to the test file frontmatter, " +
          "a '@ticket:PROJ-123' tag, or run from a branch named " +
          'feature/PROJ-123.',
      );
      return new UpdateResult({
        ticket_key: null,
        project_key: null,
        linkage_source: linkageSource,
        comment_posted: false,
        transition: new TransitionResult(
          false,
          false,
          null,
          null,
          'no ticket linkage',
        ),
        dry_run: dryRun,
        messages,
      });
    }

    // Infer project_key from ticket_key if not set.
    if (!pyTruthy(projectKey)) {
      const m = TICKET_PROJECT.exec(ticketKey!);
      projectKey = m ? m[1]! : null;
    }

    // 3. Build run comment.
    const commentBody = this.buildComment(summary);

    // 4. Post comment.
    let commentPosted = false;
    if (!transitionOnly) {
      // Determine surface: Jira for PROJ-NNN keys, GitHub for owner/repo#NNN.
      if (/^[A-Z][A-Z0-9]*-\d+$/.test(ticketKey!)) {
        commentPosted = await this.postJiraComment(
          ticketKey!,
          commentBody,
          dryRun,
        );
      } else if (/^#\d+$/.test(ticketKey!) || /^\d+$/.test(ticketKey!)) {
        // GitHub issue -- needs project_key as "owner/repo".
        const issueRef = pyTruthy(projectKey)
          ? `${projectKey}#${lstripChar(ticketKey!, '#')}`
          : ticketKey!;
        commentPosted = this.postGithubComment(issueRef, commentBody, dryRun);
      } else {
        messages.push(
          `Unrecognised ticket key format: ${pyRepr(ticketKey!)}. ` +
            'Expected PROJ-NNN (Jira) or #NNN (GitHub Issue).',
        );
      }

      if (dryRun) {
        messages.push(
          `Would post comment to ${ticketKey} ` +
            `(${ticketKey!.includes('-') ? 'Jira' : 'GitHub Issue'}):\n` +
            `${commentBody}`,
        );
        commentPosted = true; // flagged as would-post
      }
    }

    // 5. Transition.
    let transitionResult = new TransitionResult(
      false,
      false,
      null,
      null,
      'skipped (comment-only mode)',
    );

    if (!commentOnly) {
      transitionResult = await this.transitionJira(
        ticketKey!,
        pyTruthy(projectKey) ? projectKey! : '',
        summary.result,
        dryRun,
      );
      if (dryRun && transitionResult.attempted) {
        messages.push(
          `Would transition ${ticketKey}:\n` +
            `  "${transitionResult.from_status}" \u2192 "${transitionResult.to_status}"\n` +
            '  (resolved via qa_passed role in ' +
            `.canary/workflow-${projectKey}.json)\n\n` +
            'Re-run without --dry-run to apply.',
        );
      } else if (!transitionResult.attempted) {
        messages.push(transitionResult.reason);
      }
    }

    return new UpdateResult({
      ticket_key: ticketKey,
      project_key: projectKey,
      linkage_source: linkageSource,
      comment_posted: commentPosted,
      transition: transitionResult,
      dry_run: dryRun,
      messages,
    });
  }

  /** Python: `TicketUpdater.detect_linkage`. */
  detectLinkage(testFile: string): [string | null, string | null, string] {
    if (!existsSync(testFile)) {
      return this.branchTicket();
    }

    const content = readFileSync(testFile, 'utf-8');

    // Priority 1: YAML frontmatter comments.
    const mTicket = FRONTMATTER_TICKET.exec(content);
    if (mTicket) {
      const ticketKey = mTicket[1]!;
      const mProject = FRONTMATTER_PROJECT.exec(content);
      let projectKey: string | null = mProject ? mProject[1]! : null;
      if (projectKey === null) {
        const pm = TICKET_PROJECT.exec(ticketKey);
        projectKey = pm ? pm[1]! : null;
      }
      return [ticketKey, projectKey, 'frontmatter'];
    }

    // Priority 2: @ticket / @jira tag annotations.
    const mTag = TAG_TICKET.exec(content);
    if (mTag) {
      const ticketKey = mTag[1]!;
      const pm = TICKET_PROJECT.exec(ticketKey);
      const projectKey = pm ? pm[1]! : null;
      return [ticketKey, projectKey, 'tag'];
    }

    // Priority 3: branch name (comment only, not for transition).
    return this.branchTicket();
  }

  // -- private: comment building ---------------------------------------------

  /** Python: `TicketUpdater._build_comment`. */
  buildComment(summary: RunSummary): string {
    const flags = `--result ${summary.result.toLowerCase()}`;

    const lines: string[] = [
      `\u{1F9EA} Canary Test Run \u2014 ${summary.suite_name}`,
      '',
      `Environment: ${summary.env}`,
      `Result: ${summary.result} (${summary.passed}/${summary.total} tests)`,
      `Flaky: ${summary.flaky_count}`,
      `Duration: ${pyFloatStr(summary.duration_s)}s`,
      `Run by: canary report ${flags}`,
      '',
      `Test file: ${summary.test_file}`,
    ];

    if (pyTruthy(summary.report_url)) {
      lines.push(`Report: ${summary.report_url}`);
    }

    lines.push('', '---');

    if (pyTruthy(summary.passed_names)) {
      lines.push('Passed:');
      for (const name of summary.passed_names) {
        lines.push(`  \u2713 ${name}`);
      }
    }

    if (pyTruthy(summary.failed_names)) {
      lines.push('Failed:');
      for (const [name, category] of summary.failed_names) {
        lines.push(`  \u2717 ${name} \u2014 ${category}`);
      }
    }

    return lines.join('\n');
  }

  // -- private: Jira ---------------------------------------------------------

  /** Python: `TicketUpdater._post_jira_comment`. */
  async postJiraComment(
    ticketKey: string,
    body: string,
    dryRun: boolean,
  ): Promise<boolean> {
    if (dryRun) {
      return true;
    }

    // Infer project key from ticket key to select the right Atlassian URL.
    const pm = TICKET_PROJECT.exec(ticketKey);
    const projectKey = pm ? pm[1]! : null;
    const [baseUrl, authHeader] = this.jiraAuth(projectKey, this.canaryDir);
    if (baseUrl === null) {
      return false;
    }

    const url = `${baseUrl}/rest/api/3/issue/${ticketKey}/comment`;
    const payload = ensureAscii(
      pyJsonDumps({
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: body }],
            },
          ],
        },
      }),
    );

    try {
      const resp = await this.http({
        url,
        method: 'POST',
        headers: {
          Authorization: authHeader!,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: payload,
        timeout: 10,
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Python: `TicketUpdater._post_github_comment`. */
  postGithubComment(issueRef: string, body: string, dryRun: boolean): boolean {
    if (dryRun) {
      return true;
    }

    // Parse owner/repo#NNN or bare NNN.
    const m = /^([^#]+)#(\d+)$/.exec(issueRef);
    let repo: string;
    let number: string;
    if (m) {
      repo = m[1]!;
      number = m[2]!;
    } else if (/^\d+$/.test(issueRef)) {
      repo = '';
      number = issueRef;
    } else {
      return false;
    }

    const cmd = ['gh', 'issue', 'comment', number, '--body', body];
    if (pyTruthy(repo)) {
      cmd.push('--repo', repo);
    }

    try {
      const result = this.subprocess(cmd, { timeout: 15 });
      return result.returncode === 0;
    } catch (exc) {
      if (
        exc instanceof CommandNotFoundError ||
        exc instanceof SubprocessTimeoutError
      ) {
        return false;
      }
      throw exc;
    }
  }

  /** Python: `TicketUpdater._transition_jira`. */
  async transitionJira(
    ticketKey: string,
    projectKey: string,
    result: string,
    dryRun: boolean,
  ): Promise<TransitionResult> {
    // Block transition on non-PASS results.
    if (result !== 'PASS') {
      return new TransitionResult(
        false,
        false,
        null,
        null,
        `Run result is ${result} \u2014 ticket NOT transitioned to qa_passed. ` +
          'Transition only happens on PASS.',
      );
    }

    // Resolve target status name from workflow mapping.
    const targetStatus = resolveRole(projectKey, 'qa_passed', this.canaryDir);
    if (targetStatus === null) {
      return new TransitionResult(
        false,
        false,
        null,
        null,
        `\u26A0  No workflow mapping found for project ${projectKey}.\n` +
          `   Run \`canary workflow-discover --project ${projectKey}\` first.\n` +
          '   Comment was posted. Transition was NOT attempted.',
      );
    }

    // Need Jira creds -- prefer URL stored in mapping for this project.
    const [baseUrl, authHeader] = this.jiraAuth(projectKey, this.canaryDir);
    if (baseUrl === null) {
      return new TransitionResult(
        false,
        false,
        null,
        null,
        'Jira credentials not configured (ATLASSIAN_URL, ' +
          'ATLASSIAN_USER, ATLASSIAN_TOKEN). ' +
          'Transition was NOT attempted.',
      );
    }

    // Fetch ticket's current status.
    const currentStatus = await this.jiraCurrentStatus(
      baseUrl,
      authHeader!,
      ticketKey,
    );
    if (currentStatus === null) {
      return new TransitionResult(
        false,
        false,
        null,
        targetStatus,
        `Could not fetch current status for ${ticketKey}.`,
      );
    }

    // Find the transition ID that leads to target_status.
    const transitionId = await this.jiraFindTransition(
      baseUrl,
      authHeader!,
      ticketKey,
      targetStatus,
    );
    if (transitionId === null) {
      return new TransitionResult(
        true,
        false,
        currentStatus,
        targetStatus,
        `Transition to "${targetStatus}" is not reachable from ` +
          `"${currentStatus}" for ${ticketKey}. ` +
          'No transition attempted.',
      );
    }

    // Dry-run: return what would happen.
    if (dryRun) {
      return new TransitionResult(
        true,
        false, // not actually done
        currentStatus,
        targetStatus,
        'dry-run',
      );
    }

    // Execute transition.
    const ok = await this.jiraDoTransition(
      baseUrl,
      authHeader!,
      ticketKey,
      transitionId,
    );
    return new TransitionResult(
      true,
      ok,
      currentStatus,
      targetStatus,
      ok ? 'transition executed' : 'transition API call failed',
    );
  }

  // -- private: injectable helper seams (Python module functions) ------------

  /** Python: module `_jira_auth` (instance-method seam for test injection). */
  jiraAuth(
    projectKey: string | null,
    canaryDir?: string | null,
  ): [string | null, string | null] {
    return jiraAuth(projectKey, canaryDir);
  }

  /** Python: module `_jira_current_status`. */
  async jiraCurrentStatus(
    baseUrl: string,
    authHeader: string,
    ticketKey: string,
  ): Promise<string | null> {
    const url = `${baseUrl}/rest/api/3/issue/${ticketKey}?fields=status`;
    try {
      const resp = await this.http({
        url,
        method: 'GET',
        headers: { Authorization: authHeader, Accept: 'application/json' },
        timeout: 10,
      });
      if (!resp.ok) {
        // Python: urlopen raises HTTPError (URLError subclass) -> caught -> None.
        return null;
      }
      const data = JSON.parse(resp.text) as Record<string, unknown>;
      const fields = pyGet(data, 'fields', {}) as Record<string, unknown>;
      const status = pyGet(fields, 'status', {}) as Record<string, unknown>;
      return (pyGet(status, 'name', null) as string | null) ?? null;
    } catch {
      return null;
    }
  }

  /** Python: module `_jira_find_transition`. */
  async jiraFindTransition(
    baseUrl: string,
    authHeader: string,
    ticketKey: string,
    targetStatus: string,
  ): Promise<string | null> {
    const url = `${baseUrl}/rest/api/3/issue/${ticketKey}/transitions`;
    let data: Record<string, unknown>;
    try {
      const resp = await this.http({
        url,
        method: 'GET',
        headers: { Authorization: authHeader, Accept: 'application/json' },
        timeout: 10,
      });
      if (!resp.ok) {
        return null;
      }
      data = JSON.parse(resp.text) as Record<string, unknown>;
    } catch {
      return null;
    }

    for (const t of pyGet(data, 'transitions', []) as Record<
      string,
      unknown
    >[]) {
      const to = pyGet(t, 'to', {}) as Record<string, unknown>;
      const toName = (pyGet(to, 'name', '') as string) ?? '';
      if (toName.toLowerCase() === targetStatus.toLowerCase()) {
        return String(t['id']);
      }
    }
    return null;
  }

  /** Python: module `_jira_do_transition`. */
  async jiraDoTransition(
    baseUrl: string,
    authHeader: string,
    ticketKey: string,
    transitionId: string,
  ): Promise<boolean> {
    const url = `${baseUrl}/rest/api/3/issue/${ticketKey}/transitions`;
    const payload = ensureAscii(
      pyJsonDumps({ transition: { id: transitionId } }),
    );
    try {
      const resp = await this.http({
        url,
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: payload,
        timeout: 10,
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Python: module `_branch_ticket` (instance-method seam for test injection). */
  branchTicket(): [string | null, string | null, string] {
    return branchTicket(this.subprocess);
  }
}

// ---------------------------------------------------------------------------
// Helpers (Python module-level functions)
// ---------------------------------------------------------------------------

/** Default `.canary` directory: `<cwd>/.canary`. */
function joinCwdCanary(): string {
  return `${process.cwd()}/.canary`;
}

/**
 * Python: `_jira_auth`. Return `[base_url, auth_header]` for the given
 * `projectKey`, or `[null, null]` when credentials are missing.
 *
 * Resolution order for base_url:
 *   1. `atlassian_url` stored in the per-project mapping file.
 *   2. `ATLASSIAN_URL` environment variable.
 */
export function jiraAuth(
  projectKey: string | null = null,
  canaryDir?: string | null,
): [string | null, string | null] {
  // Prefer the URL stored in the per-project mapping.
  let baseUrl = '';
  if (pyTruthy(projectKey)) {
    const stored = atlassianUrlFor(projectKey!, canaryDir);
    if (pyTruthy(stored)) {
      baseUrl = rstripChar(stored!, '/');
    }
  }

  if (!pyTruthy(baseUrl)) {
    baseUrl = rstripChar(process.env['ATLASSIAN_URL'] ?? '', '/');
  }

  const user = process.env['ATLASSIAN_USER'] ?? '';
  const token = process.env['ATLASSIAN_TOKEN'] ?? '';
  if (!pyTruthy(baseUrl) || !pyTruthy(user) || !pyTruthy(token)) {
    return [null, null];
  }
  const auth = Buffer.from(`${user}:${token}`).toString('base64');
  return [baseUrl, `Basic ${auth}`];
}

/**
 * Python: `_branch_ticket`. Extract a ticket key from the current git branch
 * name, or `[null, null, "none"]` when the branch does not match the
 * convention (or git is unavailable).
 */
export function branchTicket(
  subprocess: SubprocessRun = defaultSubprocess,
): [string | null, string | null, string] {
  let branch = '';
  try {
    const result = subprocess(['git', 'branch', '--show-current'], {
      timeout: 5,
    });
    branch = result.returncode === 0 ? result.stdout.trim() : '';
  } catch (exc) {
    if (
      exc instanceof CommandNotFoundError ||
      exc instanceof SubprocessTimeoutError
    ) {
      return [null, null, 'none'];
    }
    throw exc;
  }

  const m = BRANCH_TICKET.exec(branch);
  if (m) {
    const ticketKey = m[1]!;
    const pm = TICKET_PROJECT.exec(ticketKey);
    const projectKey: string | null = pm ? pm[1]! : null;
    return [ticketKey, projectKey, 'branch'];
  }

  return [null, null, 'none'];
}

// ---------------------------------------------------------------------------
// Local fs imports (kept at the bottom to mirror the Python top-level imports
// while keeping the seam wiring above readable).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
