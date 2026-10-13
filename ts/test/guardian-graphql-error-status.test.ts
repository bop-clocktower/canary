/**
 * The default GraphQL seam of `GitHubAdjudicationSource` parsed the response
 * body BEFORE checking the status. A gateway error from GitHub (502/503 with an
 * HTML body) therefore surfaced as `SyntaxError: Unexpected token '<'` and the
 * HTTP status the seam's own error message exists to report was lost.
 *
 * `fetch` is stubbed: no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubAdjudicationSource } from '../src/guardian/adjudication-github.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHubAdjudicationSource default GraphQL seam', () => {
  it('reports the HTTP status of a non-JSON error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><body>502 Bad Gateway</body></html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    const source = new GitHubAdjudicationSource('owner/repo', 'tok', {
      read: async () => ({ body: [], linkHeader: null }),
    });
    await expect(source.mergedPrs('2026-01-01')).rejects.toThrow(
      /GitHub GraphQL 502/,
    );
  });
});
