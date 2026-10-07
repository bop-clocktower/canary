import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSite,
  outProblem,
} from '../claude-code/canary-barda/scripts/build.mjs';
import { main as bardaMain } from '../claude-code/canary-barda/scripts/cli.mjs';
import { readFeed } from '../claude-code/canary-barda/scripts/feed.mjs';
import { page, PANEL_TAGS } from '../claude-code/canary-barda/scripts/page.mjs';
import { siteFeed } from './site-kit-helpers.js';

describe('canary-barda page', () => {
  const html = page({ title: 'QA' });

  it('places each of the seven panels once', () => {
    expect(PANEL_TAGS).toHaveLength(7);
    for (const tag of PANEL_TAGS)
      expect(html.match(new RegExp(`<${tag}>`, 'g'))).toHaveLength(1);
  });

  // Review S2: a page opened from file:// (or with kit/ missing) never
  // upgrades its panels. Light-DOM text says why; the kit renders into a
  // slot-less shadow root, so the text is hidden once a panel upgrades.
  it('says why inside each panel if the kit never runs', () => {
    for (const tag of PANEL_TAGS)
      expect(html).toMatch(
        new RegExp(`<${tag}><p>This panel did not load: [^<]*</p></${tag}>`),
      );
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

  it('brands the page with the canary mark from its own kit', () => {
    // Decorative: the wordmark beside it already says "canary".
    expect(html).toContain('<img src="kit/mark.svg" alt=""');
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

  // Review F2: cpSync does not detect copying the kit into itself; it
  // recursed until ENAMETOOLONG and left a nested tree in the kit source.
  it('refuses an out dir inside the site kit itself', () => {
    const kit = new URL('../lib/site-kit/', import.meta.url).pathname;
    expect(outProblem(path.join(kit, 'out'))).toMatch(/inside the site kit/);
    expect(outProblem(path.join(kit, 'a', 'b'))).toMatch(/inside the site kit/);
    expect(fs.existsSync(path.join(kit, 'out'))).toBe(false);
  });

  // Review S1: a build that fails part-way removes what it wrote, so a retry
  // is not refused over barda's own half-built output. A null title makes
  // page() throw after the kit has already been copied.
  it('removes its partial output when a build fails', () => {
    const fresh = path.join(tmp(), 'site');
    expect(() =>
      buildSite(siteFeed(), fresh, { title: null as unknown as string }),
    ).toThrow();
    expect(fs.existsSync(fresh)).toBe(false);

    const empty = tmp();
    expect(() =>
      buildSite(siteFeed(), empty, { title: null as unknown as string }),
    ).toThrow();
    expect(fs.readdirSync(empty)).toEqual([]);
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
      'mark.svg',
    ];
    for (const f of ['index.html', 'site.json', ...kit.map((k) => `kit/${k}`)])
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    expect(fs.readdirSync(path.join(out, 'kit/panels'))).toHaveLength(7);
    expect(
      JSON.parse(fs.readFileSync(path.join(out, 'site.json'), 'utf8')),
    ).toEqual(doc);
    // index.html + site.json, six kit files, seven panels.
    expect(count).toBe(2 + 6 + 7);
  });
});

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...a) => void out.push(a.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(
    (...a) => void err.push(a.join(' ')),
  );
  const code = bardaMain(argv);
  vi.restoreAllMocks();
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('canary-barda cli', () => {
  it('builds a valid feed and says what it wrote', () => {
    const out = path.join(tmp(), 'site');
    const r = run([
      '--feed',
      fixture('site.valid.json'),
      '--out',
      out,
      '--title',
      'Canary QA',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/built .*: 15 file\(s\), 7 panels, 2 run\(s\)/);
    expect(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).toContain(
      '<title>Canary QA</title>',
    );
  });

  it('builds nothing from an invalid feed (exit 1)', () => {
    const out = path.join(tmp(), 'site');
    const r = run(['--feed', write('{'), '--out', out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('invalid feed');
    expect(r.stderr).toContain('nothing built');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('refuses a non-empty out dir (exit 1)', () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, 'keep.txt'), 'x');
    expect(run(['--feed', fixture('site.valid.json'), '--out', out]).code).toBe(
      1,
    );
    expect(fs.readdirSync(out)).toEqual(['keep.txt']);
  });

  it('reports an out path it cannot create (exit 1, no stack trace)', () => {
    const file = path.join(tmp(), 'plain.txt');
    fs.writeFileSync(file, 'x');
    const r = run([
      '--feed',
      fixture('site.valid.json'),
      '--out',
      path.join(file, 'site'),
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cannot build into');
  });

  it('abstains loudly on a feed with zero runs; exit 3 under --strict', () => {
    const feed = write(siteFeed());
    const soft = run(['--feed', feed, '--out', path.join(tmp(), 'a')]);
    expect(soft.code).toBe(0);
    expect(soft.stdout).toContain('ABSTAINED');
    expect(soft.stdout).not.toContain('7 panels,');
    expect(
      run(['--feed', feed, '--out', path.join(tmp(), 'b'), '--strict']).code,
    ).toBe(3);
  });

  it('is a usage error without --out (exit 2)', () => {
    expect(run(['--feed', fixture('site.valid.json')]).code).toBe(2);
  });
});
