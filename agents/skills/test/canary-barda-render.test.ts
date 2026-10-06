// @vitest-environment happy-dom
// Criterion 21 end to end: the kit as COPIED into a site built by the real
// CLI (not the source tree) renders each of the six panels from the built
// site.json.
//
// Two happy-dom constraints shape this (soundness review, must-fix 3):
// build.mjs is not imported, because document.mjs resolves its schemas from
// import.meta.url, which happy-dom rewrites to http://localhost; and vitest
// cannot import() from os.tmpdir(), so the site is built under
// node_modules/ (gitignored).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, expect, it, vi } from 'vitest';
import { PANEL_TAGS } from '../claude-code/canary-barda/scripts/page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(process.cwd(), 'node_modules', '.barda-render');
fs.mkdirSync(ROOT, { recursive: true });
const out = path.join(fs.mkdtempSync(path.join(ROOT, 'r-')), 'site');
afterAll(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));

it('renders every panel of a built site from its own kit and feed', async () => {
  const built = spawnSync(
    process.execPath,
    [
      path.join(HERE, '../claude-code/canary-barda/scripts/cli.mjs'),
      '--feed',
      path.join(HERE, 'fixtures/contracts/site.valid.json'),
      '--out',
      out,
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  expect(built.status, built.stderr).toBe(0);
  // Import before the page declares a feed, so the kit's own auto-load is a no-op.
  const kit = await import(
    pathToFileURL(path.join(out, 'kit', 'canary-site.js')).href
  );

  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  expect(html).toContain('<script type="module" src="kit/canary-site.js">');
  // Strip script and stylesheet tags so happy-dom fetches nothing.
  const parsed = new DOMParser().parseFromString(
    html.replace(/<script[^>]*><\/script>|<link[^>]*>/g, ''),
    'text/html',
  );
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;

  const fetch = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => JSON.parse(fs.readFileSync(path.join(out, url), 'utf8')),
  }));
  await kit.loadFeed(document, fetch);

  for (const tag of PANEL_TAGS) {
    const panel = document.querySelector(tag) as HTMLElement & {
      feed: unknown;
    };
    expect(panel.feed, tag).not.toBeNull();
    expect(panel.shadowRoot!.querySelector('h2')!.textContent, tag).not.toBe(
      '',
    );
    expect(panel.shadowRoot!.textContent, tag).not.toContain(
      'could not be loaded',
    );
    // Review F1: panel.js contains a throwing build() as this abstention, so
    // feed and heading alone pass over a crashed panel.
    expect(panel.shadowRoot!.textContent, tag).not.toContain(
      'could not render',
    );
    // The light-DOM fallback (page.mjs) stays hidden only while the shadow
    // root has no slot to project it into.
    expect(panel.shadowRoot!.querySelector('slot'), tag).toBeNull();
  }
});
