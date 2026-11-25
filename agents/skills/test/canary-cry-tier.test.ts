/**
 * canary-cry's Tier-0 half imports no network, process or model module
 * (#608 SC6).
 *
 * `validate` and `matrix` are deterministic, offline and agent-free by
 * contract (spec "Capability axes"; ADR 0015). Nothing else enforces it: an
 * `import 'node:http'` or a bare global fetch added under scripts/ would keep
 * every other gate green. This walks the STATIC import closure of cli.mjs --
 * every relative specifier, transitively, the method of
 * ts/test/gen-data-model-free.test.ts -- and forbids network, process and
 * model-SDK modules anywhere in it, plus the network globals that need no
 * import at all.
 *
 * P2's `run --live` (gate + manifest) is in this closure on purpose: it must
 * decide a refusal and print a manifest with no way to reach the target, and
 * this test is what proves it. The P3 executor needs a socket and a child
 * process, so it arrives through ONE lazy dynamic import, in cli.mjs, of one
 * module (execute.mjs), loaded only after a matching --confirm. Dynamic
 * imports are LISTED with their specifiers, never skipped: a second one, a
 * different target, or a non-literal `import(x)` fails here and forces that
 * review. The executor's own closure is walked too, to prove the split is
 * real (it does reach a process module) rather than vacuous.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.join(HERE, '..');
const CLI = path.join(
  SKILLS,
  'claude-code',
  'canary-cry',
  'scripts',
  'cli.mjs',
);

/** Bare specifiers that reach a network, a process, or a model. */
const FORBIDDEN = [
  /^(node:)?(http|https|http2|net|tls|dgram|dns|child_process|cluster|worker_threads)$/,
  /^(undici|ws|axios|node-fetch|playwright|playwright-core|@playwright\/test)$/,
  /^(@anthropic-ai\/|openai$|@openai\/|@google\/genai|@google\/generative-ai|@ai-sdk\/|ai$|langchain|@langchain\/)/,
];
/** Globals that reach the network with no import -- `fetch` as a value too. */
const NETWORK_GLOBALS =
  /\bfetch\b|\bWebSocket\b|\bXMLHttpRequest\b|\bEventSource\b/;
const STATIC_IMPORT =
  /^\s*(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?:['"]([^'"]+)['"]\s*\))?/g;

interface Closure {
  files: string[];
  bare: string[];
  /** `<file> -> <specifier>`; a non-literal specifier reads `<computed>`. */
  dynamic: string[];
  globals: string[];
}

const rel = (f: string) => path.relative(SKILLS, f).split(path.sep).join('/');

/** `<file> -> <specifier>` for every dynamic import in `src`. */
const dynamicImports = (file: string, src: string) =>
  [...src.matchAll(DYNAMIC_IMPORT)].map(
    (m) => `${rel(file)} -> ${m[1] ?? '<computed>'}`,
  );

function closure(entry: string): Closure {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const dynamic: string[] = [];
  const globals: string[] = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(STATIC_IMPORT)) {
      const spec = m[1] ?? m[2]!;
      if (spec.startsWith('.'))
        queue.push(path.resolve(path.dirname(file), spec));
      else bare.add(spec);
    }
    dynamic.push(...dynamicImports(file, src));
    if (NETWORK_GLOBALS.test(src)) globals.push(file);
  }
  return {
    files: [...seen].map(rel).sort(),
    bare: [...bare].sort(),
    dynamic: dynamic.sort(),
    globals: globals.map(rel).sort(),
  };
}

const forbidden = (specs: string[]) =>
  specs.filter((s) => FORBIDDEN.some((re) => re.test(s)));

describe('canary-cry Tier-0 import closure (SC6)', () => {
  const c = closure(CLI);

  it('walks the modules it claims to (a vacuous walk would pass anything)', () => {
    expect(c.files).toEqual(
      expect.arrayContaining([
        'claude-code/canary-cry/scripts/cli.mjs',
        'claude-code/canary-cry/scripts/schema.mjs',
        'claude-code/canary-cry/scripts/schema-core.mjs',
        'claude-code/canary-cry/scripts/schema-targets.mjs',
        'claude-code/canary-cry/scripts/matrix.mjs',
        'claude-code/canary-cry/scripts/patterns.mjs',
        'claude-code/canary-cry/scripts/render.mjs',
        'claude-code/canary-cry/scripts/gate.mjs',
        'claude-code/canary-cry/scripts/manifest.mjs',
        'lib/parse-args.mjs',
        'lib/contracts/critical-areas.mjs',
      ]),
    );
    expect(c.bare).toContain('node:fs');
  });

  it('imports no network, process or model module', () => {
    expect(forbidden(c.bare)).toEqual([]);
  });

  it('touches no network global', () => {
    expect(c.globals).toEqual([]);
  });

  it('reaches the executor only through one lazy import, in cli.mjs', () => {
    expect(c.dynamic).toEqual([
      'claude-code/canary-cry/scripts/cli.mjs -> ./execute.mjs',
    ]);
    expect(c.files).not.toContain('claude-code/canary-cry/scripts/execute.mjs');
  });
});

describe('the executor stays outside the Tier-0 closure (SC6)', () => {
  const EXECUTOR = path.join(path.dirname(CLI), 'execute.mjs');
  const e = closure(EXECUTOR);
  const tier0 = closure(CLI);

  it('is the half that reaches a process and the network', () => {
    expect(forbidden(e.bare)).toEqual(['node:child_process']);
    expect(e.globals).toEqual([
      'claude-code/canary-cry/scripts/playwright.mjs',
    ]);
  });

  it('shares only pure modules with the Tier-0 closure', () => {
    const shared = e.files.filter((f) => tier0.files.includes(f));
    for (const file of shared) {
      const sub = closure(path.join(SKILLS, file));
      expect([file, forbidden(sub.bare), sub.globals]).toEqual([file, [], []]);
    }
    expect(shared).toEqual(
      expect.arrayContaining([
        'claude-code/canary-cry/scripts/matrix.mjs',
        'claude-code/canary-cry/scripts/render.mjs',
      ]),
    );
  });

  it('has no dynamic import of its own', () => {
    expect(e.dynamic).toEqual([]);
  });
});

describe('the closure check bites', () => {
  const tmps: string[] = [];
  afterEach(() => {
    while (tmps.length)
      fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  });

  it('flags a forbidden import two hops away, a global, and a dynamic import', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cry-tier-'));
    tmps.push(dir);
    fs.writeFileSync(
      path.join(dir, 'entry.mjs'),
      "import { x } from './a.mjs';\n",
    );
    fs.writeFileSync(
      path.join(dir, 'a.mjs'),
      "export { y as x } from './b.mjs';\n",
    );
    fs.writeFileSync(
      path.join(dir, 'b.mjs'),
      "import https from 'node:https';\n" +
        'export const y = () => fetch(https);\n' +
        "export const z = () => import('./c.mjs');\n",
    );
    const c = closure(path.join(dir, 'entry.mjs'));
    expect(forbidden(c.bare)).toEqual(['node:https']);
    expect(c.globals).toHaveLength(1);
    expect(c.dynamic).toHaveLength(1);
  });
});
