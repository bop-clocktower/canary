import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// agents/skills/lib is vendored verbatim into consumer repos (for example a
// `.canary/lib/` beside `.canary/skills/`), where it is linted by the
// CONSUMER's config, not ours. A bare `process` global is `no-undef` under any
// flat config that does not declare node globals for that path, which blocks
// the consumer's pre-commit hook on a file it must not edit. Importing it from
// `node:process` is portable to every config.
const LIB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../lib',
);

function libModules(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return libModules(p);
    return e.name.endsWith('.mjs') ? [p] : [];
  });
}

describe('agents/skills/lib is portable to a consumer lint config', () => {
  const modules = libModules(LIB);

  it('finds the lib modules it is guarding', () => {
    // A zero here means the walk broke, not that every module is clean.
    expect(modules.length).toBeGreaterThan(0);
  });

  it.each(modules.map((m) => [path.relative(LIB, m), m]))(
    '%s imports `process` instead of reading the global',
    (_name, file) => {
      const src = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (!/\bprocess\./.test(src)) return;
      expect(src).toMatch(/^import process from 'node:process';$/m);
    },
  );
});
