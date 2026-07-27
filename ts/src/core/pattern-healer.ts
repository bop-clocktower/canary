/**
 * Pattern-based test healer.
 *
 * Faithful TypeScript port of `agent/core/pattern_healer.py`. Applies
 * regex-safe, deterministic fixes to test files without an LLM. Powers
 * `canary heal-test --pattern`.
 *
 * Only fixes that are unambiguously correct are applied automatically:
 *  - Hardcoded sleeps → replaced with a TODO comment pointing at event-based
 *    waits.
 *  - Missing `await` before Playwright action calls.
 *
 * Selector fixes are NOT auto-applied — swapping a selector without the actual
 * DOM snapshot produces wrong fixes. Selector issues are flagged but left for
 * the developer (or the /canary-heal-test slash command) to fix.
 *
 * Python→TS nuances: `re.sub` (replace-all) maps to `String.replace` with a `g`
 * flag; `re.MULTILINE` maps to `m`. The greedy `\s*$` backtracking that
 * governs whether a trailing newline is consumed is identical across both
 * engines, so `before`/line-number bookkeeping matches byte-for-byte.
 */

import { readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export class HealChange {
  constructor(
    public line: number,
    public rule: string,
    public before: string,
    public after: string,
    public description: string,
  ) {}
}

export class HealResult {
  file: string;
  changes: HealChange[];
  skipped: string[];
  patched_content: string;

  constructor(file: string) {
    this.file = file;
    this.changes = [];
    this.skipped = [];
    this.patched_content = '';
  }

  get changed(): boolean {
    return this.changes.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Fix rules
// ---------------------------------------------------------------------------

// NOTE on anchors: Python's `re.MULTILINE` treats ONLY `\n` as a line
// boundary, but JS caret/dollar under /m also break on lone CR and
// U+2028/U+2029. Under /g that would let these rules fire on lone-CR /
// where the oracle matches nothing — and since `apply()` rewrites the file,
// that silently changes content. So we anchor on `\n` explicitly —
// `(?:^|(?<=\n))` for line start, `(?=\n|$)` for line end — and drop `/m`.

// time.sleep(N) → # TODO: replace with event-based wait
const PY_SLEEP = /(?:^|(?<=\n))(\s*)time\.sleep\s*\([^)]*\)\s*(?=\n|$)/g;

// page.waitForTimeout(N) → # TODO: replace with event-based wait
const PW_WAIT_TIMEOUT =
  /(?:^|(?<=\n))(\s*)(await\s+)?page\.waitForTimeout\s*\([^)]*\)\s*;?\s*(?=\n|$)/g;

// Missing await before Playwright action — line starts with indentation then
// page/frame/locator.<action>( without a leading await
const BARE_PW_ACTION =
  /(?:^|(?<=\n))(\s*)((?:page|frame|locator)\.(?:click|fill|type|check|uncheck|selectOption|hover|focus|press|tap|dblclick)\s*\([^)]*\))/g;

// Brittle-selector detection (flag-only; never auto-fixed).
const SELECTOR_SKIP = new RegExp(
  `['"]\\.[a-zA-Z][\\w\\-]*['"]|['"]#[a-zA-Z][\\w\\-]*['"]|['"]/+[a-zA-Z\\[\\]/@*]`,
);

/** Python `code[:m.start()].count("\n") + 1`. */
function lineOf(code: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) {
    if (code[i] === '\n') n++;
  }
  return n;
}

/** Python `str.rstrip("\n")`. */
function rstripNewlines(s: string): string {
  return s.replace(/\n+$/, '');
}

/**
 * Python `str[:n]` slices by code point; JS `slice` slices by UTF-16 unit, so
 * an astral char (e.g. an emoji) counts as 2 and truncates early. Slice by code
 * point to match the oracle.
 */
function pySlice(s: string, n: number): string {
  return Array.from(s).slice(0, n).join('');
}

function fixPySleep(code: string, changes: HealChange[]): string {
  return code.replace(
    PY_SLEEP,
    (full: string, indent: string, offset: number): string => {
      const before = rstripNewlines(full);
      const after = `${indent}# TODO(canary): replace with an event-based wait (e.g. waitFor, wait_for_selector)`;
      changes.push(
        new HealChange(
          lineOf(code, offset),
          'HEAL-001',
          before,
          after,
          'Replaced time.sleep() with a TODO comment.',
        ),
      );
      return after + '\n';
    },
  );
}

function fixPwWaitTimeout(code: string, changes: HealChange[]): string {
  return code.replace(
    PW_WAIT_TIMEOUT,
    (
      full: string,
      indent: string,
      _await: string | undefined,
      offset: number,
    ): string => {
      const before = rstripNewlines(full);
      const after = `${indent}// TODO(canary): replace with an event-based wait (e.g. await expect(locator).toBeVisible())`;
      changes.push(
        new HealChange(
          lineOf(code, offset),
          'HEAL-002',
          before,
          after,
          'Replaced page.waitForTimeout() with a TODO comment.',
        ),
      );
      return after + '\n';
    },
  );
}

function fixMissingAwait(code: string, changes: HealChange[]): string {
  return code.replace(
    BARE_PW_ACTION,
    (full: string, indent: string, call: string, offset: number): string => {
      const before = rstripNewlines(full);
      const after = `${indent}await ${call}`;
      changes.push(
        new HealChange(
          lineOf(code, offset),
          'HEAL-003',
          before,
          after,
          `Added missing \`await\` before \`${pySlice(call, 40)}\`.`,
        ),
      );
      return after;
    },
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Applies deterministic, regex-safe fixes to test files. */
export class PatternHealer {
  heal(path: string): HealResult {
    const original = readFileSync(path, 'utf-8');
    const result = new HealResult(path);
    let code = original;

    code = fixPySleep(code, result.changes);
    code = fixPwWaitTimeout(code, result.changes);
    code = fixMissingAwait(code, result.changes);

    result.patched_content = code;

    // Note what we deliberately skip.
    if (SELECTOR_SKIP.test(original)) {
      result.skipped.push(
        'Brittle selectors detected but not auto-fixed — selector swaps require DOM context. ' +
          'Use /canary-heal-test in Claude Code for selector repair.',
      );
    }

    return result;
  }

  /** Heal and write the result back to disk. */
  apply(path: string): HealResult {
    const result = this.heal(path);
    if (result.changed) {
      writeFileSync(path, result.patched_content, 'utf-8');
    }
    return result;
  }
}
