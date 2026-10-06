// Source rules for the QA site kit (#1151 phase 3, spec "Panels"): panels
// style only through tokens.css, and DARK_AFTER_DAYS is defined once.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = fileURLToPath(new URL('../lib/site-kit/', import.meta.url));
const files = (ext: string) =>
  readdirSync(KIT, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(ext))
    .map((f) => ({ file: f, text: readFileSync(join(KIT, f), 'utf8') }));
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
// Comments carry issue refs (#1151, #1148) that read as hex colors; the
// rule is about code, so comments are stripped before matching.
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
const TOKENS = readFileSync(join(KIT, 'tokens.css'), 'utf8');
const defined = new Set(
  [...TOKENS.matchAll(/(--canary-[\w-]+)\s*:/g)].map((m) => m[1]),
);

describe('site-kit source rules', () => {
  it('reads the whole kit (a zero denominator here is an abstention, not a pass)', () => {
    expect(files('.js')).toHaveLength(9);
  });

  it.each(files('.js'))('$file holds no color literal', ({ text }) => {
    expect(code(text)).not.toMatch(COLOR);
  });

  it.each(files('.js'))(
    '$file uses only tokens tokens.css defines',
    ({ text }) => {
      for (const [, name] of text.matchAll(/var\((--canary-[\w-]+)\)/g))
        expect(defined, name).toContain(name);
    },
  );

  const sheets = files('.css').filter((f) => f.file !== 'tokens.css');
  it('styles page.css only through tokens', () => {
    expect(sheets.map((s) => s.file)).toEqual(['page.css']);
    for (const { text } of sheets) {
      expect(code(text)).not.toMatch(COLOR);
      for (const [, name] of text.matchAll(/var\((--canary-[\w-]+)\)/g))
        expect(defined, name).toContain(name);
    }
  });

  it('defines DARK_AFTER_DAYS exactly once, in model.js', () => {
    const hits = files('.js').filter(({ text }) =>
      /DARK_AFTER_DAYS\s*=/.test(text),
    );
    expect(hits.map((h) => h.file)).toEqual(['model.js']);
  });
});
