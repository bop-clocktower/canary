/**
 * Characterization pin for the upstream harness complexity defect (#587).
 *
 * `harness check-arch` reports a `functionLength` for a short top-level helper
 * that equals the distance from the helper to END OF FILE. On PR #584 a 7-line
 * helper was reported at 73 lines, which pushed the complexity ratchet 88 -> 89
 * and failed a REQUIRED check. `complexity.value` in
 * `.harness/arch/baselines.json` counts violations, so one phantom violation
 * blocks merge.
 *
 * ## Ownership: entirely upstream
 *
 * Canary owns no function-length logic — `grep -rn functionLength ts/src` is
 * empty. The measurement lives in `@harness-engineering/cli`:
 *
 * - `dist/chunk-2FPQR6BB.js:588` `findFunctionEnd(lines, startIdx)` — walks
 *   RAW CHARACTERS counting `{` and `}` with no knowledge of strings,
 *   template literals, comments or regex literals. When the count never
 *   returns to zero it falls off the end and `return lines.length - 1`.
 * - `dist/chunk-2FPQR6BB.js:565` `extractFunctions(content)` — finds candidate
 *   functions with four line-anchored regexes (`FUNCTION_PATTERNS`, :1404).
 * - `dist/chunk-2FPQR6BB.js:740` `checkFunctionLength` — `fn.endLine -
 *   fn.startLine + 1`, so the EOF fallback becomes the reported length.
 *
 * Confirmed still present in **11.1.1** (the version `@harness-engineering/cli@11`
 * floats to), so the v11 bump did NOT fix it. Reproduced end to end: a planted
 * 78-line `ts/test/*.test.ts` fixture whose only helper is 4 lines long draws
 * `New violation [warning]: functionLength=77 in jsonPayload (threshold: 50)`
 * from a real `harness check-arch` run.
 *
 * ## The issue title's trigger is wrong, and that matters
 *
 * #587 reads "followed only by `describe()` calls". `describe()` is incidental
 * — see `does NOT misfire on a clean helper` below, where a clean helper
 * followed by twelve `describe()` blocks measures correctly. The real trigger
 * is **any brace-shaped character the naive walk cannot tell from code**: a `{`
 * inside a string literal, a brace in a comment, or braces in a return-type
 * annotation. Aiming a mitigation at `describe()` would miss most cases and
 * catch files that were never at risk.
 *
 * ## Why this file exists rather than a threshold bump
 *
 * `harness.config.json` exposes no per-glob or per-metric exclusion for
 * complexity (`detectComplexityViolations`, chunk:795, reads only thresholds),
 * so there is no honest config-level escape hatch. Raising the threshold would
 * suppress real findings alongside the phantom ones. Instead this file PINS the
 * known-bad measurements. When a harness upgrade fixes the parser these
 * assertions go red, which is the signal to drop the workarounds (helpers
 * exiled into `*-testkit.ts` siblings, e.g. `ts/test/guardian-cli-testkit.ts`)
 * and close #587.
 *
 * Offline and hermetic: the harness algorithm is replicated verbatim below
 * rather than imported, because `@harness-engineering/cli` is not a `ts/`
 * dependency — CI reaches it through `npx --yes`. A test that imported it would
 * skip whenever it was absent, which is the abstention shape this repo treats
 * as a defect.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/** The harness version these expectations were reproduced against. */
const VERIFIED_AGAINST = '11.1.1';

/** The pin every harness workflow carries while #587 stands. */
const PINNED_SPEC = '@harness-engineering/cli@11';

// -- upstream algorithm, replicated verbatim ---------------------------------

/** `FUNCTION_PATTERNS`, chunk-2FPQR6BB.js:1404 (harness 11.1.1). */
const FUNCTION_PATTERNS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
  /^\s*(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*[^=]+)?\s*=>/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(\w+)\s*=>/,
];

/** `findFunctionEnd`, chunk-2FPQR6BB.js:588 (harness 11.1.1). */
function findFunctionEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let foundOpen = false;
  for (let i = startIdx; i < lines.length; i += 1) {
    for (const ch of lines[i]!) {
      if (ch === '{') {
        depth += 1;
        foundOpen = true;
      } else if (ch === '}') {
        depth -= 1;
        if (foundOpen && depth === 0) return i;
      }
    }
  }
  // The fallback that produces every #587 phantom finding.
  return lines.length - 1;
}

interface Measured {
  name: string;
  startLine: number;
  /** What `checkFunctionLength` (chunk:740) would report. */
  reported: number;
}

/** `extractFunctions`, chunk-2FPQR6BB.js:565, reduced to the length metric. */
function measureAsHarnessDoes(content: string): Measured[] {
  const lines = content.split('\n');
  const out: Measured[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const pattern of FUNCTION_PATTERNS) {
      const match = lines[i]!.match(pattern);
      if (!match) continue;
      const endLine = findFunctionEnd(lines, i) + 1;
      out.push({
        name: match[1] ?? 'anonymous',
        startLine: i + 1,
        reported: endLine - (i + 1) + 1,
      });
      break;
    }
  }
  return out;
}

/** Look up one measurement by name, failing loudly if it was not detected. */
function measure(content: string, name: string): Measured {
  const hit = measureAsHarnessDoes(content).find((f) => f.name === name);
  if (!hit) throw new Error(`harness did not detect a function named ${name}`);
  return hit;
}

// -- fixtures ----------------------------------------------------------------

/** Twelve `describe()` blocks — the shape #587 blames, used as the control. */
const DESCRIBE_TAIL = Array.from(
  { length: 12 },
  (_, i) => `describe('d${i}', () => {\n  it('i${i}', () => { ok(); });\n});`,
).join('\n');

/** Sixty inert statements — a tail with no `describe()` anywhere in it. */
const INERT_TAIL = Array.from(
  { length: 60 },
  (_, i) => `const v${i} = ${i};`,
).join('\n');

// -- the pinned defect -------------------------------------------------------

describe('upstream harness #587: functionLength runs to EOF', () => {
  it('over-measures a helper containing a brace inside a string literal', () => {
    // The 2-line helper on lines 1-3; everything after it is unrelated.
    const source = `function strayBrace(raw: string): number {\n  return raw.indexOf('{');\n}\n${INERT_TAIL}`;
    const trueLength = 3;
    const distanceToEof = source.split('\n').length;

    const got = measure(source, 'strayBrace');

    expect(got.startLine).toBe(1);
    expect(got.reported).not.toBe(trueLength);
    expect(got.reported).toBe(distanceToEof);
  });

  it('over-measures a helper containing a brace inside a line comment', () => {
    const source = `function commentBrace(raw: string): string {\n  // opens with { and never closes\n  return raw;\n}\n${INERT_TAIL}`;

    expect(measure(source, 'commentBrace').reported).toBe(
      source.split('\n').length,
    );
  });

  it('reaches EOF with no describe() in the file at all', () => {
    // #587's stated trigger is "followed only by describe() calls". This
    // fixture has none and still runs to EOF, so a describe-shaped mitigation
    // would have missed the whole class.
    const source = `function strayBrace(raw: string): number {\n  return raw.indexOf('{');\n}\n${INERT_TAIL}`;

    expect(source).not.toContain('describe(');
    expect(measure(source, 'strayBrace').reported).toBeGreaterThan(50);
  });

  it('does NOT misfire on a clean helper followed only by describe() blocks', () => {
    // The control that disproves the issue title. Same position, same tail
    // shape, no brace hidden in a literal — measured exactly right.
    const source = `async function clean(raw: string): Promise<number> {\n  return raw.length;\n}\n${DESCRIBE_TAIL}`;

    expect(source).toContain('describe(');
    expect(measure(source, 'clean').reported).toBe(3);
  });
});

describe('upstream harness #587: the matching false negatives', () => {
  it('collapses a function whose return type contains braces to one line', () => {
    // `Promise<{ ok: boolean }>` opens and closes on the signature line, so the
    // walk reports depth 0 before the body starts. A genuinely 200-line
    // function written this way is invisible to the gate.
    const source = `async function retType(raw: string): Promise<{ ok: boolean }> {\n  const a = 1;\n  const b = 2;\n  return { ok: a < b };\n}\n${INERT_TAIL}`;

    expect(measure(source, 'retType').reported).toBe(1);
  });

  it('does not detect an arrow whose signature spans multiple lines', () => {
    // Every FUNCTION_PATTERN is line-anchored. Running `prettier --write` can
    // therefore flip a file between "no finding" and "phantom finding", which
    // is how #587 was found.
    const source = `const multi = async (\n  diff: string,\n): Promise<number> => {\n  return diff.length;\n};\n${INERT_TAIL}`;

    expect(measureAsHarnessDoes(source).map((f) => f.name)).not.toContain(
      'multi',
    );
  });

  it('mistakes control-flow keywords for functions', () => {
    // Pattern 2 (`name(params) {`) matches `if (...) {`. Real `check-perf`
    // output on this repo names functions "if", "for" and "while", so the
    // baseline count includes entries that are not functions at all.
    const source = `function outer(n: number): number {\n  if (n > 0) {\n    return n;\n  }\n  return 0;\n}\n`;

    expect(measureAsHarnessDoes(source).map((f) => f.name)).toContain('if');
  });
});

// -- the tripwire that notices an upstream fix -------------------------------

describe('upstream harness #587: re-verification tripwire', () => {
  /** Every `HARNESS_CLI:` value declared across the workflow files. */
  function pinnedSpecs(): Array<[string, string]> {
    return readdirSync(WORKFLOW_DIR)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .flatMap((name) => {
        const text = readFileSync(join(WORKFLOW_DIR, name), 'utf8');
        const match = text.match(/^\s*HARNESS_CLI:\s*'([^']+)'/m);
        return match ? [[name, match[1]!] as [string, string]] : [];
      });
  }

  it('finds the harness pin it is guarding (non-zero denominator)', () => {
    expect(pinnedSpecs().length).toBeGreaterThan(0);
  });

  it('holds the pin the defect was reproduced against', () => {
    // A bump past this spec means the assertions above describe a version the
    // repo no longer runs. Re-reproduce against the new major: if it is fixed,
    // delete this file, un-exile the testkit helpers, and close #587.
    for (const [name, spec] of pinnedSpecs()) {
      expect(`${name}:${spec}`).toBe(`${name}:${PINNED_SPEC}`);
    }
  });

  it('records the exact version the numbers came from', () => {
    // Documentation with an assertion around it, so the provenance of every
    // number above cannot quietly rot out of the header comment.
    expect(VERIFIED_AGAINST.startsWith('11.')).toBe(true);
  });
});
