// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { define, loadFeed } from '../lib/site-kit/canary-site.js';
import { live } from './site-kit-helpers.js';

const TAGS = [
  'canary-pipeline-health',
  'canary-pass-rate',
  'canary-failures-by-area',
  'canary-flaky',
  'canary-pillars',
  'canary-register',
];
// Under happy-dom, new URL(rel, import.meta.url) resolves to http://localhost,
// which readFileSync refuses; build a file path instead.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(path.join(HERE, 'fixtures/contracts/site.valid.json'), 'utf8'),
);
type Panel = HTMLElement & { feed: { contract: string } | null };
const panels = () => TAGS.map((t) => document.querySelector(t) as Panel);
const respond = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));

beforeEach(() => {
  document.head.innerHTML = '<meta name="canary-feed" content="site.json">';
  document.body.innerHTML = TAGS.map((t) => `<${t}></${t}>`).join('');
});

describe('canary-site.js (#1151 phase 3)', () => {
  it('registers the six panels, and registering twice is harmless', () => {
    expect(() => define()).not.toThrow();
    for (const t of TAGS) expect(customElements.get(t)).toBeDefined();
  });

  it('loads the declared feed into every panel', async () => {
    const fetch = respond(200, FIXTURE);
    await loadFeed(document, fetch);
    expect(fetch).toHaveBeenCalledWith('site.json');
    for (const p of panels()) expect(p.feed!.contract).toBe('canary.site/1');
  });

  it('refuses every panel, with the reason, when the fetch fails', async () => {
    await loadFeed(document, respond(404, null));
    for (const p of panels()) {
      expect(p.feed).toBeNull();
      expect(live(p.shadowRoot!)).toContain(
        'could not be loaded: site.json: HTTP 404',
      );
    }
  });

  it('refuses a feed of another contract or major version (D3)', async () => {
    await loadFeed(
      document,
      respond(200, { ...FIXTURE, contract: 'canary.site/2' }),
    );
    for (const p of panels())
      expect(live(p.shadowRoot!)).toContain('"canary.site/2"');
  });

  it('refuses when the network throws', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    await loadFeed(document, fetch);
    for (const p of panels()) expect(live(p.shadowRoot!)).toContain('offline');
  });

  it('does nothing on a page that declares no feed', async () => {
    document.head.innerHTML = '';
    const fetch = respond(200, FIXTURE);
    await loadFeed(document, fetch);
    expect(fetch).not.toHaveBeenCalled();
  });
});
