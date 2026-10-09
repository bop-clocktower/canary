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

import {
  scanText as blackhawkScan,
  scanTextFull as blackhawkScanFull,
} from '../claude-code/canary-blackhawk/scripts/scanner.mjs';
import {
  scanText as savantScan,
  scanTextFull as savantScanFull,
} from '../claude-code/canary-savant/scripts/scanner.mjs';

type Finding = { ruleId: string; line: number };
type Scan = (text: string, file: string) => Finding[];
type ScanFull = (
  text: string,
  file: string,
) => { findings: Finding[]; suppressed: Finding[] };

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
      // The same line with its braces kept must still fire, or an empty
      // result is what a scanner that finds nothing returns too (#1179).
      expect(linesOf(scan, control, 'a.test.tsx', rule)).toEqual([1]);
      expect(linesOf(scan, prose, 'a.test.tsx', rule)).toEqual([]);
    });

    const tool = rule === BH001 ? 'blackhawk' : 'savant';
    const id = rule.split('-')[0];
    const full = (
      rule === BH001 ? blackhawkScanFull : savantScanFull
    ) as ScanFull;
    const expr = real.match(/\{.*\}/)![0];

    it('applies a pragma in a JSX comment container after an apostrophe', () => {
      const text = `${real.replace(');', '')} {/* ${tool}-ignore ${id} -- pinned */});`;
      const { findings, suppressed } = full(text, 'a.test.tsx');
      expect(findings.filter((f) => f.ruleId === rule)).toEqual([]);
      expect(suppressed.map((f) => [f.ruleId, f.line])).toEqual([[rule, 1]]);
    });

    it('does not apply a // pragma written as JSX children text', () => {
      // Inside children, `// ...` is rendered text, not a comment: only a
      // `{/* ... */}` container is a comment there.
      const text = `render(\n  <p>\n    // ${tool}-ignore ${id} -- rendered text\n    ${expr}\n  </p>,\n);`;
      expect(linesOf(scan, text, 'a.test.tsx', rule)).toEqual([4]);
    });

    it.each(['* Required', '# of rows:', '// not a comment', '/* nor this'])(
      'reads a JSX text line starting %s as JSX, not a comment',
      (lead) => {
        const text = `render(\n  <label>\n    ${lead} ${expr}\n  </label>,\n);`;
        expect(linesOf(scan, text, 'a.test.tsx', rule)).toEqual([3]);
      },
    );

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
        // a closing tag closes only its own element (#1193 review): a
        // misread `<T>` is not "closed" by a `</b>` inside a later string
        `type R = { render: <T>(x: T) => string };\nconst v = ${code};\nexpect(html).toBe('</b>');`,
        `const f = (cb: <T>(x: T) => T) => cb;\nconst v = ${code};\nconst s = \`</p>\`;`,
        // more misread `<` than the masker has passes for
        `${'type P = { cb: <T>(x: T) => void };\n'.repeat(100)}${real}`,
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

describe('canary-savant per-line checks read the masked line', () => {
  const ids = (text: string) =>
    (savantScan as Scan)(text, 'a.test.tsx').map(
      (f) => `${f.ruleId}@${f.line}`,
    );

  it('does not read JSX prose as a self-reported ordering (SV004)', () => {
    // savant-ignore SV004 -- fixture: JSX prose the masked reading must not flag
    const prose = 'Checkout runs after payment is confirmed.';
    const text = `render(<Tip>${prose}</Tip>);`;
    expect(ids(text)).toEqual([]);
    expect(
      (savantScan as Scan)(text, 'a.test.ts').map((f) => f.ruleId),
    ).toEqual(['SV004-order-coupled-name']);
  });

  it('does not take JSX prose as snapshot evidence for a write-back (SV003)', () => {
    const text = [
      "it('a', () => {",
      '  process.env.API = saved;',
      '});',
      'render(<pre>',
      '  saved = process.env.API',
      '</pre>);',
    ].join('\n');
    expect(ids(text)).toEqual([`${SV003}@2`]);
    // control: the same evidence as code is a write-back, so no finding
    const code = text.replace('render(<pre>', '{').replace('</pre>);', '}');
    expect(ids(code)).toEqual([]);
  });
});
