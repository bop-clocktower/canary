/**
 * Reachability sweep — the generic crawl primitive from #452.
 *
 * Enumerate every link on a surface and assert it resolves. Cheap, broad, and
 * high-yield: it catches dangling routes and 404s that targeted tests never
 * look for, because a targeted test asserts what a page *does*, not that the
 * things it points at still exist.
 *
 * This module owns the deterministic half — normalization, scoping, and
 * classification. **Fetching is injected** ({@link LinkProbe}), so the logic is
 * unit-testable with no network and a caller can supply whatever transport it
 * already has (plain `fetch`, an authenticated client, a browser page).
 *
 * ## The load-bearing distinction: dead vs. slow
 *
 * The reason this is not simply "fetch and check the status": **a dead link and
 * a slow link must never be confusable.** A 404 is a defect the sweep is
 * entitled to assert on. A timeout, DNS failure, or refused connection is
 * *inconclusive* — the link may be perfectly fine while the network, a cold
 * container, or a rate limiter is not.
 *
 * Conflating them is how a broad sweep turns into a flaky test that teams learn
 * to ignore, which costs more than the check was ever worth. So the two are
 * structurally different outcomes ({@link ReachabilityStatus.Broken} vs
 * {@link ReachabilityStatus.Unreachable}) with different {@link isDefect}
 * verdicts, and only the first is ever asserted on.
 *
 * The same principle decides the other ambiguous cases:
 *   - **5xx** — the target exists and is unwell. A server problem, not a
 *     dangling reference; blaming the link sends someone to fix the wrong
 *     thing.
 *   - **401/403** — auth-walled, not missing. The link is fine; the sweep just
 *     is not logged in.
 *
 * Only an unambiguous "this target does not exist" (4xx that is not auth)
 * counts as a defect.
 */

/** How a probed link resolved. Only {@link Broken} is asserted on. */
export enum ReachabilityStatus {
  /** Resolved (2xx/3xx), or exists but is auth-walled (401/403). */
  Ok = 'ok',
  /** The target does not exist (4xx other than auth). The one real defect. */
  Broken = 'broken',
  /** The target exists but errored (5xx) — a server problem, not a bad link. */
  ServerError = 'server-error',
  /** No verdict possible: timeout, DNS failure, refused connection. */
  Unreachable = 'unreachable',
  /** Off-site and not allowlisted, so deliberately not probed. */
  SkippedExternal = 'skipped-external',
}

/** The outcome of probing one URL: an HTTP status, or a transport failure. */
export type ProbeOutcome =
  { kind: 'status'; status: number } | { kind: 'failed'; reason: string };

/**
 * Injected transport. Returns `{kind:'status'}` when the server answered at
 * all, and `{kind:'failed'}` when the request never produced a response — the
 * seam that keeps "dead" and "slow" apart at the source.
 */
export type LinkProbe = (url: string) => ProbeOutcome;

/** A link resolved to an absolute, fragment-free URL. */
export interface NormalizedLink {
  url: string;
  host: string;
}

/** Per-link verdict. */
export interface LinkResult {
  url: string;
  status: ReachabilityStatus;
  /** HTTP status when the server answered; `null` when it never did. */
  httpStatus: number | null;
  /** Human-readable justification, including the transport failure reason. */
  detail: string;
}

/** Aggregate counts. `ok + broken + unreachable + skipped === total`. */
export interface SweepSummary {
  total: number;
  ok: number;
  broken: number;
  unreachable: number;
  skipped: number;
  /** Findings worth failing on — {@link ReachabilityStatus.Broken} only. */
  defects: number;
}

export interface SweepReport {
  results: LinkResult[];
  summary: SweepSummary;
}

export interface SweepOptions {
  /** The page URL relative hrefs resolve against. */
  base: string;
  probe: LinkProbe;
  /**
   * Off-site hosts to probe anyway. A host matches itself and its subdomains
   * (`trusted.example` covers `cdn.trusted.example`) but never a lookalike that
   * merely ends with the same text (`nottrusted.example`).
   */
  allowExternal?: string[];
}

// Schemes that are not fetchable resources. A `mailto:`/`tel:` is a valid link
// and probing it is meaningless; `javascript:` is a control, not a destination.
const NON_FETCHABLE_SCHEMES = new Set([
  'mailto:',
  'tel:',
  'javascript:',
  'data:',
  'blob:',
  'sms:',
  'file:',
]);

/** Auth-walled: the target exists, the sweep just cannot see it. */
const AUTH_STATUSES = new Set([401, 403]);

/**
 * Resolve `href` against `base` into an absolute, fragment-free URL.
 *
 * Returns `null` for anything that is not a fetchable destination: an empty or
 * fragment-only href (it points at the current page), a non-fetchable scheme,
 * or an href malformed enough that `URL` rejects it.
 *
 * The fragment is dropped deliberately — `/p#a` and `/p#b` are the same
 * request, and keeping them apart would probe the same page repeatedly and
 * report one dangling route as several.
 */
export function normalizeLink(
  href: string,
  base: string,
): NormalizedLink | null {
  const trimmed = href.trim();
  // Empty, or a pure fragment: this is the current page, not a destination.
  if (!trimmed || trimmed.startsWith('#')) return null;

  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }

  if (NON_FETCHABLE_SCHEMES.has(url.protocol)) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  return { url: url.href, host: url.hostname };
}

/** True iff `host` is `allowed` or a subdomain of it (never a lookalike). */
function hostMatches(host: string, allowed: string): boolean {
  const h = host.toLowerCase();
  const a = allowed.toLowerCase();
  // The leading dot is what stops `nottrusted.example` matching
  // `trusted.example` — a bare `endsWith` would wrongly accept it.
  return h === a || h.endsWith(`.${a}`);
}

/** True iff `link` is in scope: same host as the base, or allowlisted. */
function inScope(
  link: NormalizedLink,
  baseHost: string,
  allowExternal: string[],
): boolean {
  if (hostMatches(link.host, baseHost)) return true;
  return allowExternal.some((allowed) => hostMatches(link.host, allowed));
}

/** Map an HTTP status to a verdict. See the module docstring for the rationale. */
function classifyStatus(status: number): ReachabilityStatus {
  if (status >= 200 && status < 400) return ReachabilityStatus.Ok;
  // Auth-walled is not dangling: the target exists.
  if (AUTH_STATUSES.has(status)) return ReachabilityStatus.Ok;
  if (status >= 400 && status < 500) return ReachabilityStatus.Broken;
  if (status >= 500) return ReachabilityStatus.ServerError;
  // 1xx as a final status is nonsensical; refuse to guess.
  return ReachabilityStatus.Unreachable;
}

/**
 * True iff `status` is a finding worth failing a sweep on.
 *
 * Only {@link ReachabilityStatus.Broken}. `Unreachable` is inconclusive,
 * `ServerError` belongs to whoever owns the server, and a skipped link was
 * never claimed to be checked. Asserting on any of those would make the sweep
 * fail for reasons the author of the link cannot fix.
 */
export function isDefect(status: ReachabilityStatus): boolean {
  return status === ReachabilityStatus.Broken;
}

/**
 * Sweep `hrefs`, probing each unique in-scope URL exactly once.
 *
 * Results are sorted by URL so a sweep produces a stable, diffable report
 * regardless of the order links appeared on the page.
 */
export function sweepLinks(
  hrefs: readonly string[],
  options: SweepOptions,
): SweepReport {
  const { base, probe, allowExternal = [] } = options;
  const baseHost = new URL(base).hostname;

  // Dedup by normalized URL: a nav link repeated on every page is one check,
  // and one dangling route should be reported once, not once per referrer.
  const unique = new Map<string, NormalizedLink>();
  for (const href of hrefs) {
    const link = normalizeLink(href, base);
    if (link !== null && !unique.has(link.url)) unique.set(link.url, link);
  }

  const results: LinkResult[] = [];
  for (const { link, scoped } of planSweep(hrefs, base, allowExternal)) {
    results.push(
      scoped ? resolveOutcome(link, probe(link.url)) : skippedResult(link),
    );
  }
  return { results, summary: summarize(results) };
}

/** One planned probe: a unique in-order link plus whether it is in scope. */
interface PlannedLink {
  link: NormalizedLink;
  scoped: boolean;
}

/**
 * Normalize, dedup, sort, and scope `hrefs` — everything the sync and async
 * drivers must agree on. Shared so the two can never drift apart on which
 * links get probed or in what order.
 *
 * Dedup by normalized URL: a nav link repeated on every page is one check, and
 * one dangling route should be reported once, not once per referrer. Sorted by
 * URL so a sweep produces a stable, diffable report regardless of the order
 * links appeared on the page.
 */
function planSweep(
  hrefs: readonly string[],
  base: string,
  allowExternal: readonly string[],
): PlannedLink[] {
  const baseHost = new URL(base).hostname;
  const unique = new Map<string, NormalizedLink>();
  for (const href of hrefs) {
    const link = normalizeLink(href, base);
    if (link !== null && !unique.has(link.url)) unique.set(link.url, link);
  }
  return [...unique.values()]
    .sort((a, b) => a.url.localeCompare(b.url))
    .map((link) => ({
      link,
      scoped: inScope(link, baseHost, [...allowExternal]),
    }));
}

function skippedResult(link: NormalizedLink): LinkResult {
  return {
    url: link.url,
    status: ReachabilityStatus.SkippedExternal,
    httpStatus: null,
    detail: 'off-site and not allowlisted',
  };
}

/** Turn a probe outcome into a verdict, keeping dead and slow apart. */
function resolveOutcome(
  link: NormalizedLink,
  outcome: ProbeOutcome,
): LinkResult {
  if (outcome.kind === 'failed') {
    return {
      url: link.url,
      status: ReachabilityStatus.Unreachable,
      httpStatus: null,
      // The reason is carried verbatim: an inconclusive result is only
      // actionable if the reader can see WHY no verdict was reached.
      detail: `no response (${outcome.reason})`,
    };
  }
  return {
    url: link.url,
    status: classifyStatus(outcome.status),
    httpStatus: outcome.status,
    detail: `HTTP ${outcome.status}`,
  };
}

/** Async transport, for real network use. See {@link createHttpProbe}. */
export type AsyncLinkProbe = (url: string) => Promise<ProbeOutcome>;

export interface AsyncSweepOptions {
  base: string;
  probe: AsyncLinkProbe;
  allowExternal?: string[];
}

/**
 * {@link sweepLinks} over an async transport — the shape real network use takes.
 *
 * Probes sequentially on purpose. A sweep enumerates *every* link on a surface,
 * so firing them concurrently at one host is indistinguishable from a small
 * load test and invites the rate limiting that would then be misreported as
 * `unreachable`. A slow, correct sweep beats a fast, self-poisoning one.
 */
export async function sweepLinksAsync(
  hrefs: readonly string[],
  options: AsyncSweepOptions,
): Promise<SweepReport> {
  const { base, probe, allowExternal = [] } = options;
  const results: LinkResult[] = [];
  for (const { link, scoped } of planSweep(hrefs, base, allowExternal)) {
    results.push(
      scoped ? resolveOutcome(link, await probe(link.url)) : skippedResult(link),
    );
  }
  return { results, summary: summarize(results) };
}

/**
 * A `fetch`-backed {@link AsyncLinkProbe} that keeps dead and slow apart.
 *
 * Any outcome where the server answered — including a 404 — is a `status`. Any
 * outcome where no response arrived (timeout, DNS failure, refused connection)
 * is a `failed`, carrying its reason. Callers should use this rather than
 * hand-rolling a probe: deciding what counts as "no response" IS the guarantee
 * this module exists to provide, and re-implementing it per caller is how the
 * distinction gets quietly lost.
 *
 * Uses `HEAD`, falling back to `GET` when a server rejects `HEAD` outright
 * (405/501) — some servers do, and treating that as a broken link would be a
 * false positive.
 */
export function createHttpProbe(
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): AsyncLinkProbe {
  const { timeoutMs = 10_000, fetchImpl = fetch } = options;

  return async (url) => {
    const attempt = async (method: 'HEAD' | 'GET'): Promise<ProbeOutcome> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method,
          redirect: 'follow',
          signal: controller.signal,
        });
        return { kind: 'status', status: res.status };
      } catch (err) {
        const reason =
          controller.signal.aborted
            ? `timeout after ${timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : String(err);
        return { kind: 'failed', reason };
      } finally {
        clearTimeout(timer);
      }
    };

    const head = await attempt('HEAD');
    if (head.kind === 'status' && (head.status === 405 || head.status === 501)) {
      return attempt('GET');
    }
    return head;
  };
}

function summarize(results: readonly LinkResult[]): SweepSummary {
  const summary: SweepSummary = {
    total: results.length,
    ok: 0,
    broken: 0,
    unreachable: 0,
    skipped: 0,
    defects: 0,
  };
  for (const r of results) {
    switch (r.status) {
      case ReachabilityStatus.Broken:
        summary.broken += 1;
        break;
      case ReachabilityStatus.Unreachable:
        summary.unreachable += 1;
        break;
      case ReachabilityStatus.SkippedExternal:
        summary.skipped += 1;
        break;
      // A 5xx is counted with `ok` for the accounting identity (it is not a
      // link defect); it stays distinguishable via each result's own status.
      default:
        summary.ok += 1;
    }
    if (isDefect(r.status)) summary.defects += 1;
  }
  return summary;
}
