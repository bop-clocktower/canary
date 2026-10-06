// JSX children text is prose, not code, in the skill scanners too (#1188).
//
// canary-blackhawk and canary-savant both scan .tsx/.jsx, and both read each
// line through the per-line string-literal helper. Before #1188 an apostrophe
// in JSX text (`<p>It's</p>`) opened a phantom string that ran to the end of
// the line: a real finding after it was suppressed, and a quoted fixture after
// it was read as CODE -- fabricating BH001. Each row below is the issue's
// table; the control line (no apostrophe) pins that the rule itself fires.
//
// The engine fixed the same class in #1180/#1190 (ts/src/core/jsx-text.ts);
// the skills carry a self-contained port in agents/skills/lib/jsx-text.mjs.

import { describe, it, expect } from 'vitest';

import { scanText as blackhawkScan } from '../claude-code/canary-blackhawk/scripts/scanner.mjs';
import { scanText as savantScan } from '../claude-code/canary-savant/scripts/scanner.mjs';

type Scan = (
  text: string,
  file: string,
) => Array<{ ruleId: string; line: number }>;

const BH001 = 'BH001-wall-clock';
const SV003 = 'SV003-shared-singleton-mutation';

const SKILLS: Array<[string, Scan, string, string, string, string]> = [
  // [skill, scan, rule, flagged code, finding line, fabricated-finding line]
  [
    'canary-blackhawk',
    blackhawkScan as Scan,
    BH001,
    'Date.now()',
    "render(<p>It's {Date.now()}</p>);",
    "render(<p>It's</p>, label('Date.now()'));",
  ],
  [
    'canary-savant',
    savantScan as Scan,
    SV003,
    "process.env.API = 'x'",
    "render(<p>It's {(process.env.API = 'x')}</p>);",
    "render(<p>It's</p>, label('process.env.API = 1'));",
  ],
];

function linesOf(scan: Scan, text: string, file: string, rule: string) {
  return scan(text, file)
    .filter((f) => f.ruleId === rule)
    .map((f) => f.line);
}

describe.each(SKILLS)(
  '%s on .tsx/.jsx',
  (_skill, scan, rule, code, real, fake) => {
    const control = real.replace("It's", 'Its');

    it.each(['a.test.tsx', 'a.test.jsx'])(
      'keeps the finding after a JSX apostrophe (%s)',
      (file) => {
        expect(linesOf(scan, control, file, rule)).toEqual([1]);
        expect(linesOf(scan, real, file, rule)).toEqual([1]);
      },
    );

    it.each(['a.test.tsx', 'a.test.jsx'])(
      'does not read a fixture string after a JSX apostrophe as code (%s)',
      (file) => {
        expect(linesOf(scan, fake.replace("It's", 'Its'), file, rule)).toEqual(
          [],
        );
        expect(linesOf(scan, fake, file, rule)).toEqual([]);
      },
    );

    it('does not read JSX children prose as code', () => {
      const prose = control.replace(/\{.*\}/, (m) => m.slice(1, -1));
      expect(linesOf(scan, prose, 'a.test.tsx', rule)).toEqual([]);
    });

    it('keeps a pragma in a JSX comment container after an apostrophe', () => {
      const tool = rule === BH001 ? 'blackhawk' : 'savant';
      const id = rule.split('-')[0];
      const text = `${real.replace(');', '')} {/* ${tool}-ignore ${id} -- pinned */});`;
      expect(linesOf(scan, text, 'a.test.tsx', rule)).toEqual([]);
    });

    it('still finds code after shapes the masker must not misread', () => {
      const shapes = [
        // generic arrows and comparisons are not JSX
        `const f = <T,>(x: T) => x;\nconst v = ${code};`,
        `const g = <T extends object>(x: T) => x;\nconst v = ${code};`,
        `if (a < b && c > d) { const v = ${code}; }`,
        // a type-level generic is recovered locally, not file-wide
        `type P = { cb: <T>(x: T) => void };\n${real}`,
        // JSX after a line comment or a block comment
        `render(\n  // don't\n  ${real.replace('render(', '').replace(');', '')},\n);`,
        `render(/* empty */ ${real.replace('render(', '')}`,
      ];
      for (const text of shapes) {
        const line = text.split('\n').findIndex((l) => l.includes(code)) + 1;
        expect(linesOf(scan, text, 'a.test.tsx', rule), text).toEqual([line]);
      }
    });

    it('reads .ts/.js exactly as before: JSX is only modelled in .tsx/.jsx', () => {
      // A .ts file cannot contain JSX, so the per-line reading is unchanged:
      // the apostrophe still opens a string there (the documented #493 limit).
      for (const file of ['a.test.ts', 'a.test.js']) {
        expect(linesOf(scan, control, file, rule)).toEqual([1]);
        expect(linesOf(scan, real, file, rule)).toEqual([]);
      }
    });
  },
);

describe('canary-savant whole-file passes read the masked source', () => {
  const ids = (text: string) =>
    (savantScan as Scan)(text, 'a.test.tsx').map((f) => f.ruleId);

  it('sees a teardown restore after a JSX apostrophe (SV003 restoration)', () => {
    const text = [
      "it('a', () => { process.env.API = 'x'; });",
      "afterEach(() => { render(<p>It's</p>); delete process.env.API; });",
    ].join('\n');
    expect(ids(text.replace("It's", 'Its'))).toEqual([]);
    expect(ids(text)).toEqual([]);
  });

  it('sees a teardown token after a JSX apostrophe (SV002 pairing)', () => {
    const text = [
      'beforeAll(() => { db.open(); });',
      "it('a', () => { render(<p>It's</p>); afterAll(() => db.close()); });",
    ].join('\n');
    expect(ids(text.replace("It's", 'Its'))).toEqual([]);
    expect(ids(text)).toEqual([]);
  });
});
