/**
 * GitHub evidence for derived adjudication (ADR 0025, #938).
 *
 * The network seam behind `adjudication.ts`: merged PRs in a window (GraphQL
 * search), the guardian sticky's edit history (REST comments + GraphQL
 * `userContentEdits`), and the merged file patches (REST). The sticky is found
 * with the author-aware {@link findSticky} (#931), never by marker substring.
 *
 * Network lives ONLY in {@link GitHubAdjudicationSource}'s default seams;
 * tests use {@link FakeAdjudicationSource} or inject `read` / `graphql`.
 */

import { PrEvidence, PrFile } from './adjudication.js';
import { PageReader, readAllPages, restPageReader } from './github-paging.js';
import { Comment, findSticky } from './pr-comment.js';

const API = 'https://api.github.com';

/** The most merged PRs one report walks (bounds API cost and rate limits). */
export const MERGED_PR_LIMIT = 300;

/** `revisions` oldest to newest, or `null` when history is not retrievable. */
export interface StickyHistory {
  revisions: string[] | null;
}

/** Read-only GitHub access the report needs. */
export interface AdjudicationSource {
  mergedPrs(since: string): Promise<number[]>;
  /** `null` when the PR has no guardian sticky. */
  stickyHistory(pr: number): Promise<StickyHistory | null>;
  prFiles(pr: number): Promise<PrFile[]>;
}

/** In-memory {@link AdjudicationSource} for tests. */
export class FakeAdjudicationSource implements AdjudicationSource {
  constructor(
    private readonly init: {
      merged: number[];
      stickies?: Record<number, string[] | null>;
      files?: Record<number, PrFile[]>;
    },
  ) {}

  async mergedPrs(): Promise<number[]> {
    return this.init.merged;
  }

  async stickyHistory(pr: number): Promise<StickyHistory | null> {
    const revisions = this.init.stickies?.[pr];
    return revisions === undefined ? null : { revisions };
  }

  async prFiles(pr: number): Promise<PrFile[]> {
    return this.init.files?.[pr] ?? [];
  }
}

/** POSTs one GraphQL query and returns its `data` (throws on `errors`). */
export type GraphqlPost = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

interface EditHistory {
  totalCount: number;
  nodes: Array<{ diff: string | null }>;
}

/**
 * Sticky bodies oldest to newest. GitHub returns edits newest first and each
 * `diff` holds the whole body at that revision. A truncated or redacted
 * history is `null` (disclosed as "no edit history"), never a shorter list.
 */
export function revisionsFrom(
  body: string,
  edits: EditHistory | null | undefined,
): string[] | null {
  if (!edits) return null;
  if (edits.totalCount === 0) return [body];
  const diffs = edits.nodes.map((n) => n.diff);
  if (diffs.length < edits.totalCount || diffs.includes(null)) return null;
  return [...(diffs as string[]).reverse(), body];
}

interface SearchPage {
  issueCount: number;
  nodes: Array<{ number: number }>;
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}

const SEARCH_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number } } } }`;

const EDITS_QUERY = `query($id: ID!) { node(id: $id) { ... on IssueComment {
  userContentEdits(first: 100) { totalCount nodes { diff } } } } }`;

function defaultGraphql(token: string): GraphqlPost {
  return async (query, variables) => {
    const resp = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'canary-pr-guardian',
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await resp.json()) as {
      data?: Record<string, unknown>;
      errors?: unknown;
    };
    if (!resp.ok || json.errors || !json.data) {
      throw new Error(`GitHub GraphQL ${resp.status}: ${JSON.stringify(json)}`);
    }
    return json.data;
  };
}

/** The real {@link AdjudicationSource} over GitHub REST + GraphQL. */
export class GitHubAdjudicationSource implements AdjudicationSource {
  private readonly read: PageReader;
  private readonly graphql: GraphqlPost;

  constructor(
    private readonly repo: string,
    token: string,
    seams: { read?: PageReader; graphql?: GraphqlPost } = {},
  ) {
    this.read =
      seams.read ??
      restPageReader(
        {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'canary-pr-guardian',
        },
        (status, url) => new Error(`GitHub API ${status}: ${url}`),
      );
    this.graphql = seams.graphql ?? defaultGraphql(token);
  }

  /** Pages the search; refuses a window past {@link MERGED_PR_LIMIT} rather than truncating. */
  async mergedPrs(since: string): Promise<number[]> {
    const q = `repo:${this.repo} is:pr is:merged merged:>=${since}`;
    const numbers: number[] = [];
    let after: string | null = null;
    do {
      const data = await this.graphql(SEARCH_QUERY, { q, after });
      const search = data['search'] as SearchPage;
      if (search.issueCount > MERGED_PR_LIMIT) {
        throw new Error(
          `${search.issueCount} merged PRs since ${since} exceeds the ` +
            `${MERGED_PR_LIMIT}-PR bound; narrow --days`,
        );
      }
      numbers.push(...search.nodes.map((n) => n.number));
      after = search.pageInfo?.hasNextPage ? search.pageInfo.endCursor : null;
    } while (after !== null);
    return numbers;
  }

  async stickyHistory(pr: number): Promise<StickyHistory | null> {
    const url = `${API}/repos/${this.repo}/issues/${pr}/comments`;
    const comments = (await readAllPages(url, this.read)) as Comment[];
    const sticky = findSticky(comments) as
      (Comment & { node_id?: string }) | null;
    if (sticky === null) return null;
    const data = await this.graphql(EDITS_QUERY, { id: sticky.node_id });
    const node = data['node'] as { userContentEdits?: EditHistory } | null;
    return { revisions: revisionsFrom(sticky.body, node?.userContentEdits) };
  }

  async prFiles(pr: number): Promise<PrFile[]> {
    const url = `${API}/repos/${this.repo}/pulls/${pr}/files`;
    return (await readAllPages(url, this.read)) as PrFile[];
  }
}

/** Walk the merged PRs; PRs without a sticky are scanned but carry no evidence. */
export async function collectEvidence(
  source: AdjudicationSource,
  since: string,
): Promise<{ evidence: PrEvidence[]; scanned: number }> {
  const merged = await source.mergedPrs(since);
  const evidence: PrEvidence[] = [];
  for (const number of merged) {
    const history = await source.stickyHistory(number);
    if (history === null) continue;
    evidence.push({
      number,
      revisions: history.revisions,
      files: await source.prFiles(number),
    });
  }
  return { evidence, scanned: merged.length };
}
