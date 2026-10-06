import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { page, PANEL_TAGS } from '../claude-code/canary-barda/scripts/page.mjs';

describe('canary-barda page', () => {
  const html = page({ title: 'QA' });

  it('places each of the six panels once', () => {
    expect(PANEL_TAGS).toHaveLength(6);
    for (const tag of PANEL_TAGS)
      expect(html.match(new RegExp(`<${tag}>`, 'g'))).toHaveLength(1);
  });

  it('names the same tags the kit registers', () => {
    const kit = readFileSync(
      new URL('../lib/site-kit/canary-site.js', import.meta.url),
      'utf8',
    );
    for (const tag of PANEL_TAGS) expect(kit).toContain(`'${tag}'`);
  });

  it("has no inline script, style or handler, so script-src 'self' holds", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
    expect(html).toContain(
      '<script type="module" src="kit/canary-site.js"></script>',
    );
  });

  it('declares the feed for the kit', () => {
    expect(html).toContain('<meta name="canary-feed" content="site.json">');
  });

  it('escapes the title', () => {
    const out = page({ title: '<b>&"x\'' });
    expect(out).not.toContain('<b>');
    expect(out).toContain('&#60;b&#62;&#38;&#34;x&#39;');
  });
});
