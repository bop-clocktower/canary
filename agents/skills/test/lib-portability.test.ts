import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Linter } from 'eslint';
import globals from 'globals';
import { describe, expect, it } from 'vitest';

// agents/skills/lib is vendored verbatim into consumer repos (for example
// `.canary/lib/`), where it is linted by the CONSUMER's flat config, not
// ours. A config that declares no Node globals for that path reports every
// bare `process`, `console`, `URL`, `Buffer`, ... as `no-undef`, which blocks
// the consumer's pre-commit hook on a file it must not edit.
//
// So this runs ESLint's real `no-undef` with the strictest config a consumer
// could have: ES builtins only (`globalThis`, `JSON`, `Map`, ...), no Node and
// no browser globals. A Node module passes only if every non-ES global it uses
// is imported. A string grep cannot do this: it misses destructuring
// (`const { argv } = process`), bracket access, `Buffer`/`__dirname`, and it
// false-fails on `import process, { argv }` or `globalThis.process`.
//
// lib/site-kit is BROWSER code (document, customElements, HTMLElement), so it
// is linted against browser globals only. A consumer has to declare those for
// that path; Node globals are still refused there.
const LIB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../lib',
);

const base = {
  ecmaVersion: 'latest',
  sourceType: 'module',
} as const;

// An empty `globals` leaves only the ES builtins `ecmaVersion` implies.
const NODE_MODULE: Linter.Config[] = [
  {
    files: ['**/*.mjs'],
    languageOptions: { ...base, globals: {} },
    rules: { 'no-undef': 'error' },
  },
];

const BROWSER_MODULE: Linter.Config[] = [
  {
    files: ['**/*.js'],
    languageOptions: { ...base, globals: { ...globals.browser } },
    rules: { 'no-undef': 'error' },
  },
];

const linter = new Linter({ configType: 'flat' });

/** Every lint message (parse errors included) as `line:col rule: message`. */
function lint(
  code: string,
  config: Linter.Config[],
  filename: string,
): string[] {
  return linter
    .verify(code, config, { filename })
    .map((m) => `${m.line}:${m.column} ${m.ruleId ?? 'fatal'}: ${m.message}`);
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [path.relative(LIB, p)];
  });
}

const files = walk(LIB);
const nodeModules = files.filter((f) => f.endsWith('.mjs')).sort();
const browserModules = files
  .filter((f) => f.endsWith('.js') && f.startsWith(`site-kit${path.sep}`))
  .sort();

// Named, not counted: a broken walk or a moved module fails here instead of
// shrinking the table below to nothing. Extend these when lib grows.
const KNOWN_NODE = [
  'contracts/document.mjs',
  'contracts/field-checks.mjs',
  'contracts/rules.mjs',
  'contracts/schema-check.mjs',
  'contracts/schema-problems.mjs',
  'contracts/validate.mjs',
  'is-main.mjs',
  'js-literals.mjs',
  'jsx-text.mjs',
  'parse-args.mjs',
].map((f) => f.split('/').join(path.sep));

const KNOWN_BROWSER = [
  'site-kit/canary-site.js',
  'site-kit/model.js',
  'site-kit/panel.js',
  'site-kit/panels/failures-by-area.js',
  'site-kit/panels/flaky.js',
  'site-kit/panels/pass-rate.js',
  'site-kit/panels/pillars.js',
  'site-kit/panels/pipeline-health.js',
  'site-kit/panels/register.js',
  'site-kit/panels/summary.js',
].map((f) => f.split('/').join(path.sep));

describe('agents/skills/lib is portable to a consumer lint config', () => {
  it('walks every known lib module', () => {
    expect(nodeModules).toEqual(expect.arrayContaining(KNOWN_NODE));
    expect(browserModules).toEqual(expect.arrayContaining(KNOWN_BROWSER));
  });

  it('leaves no JS file outside the two linted sets', () => {
    // A .js outside site-kit would be Node code that neither table lints.
    const unlinted = files.filter(
      (f) =>
        /\.(c?js|mjs)$/.test(f) &&
        !nodeModules.includes(f) &&
        !browserModules.includes(f),
    );
    expect(unlinted).toEqual([]);
  });

  it.each(nodeModules)(
    '%s lints clean with no globals declared (ES builtins only)',
    (rel) => {
      const src = fs.readFileSync(path.join(LIB, rel), 'utf8');
      expect(lint(src, NODE_MODULE, rel)).toEqual([]);
    },
  );

  it.each(browserModules)(
    '%s lints clean against browser globals only',
    (rel) => {
      const src = fs.readFileSync(path.join(LIB, rel), 'utf8');
      expect(lint(src, BROWSER_MODULE, rel)).toEqual([]);
    },
  );
});

// The configs above are only as good as what they refuse. These pin both
// directions on fixtures, so a config that silently stopped running
// `no-undef` (zero messages for everything) cannot pass.
describe('the portability lint itself', () => {
  const refused: [string, string, string][] = [
    ['bare process.argv', 'export const a = process.argv;\n', 'process'],
    [
      'destructured process',
      'const { argv } = process;\nexport { argv };\n',
      'process',
    ],
    ['bracket access', "export const e = process['env'];\n", 'process'],
    [
      "'//' inside a string before process",
      "export const u = 'http://x'; export const c = process.cwd();\n",
      'process',
    ],
    ['bare Buffer', "export const b = Buffer.from('x');\n", 'Buffer'],
    ['bare __dirname', 'export const d = __dirname;\n', '__dirname'],
    ['bare console', "console.log('x');\n", 'console'],
    ['bare URL', "export const u = new URL('./x', import.meta.url);\n", 'URL'],
    ['browser global', 'export const d = document.title;\n', 'document'],
  ];

  it.each(refused)('refuses %s in a Node module', (_label, code, name) => {
    expect(lint(code, NODE_MODULE, 'fixture.mjs')).toEqual([
      expect.stringContaining(`no-undef: '${name}' is not defined.`),
    ]);
  });

  const accepted: [string, string][] = [
    [
      'default plus named import from node:process',
      "import process, { argv } from 'node:process';\nexport const a = [process.pid, argv];\n",
    ],
    ['globalThis.process', 'export const p = globalThis.process.pid;\n'],
    [
      'globalThis.console and an imported URL',
      "import { URL } from 'node:url';\nglobalThis.console.log(new URL('./x', import.meta.url));\n",
    ],
  ];

  it.each(accepted)('accepts %s in a Node module', (_label, code) => {
    expect(lint(code, NODE_MODULE, 'fixture.mjs')).toEqual([]);
  });

  it('refuses a Node global in browser code', () => {
    expect(
      lint('export const p = process.platform;\n', BROWSER_MODULE, 'x.js'),
    ).toEqual([expect.stringContaining("no-undef: 'process' is not defined.")]);
  });

  it('accepts a browser global in browser code', () => {
    expect(
      lint(
        'export class X extends HTMLElement {}\ncustomElements.define("x-x", X);\n',
        BROWSER_MODULE,
        'x.js',
      ),
    ).toEqual([]);
  });
});
