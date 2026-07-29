/**
 * #452 — reachability sweep: link half.
 *
 * A generic crawl primitive. Enumerate every link on a surface and assert it
 * resolves, with a configurable allowlist controlling how far off-site the
 * sweep reaches. Cheap, broad, high-yield: it catches the 404s and dangling
 * routes that targeted tests never look for.
 *
 * The load-bearing requirement, and the reason this is not just "fetch and
 * check the status": **a dead link and a slow link must never be confusable.**
 * A 404 is a defect the sweep is entitled to assert on. A timeout, a DNS
 * failure, or a refused connection is *inconclusive* — the link may be
 * perfectly fine and the network (or a cold container, or a rate limiter) may
 * not be. Reporting the second as the first is how a sweep becomes a flaky test
 * that teams learn to ignore, which destroys the value of the whole check.
 *
 * That distinction is structural here (`broken` vs `unreachable` are different
 * outcomes with different `isDefect` verdicts), not a nuance of wording.
 *
 * Network access is behind an injected fetcher, so these tests never touch it.
 */

import { describe, expect, it } from 'vitest';

import {
  LinkProbe,
  ProbeOutcome,
  ReachabilityStatus,
  createHttpProbe,
  isDefect,
  normalizeLink,
  sweepLinks,
  sweepLinksAsync,
} from '../src/analysis/reachability.js';

const BASE = 'https://app.example.com/docs/intro';

/** Build a fake probe from a `{url: outcome}` table. Unlisted → 200. */
function fakeProbe(table: Record<string, ProbeOutcome>): LinkProbe {
  const calls: string[] = [];
  const probe: LinkProbe = (url) => {
    calls.push(url);
    return table[url] ?? { kind: 'status', status: 200 };
  };
  return Object.assign(probe, { calls });
}

const ok = (status = 200): ProbeOutcome => ({ kind: 'status', status });
const failed = (reason: string): ProbeOutcome => ({ kind: 'failed', reason });

// --- normalizeLink ------------------------------------------------------------

describe('normalizeLink (#452)', () => {
  it('resolves a relative href against the page URL', () => {
    expect(normalizeLink('../guide', BASE)?.url).toBe(
      'https://app.example.com/guide',
    );
  });

  it('resolves a root-relative href', () => {
    expect(normalizeLink('/pricing', BASE)?.url).toBe(
      'https://app.example.com/pricing',
    );
  });

  it('drops the fragment so #a and #b are one link', () => {
    const a = normalizeLink('/pricing#plans', BASE)?.url;
    const b = normalizeLink('/pricing#faq', BASE)?.url;
    expect(a).toBe(b);
  });

  it.each(['mailto:x@example.com', 'tel:+15551234', 'javascript:void(0)'])(
    'refuses to treat %s as fetchable',
    (href) => {
      expect(normalizeLink(href, BASE)).toBeNull();
    },
  );

  it.each(['', '   ', '#', '#section'])('ignores the empty href %p', (href) => {
    expect(normalizeLink(href, BASE)).toBeNull();
  });

  it('returns null on an unparseable href rather than throwing', () => {
    // A malformed authority is one of the few things WHATWG `URL` actually
    // rejects when given a base; most junk resolves to a same-host path.
    expect(normalizeLink('http://[', BASE)).toBeNull();
  });

  it('resolves a protocol-relative href against the base scheme', () => {
    expect(normalizeLink('//cdn.example.net/a', BASE)?.url).toBe(
      'https://cdn.example.net/a',
    );
  });
});

// --- dead vs. slow ------------------------------------------------------------

describe('dead vs. slow must not be confusable (#452)', () => {
  it('classifies 404 as broken, and broken IS a defect', () => {
    const report = sweepLinks(['/gone'], {
      base: BASE,
      probe: fakeProbe({ 'https://app.example.com/gone': ok(404) }),
    });

    expect(report.results[0]!.status).toBe(ReachabilityStatus.Broken);
    expect(isDefect(report.results[0]!.status)).toBe(true);
  });

  it('classifies a timeout as unreachable, and unreachable is NOT a defect', () => {
    const report = sweepLinks(['/slow'], {
      base: BASE,
      probe: fakeProbe({ 'https://app.example.com/slow': failed('timeout') }),
    });

    expect(report.results[0]!.status).toBe(ReachabilityStatus.Unreachable);
    // The whole point: a slow link must never be reported as a dead one.
    expect(isDefect(report.results[0]!.status)).toBe(false);
  });

  it('counts unreachable separately from broken in the summary', () => {
    const report = sweepLinks(['/gone', '/slow'], {
      base: BASE,
      probe: fakeProbe({
        'https://app.example.com/gone': ok(404),
        'https://app.example.com/slow': failed('ETIMEDOUT'),
      }),
    });

    expect(report.summary.broken).toBe(1);
    expect(report.summary.unreachable).toBe(1);
    expect(report.summary.defects).toBe(1);
  });

  it('preserves the failure reason so an inconclusive result is explainable', () => {
    const report = sweepLinks(['/slow'], {
      base: BASE,
      probe: fakeProbe({
        'https://app.example.com/slow': failed('ECONNREFUSED'),
      }),
    });

    expect(report.results[0]!.detail).toContain('ECONNREFUSED');
  });
});

// --- status classification ----------------------------------------------------

describe('status classification (#452)', () => {
  it.each([200, 201, 204, 299])('treats %i as ok', (status) => {
    const report = sweepLinks(['/x'], {
      base: BASE,
      probe: fakeProbe({ 'https://app.example.com/x': ok(status) }),
    });
    expect(report.results[0]!.status).toBe(ReachabilityStatus.Ok);
  });

  it.each([301, 302, 307, 308])('treats redirect %i as ok', (status) => {
    const report = sweepLinks(['/x'], {
      base: BASE,
      probe: fakeProbe({ 'https://app.example.com/x': ok(status) }),
    });
    expect(report.results[0]!.status).toBe(ReachabilityStatus.Ok);
  });

  it.each([400, 404, 410])('treats client error %i as broken', (status) => {
    const report = sweepLinks(['/x'], {
      base: BASE,
      probe: fakeProbe({ 'https://app.example.com/x': ok(status) }),
    });
    expect(report.results[0]!.status).toBe(ReachabilityStatus.Broken);
  });

  it('treats a 5xx as a server error, reported but NOT a link defect', () => {
    // A 500 means the link points somewhere real that is currently unwell.
    // That is a server problem, not a dangling reference -- and blaming the
    // link would send someone to fix the wrong thing.
    const report = sweepLinks(['/x'], {
      base: BASE,
      probe: fakeProbe({ 'https://app.example.com/x': ok(503) }),
    });

    expect(report.results[0]!.status).toBe(ReachabilityStatus.ServerError);
    expect(isDefect(ReachabilityStatus.ServerError)).toBe(false);
  });

  it('treats 401/403 as ok — auth-walled is not dangling', () => {
    const report = sweepLinks(['/admin'], {
      base: BASE,
      probe: fakeProbe({ 'https://app.example.com/admin': ok(403) }),
    });
    expect(report.results[0]!.status).toBe(ReachabilityStatus.Ok);
  });
});

// --- scope / allowlist --------------------------------------------------------

describe('sweep scope (#452)', () => {
  it('skips external links by default and never probes them', () => {
    const probe = fakeProbe({});
    const report = sweepLinks(['https://third-party.example.net/x'], {
      base: BASE,
      probe,
    });

    expect(report.results[0]!.status).toBe(ReachabilityStatus.SkippedExternal);
    expect((probe as unknown as { calls: string[] }).calls).toEqual([]);
  });

  it('checks an external host when it is allowlisted', () => {
    const report = sweepLinks(['https://third-party.example.net/x'], {
      base: BASE,
      allowExternal: ['third-party.example.net'],
      probe: fakeProbe({ 'https://third-party.example.net/x': ok(404) }),
    });

    expect(report.results[0]!.status).toBe(ReachabilityStatus.Broken);
  });

  it('allowlists subdomains of an allowed host, not lookalikes', () => {
    const report = sweepLinks(
      ['https://cdn.trusted.example/a', 'https://nottrusted.example/b'],
      {
        base: BASE,
        allowExternal: ['trusted.example'],
        probe: fakeProbe({}),
      },
    );

    expect(report.results[0]!.status).toBe(ReachabilityStatus.Ok);
    // `nottrusted.example` merely ENDS WITH the allowed host; it is a different
    // domain and must not inherit its trust.
    expect(report.results[1]!.status).toBe(ReachabilityStatus.SkippedExternal);
  });

  it('probes each unique URL once no matter how often it appears', () => {
    const probe = fakeProbe({});
    sweepLinks(['/a', '/a', '/a#x', '/b'], { base: BASE, probe });

    expect((probe as unknown as { calls: string[] }).calls.sort()).toEqual([
      'https://app.example.com/a',
      'https://app.example.com/b',
    ]);
  });
});

// --- report -------------------------------------------------------------------

describe('sweep report (#452)', () => {
  it('summarises counts that add up to the result total', () => {
    const report = sweepLinks(
      ['/ok', '/gone', '/slow', 'https://ext.example.net/x', 'mailto:a@b.c'],
      {
        base: BASE,
        probe: fakeProbe({
          'https://app.example.com/gone': ok(404),
          'https://app.example.com/slow': failed('timeout'),
        }),
      },
    );

    const { summary, results } = report;
    expect(summary.total).toBe(results.length);
    expect(
      summary.ok + summary.broken + summary.unreachable + summary.skipped,
    ).toBe(summary.total);
  });

  it('orders results deterministically for a stable diff', () => {
    const opts = { base: BASE, probe: fakeProbe({}) };
    const a = sweepLinks(['/c', '/a', '/b'], opts).results.map((r) => r.url);
    const b = sweepLinks(['/b', '/c', '/a'], opts).results.map((r) => r.url);

    expect(a).toEqual(b);
  });

  it('reports an empty sweep as a clean zero, not an error', () => {
    const report = sweepLinks([], { base: BASE, probe: fakeProbe({}) });

    expect(report.summary.total).toBe(0);
    expect(report.summary.defects).toBe(0);
  });
});

// --- async driver + real transport -------------------------------------------

describe('sweepLinksAsync (#452)', () => {
  it('produces the same verdicts as the sync driver', async () => {
    const table: Record<string, ProbeOutcome> = {
      'https://app.example.com/gone': ok(404),
      'https://app.example.com/slow': failed('timeout'),
    };
    const hrefs = ['/ok', '/gone', '/slow', 'https://ext.example.net/x'];

    const sync = sweepLinks(hrefs, { base: BASE, probe: fakeProbe(table) });
    const async_ = await sweepLinksAsync(hrefs, {
      base: BASE,
      probe: (url) => Promise.resolve(fakeProbe(table)(url)),
    });

    // The two drivers share planning and classification; if they ever diverge
    // on order, scope, or verdict this is the test that catches it.
    expect(async_.results).toEqual(sync.results);
    expect(async_.summary).toEqual(sync.summary);
  });

  it('never probes a skipped external link', async () => {
    const seen: string[] = [];
    await sweepLinksAsync(['https://ext.example.net/x', '/local'], {
      base: BASE,
      probe: (url) => {
        seen.push(url);
        return Promise.resolve(ok());
      },
    });

    expect(seen).toEqual(['https://app.example.com/local']);
  });
});

describe('createHttpProbe (#452)', () => {
  it('reports a real HTTP status as a status, including 404', async () => {
    const probe = createHttpProbe({
      fetchImpl: (async () =>
        new Response('', { status: 404 })) as typeof fetch,
    });

    expect(await probe('https://app.example.com/gone')).toEqual({
      kind: 'status',
      status: 404,
    });
  });

  it('reports a transport error as failed, NOT as a status', async () => {
    const probe = createHttpProbe({
      fetchImpl: (() =>
        Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as typeof fetch,
    });
    const outcome = await probe('https://nope.example.com/x');

    // The single most important behaviour in this module: a network failure
    // must never be dressed up as an HTTP verdict.
    expect(outcome.kind).toBe('failed');
    expect(outcome).toMatchObject({
      reason: expect.stringContaining('ENOTFOUND'),
    });
  });

  it('falls back to GET when a server rejects HEAD', async () => {
    const methods: string[] = [];
    const probe = createHttpProbe({
      fetchImpl: ((_url: string, init: RequestInit) => {
        methods.push(String(init.method));
        // Some servers reject HEAD outright; treating that as a broken link
        // would be a false positive.
        return Promise.resolve(
          new Response('', { status: init.method === 'HEAD' ? 405 : 200 }),
        );
      }) as unknown as typeof fetch,
    });

    expect(await probe('https://app.example.com/x')).toEqual({
      kind: 'status',
      status: 200,
    });
    expect(methods).toEqual(['HEAD', 'GET']);
  });

  it('surfaces a timeout as failed with the budget in the reason', async () => {
    const probe = createHttpProbe({
      timeoutMs: 5,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        })) as unknown as typeof fetch,
    });
    const outcome = await probe('https://app.example.com/slow');

    expect(outcome.kind).toBe('failed');
    expect(outcome).toMatchObject({
      reason: expect.stringContaining('timeout'),
    });
  });
});
