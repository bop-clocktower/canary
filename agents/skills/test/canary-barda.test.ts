import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSite,
  outProblem,
} from '../claude-code/canary-barda/scripts/build.mjs';
import { readFeed } from '../claude-code/canary-barda/scripts/feed.mjs';
import { page, PANEL_TAGS } from '../claude-code/canary-barda/scripts/page.mjs';
import { siteFeed } from './site-kit-helpers.js';

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

const tmps: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-barda-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});
const fixture = (name: string) =>
  new URL(`./fixtures/contracts/${name}`, import.meta.url).pathname;
const write = (doc: unknown) => {
  const f = path.join(tmp(), 'site.json');
  fs.writeFileSync(f, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return f;
};

describe('canary-barda build', () => {
  it('reads a valid feed', () => {
    const { doc, errors } = readFeed(fixture('site.valid.json'));
    expect(errors).toEqual([]);
    expect(doc!.contract).toBe('canary.site/1');
  });

  it.each([
    ['unparseable JSON', '{', 'not parseable JSON'],
    [
      'a run record, not a site feed',
      JSON.parse(fs.readFileSync(fixture('run.valid.json'), 'utf8')),
      'canary.run/1',
    ],
    [
      'a feed with a bare-string scope',
      { ...siteFeed(), scopes: ['canary'] },
      'scopes',
    ],
  ])('refuses %s', (_name, doc, needle) => {
    const { doc: got, errors } = readFeed(write(doc));
    expect(got).toBeNull();
    expect(errors.join('\n')).toContain(needle);
  });

  it('refuses a missing file', () => {
    expect(readFeed(path.join(tmp(), 'nope.json')).errors[0]).toMatch(
      /^cannot read /,
    );
  });

  it('accepts a missing or empty out dir and refuses anything else', () => {
    const base = tmp();
    expect(outProblem(path.join(base, 'new'))).toBeNull();
    expect(outProblem(base)).toBeNull();
    fs.writeFileSync(path.join(base, 'stale.txt'), 'x');
    expect(outProblem(base)).toMatch(/is not empty/);
    expect(outProblem(path.join(base, 'stale.txt'))).toMatch(
      /is not a directory/,
    );
  });

  it('writes index.html, the feed and the whole kit', () => {
    const out = path.join(tmp(), 'site');
    const doc = siteFeed();
    const count = buildSite(doc, out, { title: 'QA' });
    const kit = [
      'canary-site.js',
      'model.js',
      'panel.js',
      'tokens.css',
      'page.css',
    ];
    for (const f of ['index.html', 'site.json', ...kit.map((k) => `kit/${k}`)])
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    expect(fs.readdirSync(path.join(out, 'kit/panels'))).toHaveLength(6);
    expect(
      JSON.parse(fs.readFileSync(path.join(out, 'site.json'), 'utf8')),
    ).toEqual(doc);
    expect(count).toBe(2 + 9 + 2);
  });
});
