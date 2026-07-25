/**
 * Promote the guardian gate from soft to hard by registering its status check
 * as a **required** check in branch protection — the one admin step the
 * operator guide says the guardian can't do for you.
 *
 * Faithful TypeScript port of `agent/guardian/hard_gate.py`.
 *
 * Structure mirrors {@link ./pr-comment}: a {@link BranchProtection} interface,
 * an in-memory fake for network-free tests, and a thin `fetch` REST client. The
 * decision logic ({@link planHardGate}) is pure. Any barrier — no admin scope, a
 * plan without branch protection, a bad token, a network error — surfaces as
 * {@link HardGateBlocked} carrying a manual playbook, never a silent no-op and
 * never a crash (the #294/#295 fail-loud contract).
 *
 * Two hazards this module is built to avoid:
 *
 * - **Clobbering existing protection.** `GET .../required_status_checks` returns
 *   404 both for an unprotected branch AND a protected branch that simply has no
 *   required-checks section. Treating the latter as "unprotected" and PUT-ing a
 *   fresh ruleset would wipe review/admin/restriction protections. We
 *   disambiguate via the parent `.../protection` endpoint and only ever
 *   PUT-create when the branch is *genuinely* unprotected; otherwise we PATCH
 *   the checks sub-resource, which leaves every other protection untouched.
 * - **Registering a phantom check.** A required context that no workflow reports
 *   stays "Expected" forever and blocks *every* merge — worse than not
 *   promoting. So before registering we verify the context against the checks a
 *   recent commit actually reported, and refuse (listing the real ones) unless
 *   `force`.
 *
 * Python→TS nuances:
 *   - **async**: the seam is `Promise`-returning (Node `fetch` is async), so
 *     {@link applyHardGate} is async and the fakes are `async`. The pure
 *     {@link planHardGate} and {@link renderPlaybook} stay synchronous.
 *   - **error mapping**: `fetch` resolves on a non-2xx status. The real client
 *     maps 401/403→{@link GitHubPermissionError} off `resp.status`, and throws a
 *     status-bearing {@link HttpError} for other codes so the 404 disambiguation
 *     can inspect the status (the analog of urllib's `HTTPError.code`). Python's
 *     `OSError` (URLError / timeout / non-403 HTTPError) maps to any non-permission
 *     error caught in {@link applyHardGate}.
 */

import { GitHubPermissionError } from './pr-comment.js';

/**
 * A barrier stopped the required-check registration.
 *
 * Carries a human-readable `reason` and a `playbook` of manual steps, so a
 * permission/plan/network barrier degrades to actionable guidance rather than a
 * crash or a silent skip.
 */
export class HardGateBlocked extends Error {
  readonly reason: string;
  readonly playbook: string;

  constructor(reason: string, playbook: string) {
    super(reason);
    this.name = 'HardGateBlocked';
    this.reason = reason;
    this.playbook = playbook;
  }
}

/**
 * What promoting the gate would change on `branch`.
 *
 * `already_required` — the check is already required (no-op).
 * `creates_protection` — the branch has NO protection at all, so applying would
 * create a minimal ruleset. `resulting_contexts` — the required-check set after
 * applying.
 */
export interface HardGatePlan {
  check_context: string;
  branch: string;
  already_required: boolean;
  creates_protection: boolean;
  resulting_contexts: string[];
}

/**
 * Decide the change without touching the network (PURE).
 *
 * `existingContexts` is the branch's current required-check contexts, an empty
 * list if the branch is protected but requires no checks yet, or `null`
 * **only** if the branch has no protection at all. That three-way distinction
 * is load-bearing: `null` is the only value that permits the
 * protection-creating path.
 */
export function planHardGate(
  existingContexts: string[] | null,
  checkContext: string,
  branch: string,
): HardGatePlan {
  const creates = existingContexts === null;
  const current = [...(existingContexts ?? [])];
  const already = current.includes(checkContext);
  const resulting = already ? current : [...current, checkContext];
  return {
    check_context: checkContext,
    branch,
    already_required: already,
    creates_protection: creates,
    resulting_contexts: [...new Set(resulting)].sort(),
  };
}

/** Read/write a branch's required-status-check contexts. */
export interface BranchProtection {
  /**
   * Current required contexts; `[]` if protected-without-checks; `null` only if
   * the branch is genuinely unprotected. Rejects with
   * {@link GitHubPermissionError} on 401/403.
   */
  requiredCheckContexts(branch: string): Promise<string[] | null>;
  /**
   * Check-run names a recent commit on `branch` actually reported (best-effort;
   * `[]` if none/unavailable).
   */
  observedCheckContexts(branch: string): Promise<string[]>;
  /**
   * Require `contexts` on `branch`. `create` PUTs a fresh minimal ruleset (only
   * when genuinely unprotected); otherwise PATCHes the checks sub-resource,
   * leaving other protections untouched. Rejects with
   * {@link GitHubPermissionError} on 401/403.
   */
  setRequiredChecks(
    branch: string,
    contexts: string[],
    create: boolean,
  ): Promise<void>;
}

/**
 * In-memory {@link BranchProtection} for tests — no network.
 *
 * State model: `contexts` is the required-check list; `null` means no checks
 * section. `protected` says whether the branch has protection at all (implied
 * true when `contexts` is a list). So `contexts=null, protected=true` models the
 * dangerous protected-without-checks state, and `contexts=null,
 * protected=false` a genuinely unprotected branch. `admin=false` →
 * reads/writes reject (no scope); `plan_supported=false` → writes reject.
 * `read_error` injects an arbitrary read failure.
 */
export class FakeBranchProtectionClient implements BranchProtection {
  contexts: string[] | null;
  protected: boolean;
  admin: boolean;
  plan_supported: boolean;
  observed: string[];
  read_error: Error | null;
  write_count: number;
  last_create: boolean | null;
  private store: Map<string, string[]>;

  constructor(
    init: {
      contexts?: string[] | null;
      protected?: boolean;
      admin?: boolean;
      plan_supported?: boolean;
      observed?: string[];
      read_error?: Error | null;
    } = {},
  ) {
    this.contexts = init.contexts ?? null;
    this.protected = init.protected ?? false;
    this.admin = init.admin ?? true;
    this.plan_supported = init.plan_supported ?? true;
    this.observed = init.observed ?? [];
    this.read_error = init.read_error ?? null;
    this.write_count = 0;
    this.last_create = null;
    this.store = new Map();

    // Mirrors the Python dataclass `__post_init__`: a seeded contexts list
    // implies the branch is protected, and is always stored under "main".
    if (this.contexts !== null) {
      this.store.set('main', [...this.contexts]);
      this.protected = true;
    }
  }

  contextsFor(branch: string): string[] | null {
    return this.store.get(branch) ?? null;
  }

  async requiredCheckContexts(branch: string): Promise<string[] | null> {
    if (this.read_error !== null) {
      throw this.read_error;
    }
    if (!this.admin) {
      throw new GitHubPermissionError(
        'token lacks admin scope for branch protection',
      );
    }
    const stored = this.store.get(branch);
    if (stored !== undefined) {
      return stored;
    }
    return this.protected ? [] : null;
  }

  async observedCheckContexts(branch: string): Promise<string[]> {
    void branch;
    return [...this.observed];
  }

  async setRequiredChecks(
    branch: string,
    contexts: string[],
    create: boolean,
  ): Promise<void> {
    if (!this.admin) {
      throw new GitHubPermissionError('token lacks admin scope');
    }
    if (!this.plan_supported) {
      throw new GitHubPermissionError(
        'Upgrade your plan to use branch protection on this repository',
      );
    }
    this.write_count += 1;
    this.last_create = create;
    this.store.set(branch, [...contexts]);
  }
}

/**
 * Manual steps to require the guardian check — the fallback when canary can't
 * do it (no admin, unsupported plan, bad token, network error).
 */
export function renderPlaybook(
  repo: string,
  branch: string,
  checkContext: string,
): string {
  return (
    `Manual steps to require the '${checkContext}' check on ` +
    `${repo}@${branch}:\n` +
    `  1. Open https://github.com/${repo}/settings/branches\n` +
    `  2. Add or edit a branch protection rule for '${branch}'.\n` +
    `  3. Enable 'Require status checks to pass before merging' and add ` +
    `'${checkContext}' to the required checks.\n` +
    `Or, with an admin token, run:\n` +
    `  gh api -X PATCH ` +
    `repos/${repo}/branches/${branch}/protection/required_status_checks ` +
    `-f 'checks[][context]=${checkContext}'\n` +
    `Confirm '${checkContext}' is the exact context a recent PR reported ` +
    `(a wrong name registers a gate that never fires — and can block every ` +
    `merge).`
  );
}

/**
 * Register `checkContext` as required on `branch`.
 *
 * Verifies the context is one a recent commit actually reported (unless
 * `force`) so we never register a phantom check that would block every merge.
 * Returns the plan on success (including the idempotent already-required
 * no-op). Rejects with {@link HardGateBlocked} carrying a playbook on any
 * barrier.
 */
export async function applyHardGate(
  client: BranchProtection,
  repo: string,
  branch: string,
  checkContext: string,
  force = false,
): Promise<HardGatePlan> {
  const playbook = renderPlaybook(repo, branch, checkContext);
  const blocked = (reason: string): HardGateBlocked =>
    new HardGateBlocked(reason, playbook);

  // --- verify the context is real, before we touch protection ---
  if (!force) {
    let observed: string[];
    try {
      observed = await client.observedCheckContexts(branch);
    } catch {
      // Python catches (GitHubPermissionError, OSError) → best-effort empty.
      observed = [];
    }
    if (observed.length === 0) {
      throw blocked(
        `could not confirm any check has reported on ${repo}@${branch}, ` +
          `so cannot verify '${checkContext}' is a real context; ` +
          'requiring an unreported check would block every merge. ' +
          'Open a PR so the guardian check runs at least once, or pass ' +
          '--force to register it anyway.',
      );
    }
    if (!observed.includes(checkContext)) {
      const sorted = [...observed].sort();
      throw blocked(
        `'${checkContext}' is not among the checks recently reported on ` +
          `${repo}@${branch}: ${reprList(sorted)}. Requiring it would block ` +
          'every merge. Re-run --check with one of those, or --force to ' +
          'override.',
      );
    }
  }

  // --- read state (disambiguating unprotected vs protected-without-checks) ---
  let existing: string[] | null;
  try {
    existing = await client.requiredCheckContexts(branch);
  } catch (err) {
    if (err instanceof GitHubPermissionError) {
      throw blocked(
        `cannot read branch protection for ${repo}@${branch}: ${err.message}`,
      );
    }
    // OSError analog: URLError / timeout / non-403 HTTPError.
    throw blocked(
      `failed reading branch protection for ${repo}@${branch}: ${errText(err)}`,
    );
  }

  const plan = planHardGate(existing, checkContext, branch);
  if (plan.already_required) {
    return plan;
  }

  try {
    await client.setRequiredChecks(
      branch,
      plan.resulting_contexts,
      plan.creates_protection,
    );
  } catch (err) {
    if (err instanceof GitHubPermissionError) {
      throw blocked(
        `cannot update branch protection for ${repo}@${branch}: ${err.message}`,
      );
    }
    throw blocked(
      `failed updating branch protection for ${repo}@${branch}: ${errText(err)}`,
    );
  }
  return plan;
}

/** Render a string list the way Python's `repr(list)` reads: `['a', 'b']`. */
function reprList(items: string[]): string {
  return `[${items.map((s) => `'${s}'`).join(', ')}]`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A GitHub REST HTTP error carrying its status, the analog of urllib's
 * `HTTPError.code`. Thrown by {@link RestBranchProtectionClient} for non-2xx
 * responses other than 401/403 so the 404 disambiguation can inspect the code.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Thin real {@link BranchProtection} over the GitHub REST API (`fetch`). */
export class RestBranchProtectionClient implements BranchProtection {
  private static readonly API = 'https://api.github.com';

  constructor(
    private readonly repo: string,
    private readonly token: string,
  ) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const url = `${RestBranchProtectionClient.API}/repos/${this.repo}/${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(url, init);
    if (!resp.ok) {
      // 401 (bad/expired token) and 403 (no admin scope / rate limit) both mean
      // "we can't proceed here" → permission error → playbook.
      if (resp.status === 401 || resp.status === 403) {
        throw new GitHubPermissionError(
          `HTTP ${resp.status}: ${resp.statusText || 'forbidden'}`,
        );
      }
      // Other codes propagate as a status-bearing error → fail-loud, and the
      // 404 disambiguation reads `.status`.
      throw new HttpError(
        resp.status,
        `HTTP ${resp.status}: ${resp.statusText || ''}`,
      );
    }
    const raw = (await resp.text()) || '{}';
    return JSON.parse(raw) as Record<string, unknown>;
  }

  private async branchIsUnprotected(branch: string): Promise<boolean> {
    // True only if the branch has NO protection object at all (parent 404). A
    // protected branch without a checks section returns 200 here.
    try {
      await this.request('GET', `branches/${branch}/protection`);
      return false;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        return true;
      }
      throw err;
    }
  }

  async requiredCheckContexts(branch: string): Promise<string[] | null> {
    let data: Record<string, unknown>;
    try {
      data = await this.request(
        'GET',
        `branches/${branch}/protection/required_status_checks`,
      );
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // Ambiguous 404: genuinely unprotected, OR protected without a checks
        // section. Only the former may take the create path.
        return (await this.branchIsUnprotected(branch)) ? null : [];
      }
      throw err;
    }
    const checks = data['checks'];
    if (Array.isArray(checks)) {
      return checks
        .map((c) => (isRecord(c) ? String(c['context'] ?? '') : ''))
        .filter((context) => context !== '');
    }
    const contexts = data['contexts'];
    return Array.isArray(contexts) ? (contexts as string[]) : []; // legacy shape
  }

  async observedCheckContexts(branch: string): Promise<string[]> {
    let data: Record<string, unknown>;
    try {
      data = await this.request('GET', `commits/${branch}/check-runs`);
    } catch (err) {
      // URLError / GitHubPermissionError → best-effort empty. (An HttpError for
      // another status also degrades to empty here, matching the Python
      // best-effort intent for observed checks.)
      void err;
      return [];
    }
    const runs = data['check_runs'];
    if (!Array.isArray(runs)) {
      return [];
    }
    const names = new Set<string>();
    for (const r of runs) {
      if (isRecord(r)) {
        const name = String(r['name'] ?? '');
        if (name !== '') names.add(name);
      }
    }
    return [...names].sort();
  }

  async setRequiredChecks(
    branch: string,
    contexts: string[],
    create: boolean,
  ): Promise<void> {
    const checks = contexts.map((c) => ({ context: c }));
    if (create) {
      // Genuinely unprotected — PUT a minimal ruleset requiring only the checks;
      // other protections stay unset.
      await this.request('PUT', `branches/${branch}/protection`, {
        required_status_checks: { strict: false, checks },
        enforce_admins: null,
        required_pull_request_reviews: null,
        restrictions: null,
      });
    } else {
      // Protected already — PATCH the sub-resource (a partial update that
      // touches ONLY required status checks, preserving reviews / restrictions /
      // enforce_admins / the existing `strict` flag).
      await this.request(
        'PATCH',
        `branches/${branch}/protection/required_status_checks`,
        { checks },
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
