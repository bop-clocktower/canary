/**
 * Class-level guard: no tracked TypeScript source carries a raw NUL byte.
 *
 * Filed as an instance and it was a class. `workspace-detect.ts` used a literal
 * U+0000 to separate the parts of a composite Set key; git classifies a file
 * with a NUL in its first 8 KB as BINARY, so the module's 292 lines merged in
 * PR #586 as `Bin 0 -> 9800 bytes` — no diff, no line-level review comments,
 * no reviewer who could have seen what landed. Two other files already used the
 * same idiom (`analysis/reports.ts`, `core/migrator.ts`) and escaped notice only
 * because their NUL sits past byte 8192, where git's sniff no longer looks.
 *
 * The separator itself is fine and worth keeping: NUL cannot occur in a path, a
 * framework name, or a shape, so `a\0b` can never collide with `a` + `\0b`. Only
 * the ENCODING was wrong. `'\0'` is an escape sequence in the source text and
 * the identical character at runtime, so this guard costs nothing to satisfy.
 *
 * Asserting the invariant rather than the three known files: the next composite
 * key written with a literal byte fails here instead of shipping unreviewable.
 *
 * Offline and read-only — reads file bytes, executes nothing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(TS_ROOT, 'src');

/** Every `.ts` file under *dir*, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('source text encoding', () => {
  const files = tsFiles(SRC_DIR);

  // A zero denominator here would be a silent pass: if the walk ever stops
  // finding files, every assertion below trivially holds and the guard reports
  // green while checking nothing.
  it('scans a non-empty set of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no raw NUL byte in any tracked TypeScript source', () => {
    const offenders = files
      .filter((f) => readFileSync(f).includes(0x00))
      .map((f) => relative(TS_ROOT, f));

    // Named in the failure so the fix is obvious: write the separator as the
    // escape `\0` inside the literal instead of embedding the byte.
    expect(offenders).toEqual([]);
  });
});
