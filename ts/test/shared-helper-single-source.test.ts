/**
 * Class-level guard against re-declaring a helper the tree already exports
 * from one canonical module (#710).
 *
 * The instance that motivated it: `ensureAscii` -- Python
 * `json.dumps(ensure_ascii=True)` parity -- was exported from `cli-common.ts`,
 * whose own docstring calls it one of "the three concerns every command tree
 * needs", and **nothing imported it**. Eight modules each carried a private
 * copy instead, and those copies had already drifted into two forms (six a
 * regex `replace`, two the per-code-unit loop the docstring describes). Both
 * forms happened to agree on every input, so no test could have caught it: the
 * defect was in the maintenance shape, not the behaviour. The next non-BMP or
 * Python-parity fix had eight landing sites instead of one, and the person
 * making it would not have known the other seven existed.
 *
 * That is why this guard is source-text and name-based rather than behavioural.
 * A duplicate that behaves identically is invisible to every other kind of
 * test, and identical behaviour is precisely the state duplication starts in.
 *
 * The entropy analyzer saw only "dead export" and would have been satisfied by
 * *unexporting* `ensureAscii` -- cementing the duplication for one fewer
 * finding. So this guard also asserts the reverse direction: the canonical
 * module must still have real importers. A shared helper with zero importers
 * and eight copies is the same failure whether or not the copies are the thing
 * the gate happens to count.
 */

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { globFiles } from '../src/core/fs-glob.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');

/**
 * Helpers that must have exactly one declaration in `ts/src`, keyed by the
 * module that owns it. Add a row here when a helper graduates to shared status;
 * the guard then fails the moment a ninth copy is pasted in somewhere else.
 */
const CANONICAL: Record<string, string> = {
  ensureAscii: 'util/ensure-ascii.ts',
  jsonIndent2: 'cli-common.ts',
};

/**
 * Declarations that are duplicates by name but cannot import the canonical one
 * without breaking a hard constraint. Each entry states the constraint; an
 * entry with no live constraint is a bug in this list, not a licence.
 */
const ALLOWED_DUPLICATES: Record<string, { module: string; why: string }[]> = {
  // `cli-common.ts` re-exports `CliExitError` FROM `guardian/cli.ts`, so
  // `guardian/cli.ts` importing back from `cli-common.ts` would be an import
  // cycle -- and `guardian/**` may only depend on `core`/`util` (harness.config
  // layer model), which `cli-common.ts` is not. Tracked separately; the fix is
  // to move both helpers down into `util/`, not to import upward from here.
  normalizeUsageExit: [
    {
      module: 'guardian/cli.ts',
      why: 'import cycle with cli-common.ts + guardian may not depend on the cli layer',
    },
  ],
};

/** Every non-test TypeScript source file under `ts/src`, repo-relative. */
function sourceFiles(): string[] {
  return globFiles(srcRoot, '**/*.ts')
    .map((abs) => relative(srcRoot, abs).split('\\').join('/'))
    .filter((rel) => !rel.endsWith('.test.ts') && !rel.endsWith('.d.ts'))
    .sort();
}

/** Modules declaring a function or arrow-const named `name`. */
function declarersOf(name: string, files: string[]): string[] {
  const decl = new RegExp(
    `^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b|` +
      `^\\s*(?:export\\s+)?const\\s+${name}\\s*[:=]`,
    'm',
  );
  return files.filter((rel) =>
    decl.test(readFileSync(resolve(srcRoot, rel), 'utf8')),
  );
}

/** Modules with an ESM import of `name` from anywhere. */
function importersOf(name: string, files: string[]): string[] {
  const imp = new RegExp(
    `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`,
    's',
  );
  return files.filter((rel) =>
    imp.test(readFileSync(resolve(srcRoot, rel), 'utf8')),
  );
}

describe('shared helpers have a single declaration site', () => {
  const files = sourceFiles();

  it('scans a non-empty set of source files', () => {
    // A zero denominator here would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(50);
  });

  for (const [name, owner] of Object.entries(CANONICAL)) {
    const allowed = (ALLOWED_DUPLICATES[name] ?? []).map((e) => e.module);

    it(`${name} is declared only in ${owner}`, () => {
      const declarers = declarersOf(name, files).filter(
        (rel) => !allowed.includes(rel),
      );
      expect(declarers).toEqual([owner]);
    });

    it(`${name} is imported by at least one module`, () => {
      // The dead-export half of #710: a canonical helper nobody imports is not
      // a source of truth, it is the eighth copy's unused sibling.
      expect(importersOf(name, files).length).toBeGreaterThan(0);
    });
  }

  it('every allowed duplicate names a live module and a reason', () => {
    for (const entries of Object.values(ALLOWED_DUPLICATES)) {
      for (const entry of entries) {
        expect(files, `${entry.module} no longer exists`).toContain(
          entry.module,
        );
        expect(entry.why.length).toBeGreaterThan(20);
      }
    }
  });
});

describe('the ensureAscii source of truth', () => {
  it('escapes per UTF-16 code unit, so astral chars emit a surrogate pair', async () => {
    const { ensureAscii } = await import('../src/util/ensure-ascii.js');
    // CPython's ensure_ascii=True emits \ud83d\ude00 for U+1F600, not the raw
    // char and not a single \U0001f600 escape.
    expect(ensureAscii('a\u{1F600}b')).toBe('a\\ud83d\\ude00b');
    expect(ensureAscii('em\u2014dash')).toBe('em\\u2014dash');
    expect(ensureAscii('plain ascii \\" ok')).toBe('plain ascii \\" ok');
  });

  it('agrees with the regex form it replaced on every UTF-16 code unit', async () => {
    const { ensureAscii } = await import('../src/util/ensure-ascii.js');
    // The six deleted copies used this regex. Written with escapes so this
    // source file stays ASCII (two of the deleted copies did not).
    const regexForm = (json: string): string =>
      json.replace(
        /[\u0080-\uffff]/g,
        (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
      );
    for (let unit = 0; unit <= 0xffff; unit++) {
      const s = String.fromCharCode(unit);
      expect(ensureAscii(s)).toBe(regexForm(s));
    }
  });
});
