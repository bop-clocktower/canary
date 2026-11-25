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
 * this test is what proves it. The executor (P3) needs a browser and a child
 * process; it must arrive through a lazy dynamic import of a separate module,
 * so this closure stays the offline one. Dynamic imports are LISTED, never skipped:
 * the day one lands in the closure this test fails and forces that review.
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
/** Globals that reach the network with no import. */
const NETWORK_GLOBALS =
  /\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\bEventSource\b/;
const STATIC_IMPORT =
  /^\s*(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(/;

interface Closure {
  files: string[];
  bare: string[];
  dynamic: string[];
  globals: string[];
}

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
    if (DYNAMIC_IMPORT.test(src)) dynamic.push(file);
    if (NETWORK_GLOBALS.test(src)) globals.push(file);
  }
  const rel = (f: string) => path.relative(SKILLS, f).split(path.sep).join('/');
  return {
    files: [...seen].map(rel).sort(),
    bare: [...bare].sort(),
    dynamic: dynamic.map(rel).sort(),
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

  it('has no dynamic import (the future run path must stay outside)', () => {
    expect(c.dynamic).toEqual([]);
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
