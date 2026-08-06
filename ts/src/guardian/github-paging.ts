/**
 * GitHub REST pagination for the guardian's read paths (#528).
 *
 * Both guardian clients used to call GitHub's list endpoints bare, which caps
 * silently at the API default of 30 rows. That is the worst shape a denominator
 * can take: a zero would look wrong, but "30 of 30" reads as a complete sample.
 * A PR past 30 comments hid the sticky comment; a sticky past 30 reactions
 * biased the precision tally toward whichever verdicts sorted first.
 *
 * The loop lives here, behind an injected {@link PageReader}, so it is unit
 * tested while the network stays quarantined in the clients that construct the
 * real reader.
 */

/** GitHub's maximum page size for list endpoints. */
export const DEFAULT_PER_PAGE = 100;

/**
 * Page ceiling ({@link DEFAULT_PER_PAGE} * this = 2000 rows). Crossing it
 * throws rather than returning what was read so far: a partial list that the
 * caller cannot distinguish from a complete one is the defect this module
 * exists to remove, and rebuilding it inside the fix would be worse than the
 * original.
 */
export const MAX_PAGES = 20;

/** One page: the parsed JSON body plus the raw `Link` header (or null). */
export interface PageResponse {
  body: unknown;
  linkHeader: string | null;
}

/** Fetches one page. The seam that keeps {@link readAllPages} network-free. */
export type PageReader = (url: string) => Promise<PageResponse>;

/**
 * `<url>; rel="next"` entries in a `Link` header. The angle brackets are
 * required — a header with a bare `rel="next"` and no URL yields no match, so
 * a malformed header degrades to "no next page" instead of a guessed URL.
 */
const LINK_ENTRY = /<([^>]+)>\s*;\s*rel\s*=\s*"?([a-zA-Z]+)"?/g;

/** The `rel="next"` URL from a `Link` header, or null if there is no next. */
export function parseNextLink(header: string | null): string | null {
  if (header === null || header.trim() === '') return null;
  for (const match of header.matchAll(LINK_ENTRY)) {
    if (match[2]!.toLowerCase() !== 'next') continue;
    const url = match[1]!.trim();
    // Only absolute http(s) — never relay a relative or garbage target.
    return /^https?:\/\//i.test(url) ? url : null;
  }
  return null;
}

/**
 * Request the largest page GitHub will serve. An explicit `per_page` already on
 * the URL wins, so a caller can still ask for a small page deliberately.
 */
export function withPerPage(url: string, perPage = DEFAULT_PER_PAGE): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('per_page')) {
    parsed.searchParams.set('per_page', String(perPage));
  }
  return parsed.toString();
}

/**
 * Read every page from `startUrl`, following `Link: rel="next"`.
 *
 * Throws on a `Link` cycle or past {@link MAX_PAGES}; a non-array body counts
 * as zero rows (matching the clients' prior defensive shape for an error
 * payload). Never returns a short list quietly.
 */
export async function readAllPages(
  startUrl: string,
  read: PageReader,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  const visited = new Set<string>();
  let url: string | null = withPerPage(startUrl);
  let pages = 0;

  while (url !== null) {
    if (visited.has(url)) {
      throw new Error(`GitHub paging cycle: ${url} was already read`);
    }
    visited.add(url);
    pages += 1;
    if (pages > MAX_PAGES) {
      throw new Error(
        `GitHub paging exceeded ${MAX_PAGES} pages (${MAX_PAGES * DEFAULT_PER_PAGE}+ rows) ` +
          `starting at ${startUrl} -- refusing to report a truncated read`,
      );
    }
    const page = await read(url);
    if (Array.isArray(page.body)) rows.push(...page.body);
    url = parseNextLink(page.linkHeader);
  }
  return rows;
}

/**
 * A {@link PageReader} over `fetch`. The ONLY place in this module that touches
 * the network; `onError` lets each client keep its own status mapping (the
 * comment client distinguishes 403 as a permission error, the reactions client
 * does not).
 */
export function restPageReader(
  headers: Record<string, string>,
  onError: (status: number, url: string) => Error,
): PageReader {
  return async (url: string): Promise<PageResponse> => {
    const resp = await fetch(url, { method: 'GET', headers });
    if (!resp.ok) throw onError(resp.status, url);
    return { body: await resp.json(), linkHeader: resp.headers.get('link') };
  };
}
