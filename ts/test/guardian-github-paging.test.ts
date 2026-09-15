/**
 * Tests for GitHub REST pagination (#528).
 *
 * The defect these lock down: both guardian REST clients called GitHub's list
 * endpoints with no `per_page` and no `Link` following, so every read stopped
 * at GitHub's default 30 rows and said nothing. A PR with >30 comments hid the
 * sticky comment (guardian then posted a duplicate and recorded no
 * adjudication); a sticky with >30 reactions biased the precision tally toward
 * whichever verdicts happened to sort first.
 *
 * Truncation is the failure mode, so the assertions are about the DENOMINATOR:
 * every page is read, and a read that cannot complete throws rather than
 * returning a short list that looks like a full one.
 *
 * Network-free: the paging loop takes an injected {@link PageReader}, so these
 * drive the real clients' paging wiring without a socket.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PER_PAGE,
  MAX_PAGES,
  PageReader,
  parseNextLink,
  readAllPages,
  withPerPage,
} from '../src/guardian/github-paging.js';
import {
  GitHubAdjudicationSource,
  revisionsFrom,
} from '../src/guardian/adjudication-github.js';
import { Comment } from '../src/guardian/pr-comment.js';

const API = 'https://api.github.com';

/** What `readAllPages` actually requests first: the start URL + `per_page`. */
const firstPage = (url: string): string =>
  `${url}${url.includes('?') ? '&' : '?'}per_page=${DEFAULT_PER_PAGE}`;

/** A reader serving fixed pages keyed by URL, recording what was requested. */
function pagedReader(pages: { url: string; body: unknown; next?: string }[]): {
  read: PageReader;
  requested: string[];
} {
  const requested: string[] = [];
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const read: PageReader = async (url) => {
    requested.push(url);
    const page = byUrl.get(url);
    if (page === undefined) throw new Error(`unexpected URL: ${url}`);
    return {
      body: page.body,
      linkHeader: page.next === undefined ? null : `<${page.next}>; rel="next"`,
    };
  };
  return { read, requested };
}

/** `n` comment rows numbered from `start`, so pages are distinguishable. */
function comments(start: number, n: number): Comment[] {
  return Array.from({ length: n }, (_, i) => ({
    id: start + i,
    body: `comment ${start + i}`,
  }));
}

describe('parseNextLink', () => {
  it('returns null when there is no Link header at all', () => {
    expect(parseNextLink(null)).toBeNull();
    expect(parseNextLink('')).toBeNull();
  });

  it('extracts the rel="next" URL', () => {
    const header = `<${API}/x?page=2>; rel="next", <${API}/x?page=9>; rel="last"`;
    expect(parseNextLink(header)).toBe(`${API}/x?page=2`);
  });

  it('returns null on the LAST page, where only prev/first are offered', () => {
    const header = `<${API}/x?page=8>; rel="prev", <${API}/x?page=1>; rel="first"`;
    expect(parseNextLink(header)).toBeNull();
  });

  it('accepts an unquoted rel and tolerates extra whitespace', () => {
    expect(parseNextLink(`  <${API}/x?page=2> ;  rel=next `)).toBe(
      `${API}/x?page=2`,
    );
  });

  it('returns null for a malformed header rather than guessing a URL', () => {
    expect(parseNextLink('garbage; rel="next"')).toBeNull();
  });
});

describe('withPerPage', () => {
  it('adds the max page size to a bare URL', () => {
    expect(withPerPage(`${API}/repos/o/r/issues/1/comments`)).toBe(
      `${API}/repos/o/r/issues/1/comments?per_page=${DEFAULT_PER_PAGE}`,
    );
  });

  it('preserves an existing query string', () => {
    const out = withPerPage(`${API}/x?sort=created`);
    expect(out).toContain('sort=created');
    expect(out).toContain(`per_page=${DEFAULT_PER_PAGE}`);
  });

  it('does not override an explicit per_page', () => {
    expect(withPerPage(`${API}/x?per_page=5`)).toBe(`${API}/x?per_page=5`);
  });
});

describe('readAllPages', () => {
  it('requests the max page size on the first read', async () => {
    const { read, requested } = pagedReader([
      { url: firstPage(`${API}/x`), body: comments(1, 3) },
    ]);
    await readAllPages(`${API}/x`, read);
    expect(requested).toEqual([`${API}/x?per_page=${DEFAULT_PER_PAGE}`]);
  });

  it('returns the rows of a single unpaginated response', async () => {
    const { read } = pagedReader([
      { url: firstPage(`${API}/x`), body: comments(1, 3) },
    ]);
    expect(await readAllPages(`${API}/x`, read)).toHaveLength(3);
  });

  it('concatenates every page, in order, when Link advertises more', async () => {
    const { read, requested } = pagedReader([
      {
        url: firstPage(`${API}/x`),
        body: comments(1, 100),
        next: `${API}/x?page=2`,
      },
      {
        url: `${API}/x?page=2`,
        body: comments(101, 100),
        next: `${API}/x?page=3`,
      },
      { url: `${API}/x?page=3`, body: comments(201, 7) },
    ]);
    const rows = (await readAllPages(`${API}/x`, read)) as Comment[];
    expect(rows).toHaveLength(207);
    expect(rows[0]!.id).toBe(1);
    expect(rows.at(-1)!.id).toBe(207);
    expect(requested).toHaveLength(3);
  });

  it('treats a non-array body as zero rows instead of throwing', async () => {
    const { read } = pagedReader([
      { url: firstPage(`${API}/x`), body: { message: 'x' } },
    ]);
    expect(await readAllPages(`${API}/x`, read)).toEqual([]);
  });

  it('throws on a Link cycle rather than looping forever', async () => {
    // GitHub echoes its own URLs in Link, so a genuine cycle re-offers a URL
    // byte-for-byte; the guard is exact-match on what was already requested.
    const { read } = pagedReader([
      {
        url: firstPage(`${API}/x`),
        body: comments(1, 1),
        next: `${API}/y`,
      },
      { url: `${API}/y`, body: comments(2, 1), next: firstPage(`${API}/x`) },
    ]);
    await expect(readAllPages(`${API}/x`, read)).rejects.toThrow(/cycle/i);
  });

  it('throws past the page cap instead of returning a truncated list', async () => {
    // Every page advertises another, so the cap is the only thing that stops
    // it. A silent `break` here would be the #528 defect rebuilt inside its
    // own fix: a short list that reads as a complete one.
    const read: PageReader = async (url) => ({
      body: comments(1, 100),
      linkHeader: `<${url}+>; rel="next"`,
    });
    await expect(readAllPages(`${API}/x`, read)).rejects.toThrow(
      new RegExp(String(MAX_PAGES)),
    );
  });
});

describe('GitHubAdjudicationSource paging and history (ADR 0025)', () => {
  const BOT = { login: 'github-actions[bot]', type: 'Bot' };
  const marker = '<!-- canary-pr-guardian -->';

  it('finds the bot sticky beyond page 1 and returns its revisions', async () => {
    const stickyRow = {
      id: 45,
      node_id: 'IC_45',
      body: `${marker}\nlast`,
      user: BOT,
    };
    const { read } = pagedReader([
      {
        url: `${API}/repos/o/r/issues/7/comments?per_page=${DEFAULT_PER_PAGE}`,
        body: comments(1, 30),
        next: `${API}/repos/o/r/issues/7/comments?page=2`,
      },
      {
        url: `${API}/repos/o/r/issues/7/comments?page=2`,
        body: [...comments(31, 14), stickyRow],
      },
    ]);
    const asked: unknown[] = [];
    const edits = {
      totalCount: 2,
      nodes: [{ diff: `${marker}\nlast` }, { diff: `${marker}\nfirst` }],
    };
    const graphql = async (_q: string, vars: Record<string, unknown>) => {
      asked.push(vars['id']);
      return { node: { userContentEdits: edits } };
    };
    const source = new GitHubAdjudicationSource('o/r', 'tok', {
      read,
      graphql,
    });
    const history = await source.stickyHistory(7);
    expect(asked).toEqual(['IC_45']);
    expect(history?.revisions?.[0]).toContain('first');
    expect(history?.revisions?.at(-1)).toContain('last');
  });

  it('a human comment carrying the marker is not the sticky (#931)', async () => {
    const human = { id: 1, body: `${marker}\npasted`, user: { login: 'bri' } };
    const { read } = pagedReader([
      {
        url: `${API}/repos/o/r/issues/7/comments?per_page=${DEFAULT_PER_PAGE}`,
        body: [human],
      },
    ]);
    const graphql = async () => {
      throw new Error('no sticky: must not query edits');
    };
    const source = new GitHubAdjudicationSource('o/r', 'tok', {
      read,
      graphql,
    });
    expect(await source.stickyHistory(7)).toBeNull();
  });

  it('refuses a merged-PR window past the bound instead of truncating', async () => {
    const graphql = async () => ({
      search: { issueCount: 400, nodes: [{ number: 1 }] },
    });
    const source = new GitHubAdjudicationSource('o/r', 'tok', { graphql });
    await expect(source.mergedPrs('2026-09-01')).rejects.toThrow(
      /narrow --days/,
    );
  });

  it('lists merged PR numbers and reads merged files through paging', async () => {
    const graphql = async () => ({
      search: { issueCount: 2, nodes: [{ number: 3 }, { number: 4 }] },
    });
    const { read } = pagedReader([
      {
        url: `${API}/repos/o/r/pulls/3/files?per_page=${DEFAULT_PER_PAGE}`,
        body: [{ filename: 'src/a.ts', patch: '+x' }],
      },
    ]);
    const source = new GitHubAdjudicationSource('o/r', 'tok', {
      read,
      graphql,
    });
    expect(await source.mergedPrs('2026-09-01')).toEqual([3, 4]);
    expect(await source.prFiles(3)).toEqual([
      { filename: 'src/a.ts', patch: '+x' },
    ]);
  });
});

describe('revisionsFrom', () => {
  it('a never-edited sticky has one revision, its body', () => {
    expect(revisionsFrom('b', { totalCount: 0, nodes: [] })).toEqual(['b']);
  });

  it('a truncated history is null, never a shorter list', () => {
    expect(
      revisionsFrom('b', { totalCount: 3, nodes: [{ diff: 'a' }] }),
    ).toBeNull();
  });

  it('a redacted revision or absent history is null', () => {
    expect(
      revisionsFrom('b', { totalCount: 1, nodes: [{ diff: null }] }),
    ).toBeNull();
    expect(revisionsFrom('b', undefined)).toBeNull();
  });
});

// `RestGitHubClient`'s paging is covered at the `fetch` level in
// `guardian-rest-clients.test.ts`, which is strictly more realistic than the
// injected seam — it exercises the real Link header off a real Response shape.
