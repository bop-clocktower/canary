/**
 * Pattern-based test healer.
 *
 * Applies
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
 * flag; `re.MULTILINE` maps to `m`.
 *
 * Every rule is a line-for-line substitution (#1310): a match never spans a
 * newline and the replacement adds none. That keeps blank lines around a
 * healed line intact and keeps the line count invariant across passes, so a
 * later rule's `lineOf` on the rewritten text is the line in the original file.
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
// where Python matched nothing — and since `apply()` rewrites the file,
// that silently changes content. So we anchor on `\n` explicitly —
// `(?:^|(?<=\n))` for line start, `(?=\n|$)` for line end — and drop `/m`.
//
// NOTE on whitespace: the rules use `[ \t]` where they mean "spacing on this
// line". `\s` also matches `\n` and `\r`, which let the indent group start on
// a blank line above the call (wrong reported line) and the trailing run eat
// the blank lines below it (#1310). The line end allows an optional `\r` so a
// CRLF file still heals and keeps its `\r`. Sleep/wait arguments stop at a
// newline too: collapsing a multi-line call would shift every later line.

// time.sleep(N) → # TODO: replace with event-based wait
const PY_SLEEP =
  /(?:^|(?<=\n))([ \t]*)time\.sleep[ \t]*\([^)\n]*\)[ \t]*(?=\r?\n|$)/g;

// page.waitForTimeout(N) → # TODO: replace with event-based wait
const PW_WAIT_TIMEOUT =
  /(?:^|(?<=\n))([ \t]*)(await[ \t]+)?page\.waitForTimeout[ \t]*\([^)\n]*\)[ \t]*;?[ \t]*(?=\r?\n|$)/g;

// Missing await before Playwright action — line starts with indentation then
// page/frame/locator.<action>( without a leading await
const BARE_PW_ACTION =
  /(?:^|(?<=\n))([ \t]*)((?:page|frame|locator)\.(?:click|fill|type|check|uncheck|selectOption|hover|focus|press|tap|dblclick)\s*\([^)]*\))/g;

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

/**
 * Python `str[:n]` slices by code point; JS `slice` slices by UTF-16 unit, so
 * an astral char (e.g. an emoji) counts as 2 and truncates early. Slice by code
 * point to match Python slicing.
 */
function takeCodePoints(s: string, n: number): string {
  return Array.from(s).slice(0, n).join('');
}

function fixPySleep(code: string, changes: HealChange[]): string {
  return code.replace(
    PY_SLEEP,
    (full: string, indent: string, offset: number): string => {
      const after = `${indent}# TODO(canary): replace with an event-based wait (e.g. waitFor, wait_for_selector)`;
      changes.push(
        new HealChange(
          lineOf(code, offset),
          'HEAL-001',
          full,
          after,
          'Replaced time.sleep() with a TODO comment.',
        ),
      );
      return after;
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
      const after = `${indent}// TODO(canary): replace with an event-based wait (e.g. await expect(locator).toBeVisible())`;
      changes.push(
        new HealChange(
          lineOf(code, offset),
          'HEAL-002',
          full,
          after,
          'Replaced page.waitForTimeout() with a TODO comment.',
        ),
      );
      return after;
    },
  );
}

function fixMissingAwait(code: string, changes: HealChange[]): string {
  return code.replace(
    BARE_PW_ACTION,
    (full: string, indent: string, call: string, offset: number): string => {
      const after = `${indent}await ${call}`;
      changes.push(
        new HealChange(
          lineOf(code, offset),
          'HEAL-003',
          full,
          after,
          `Added missing \`await\` before \`${takeCodePoints(call, 40)}\`.`,
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
    // Sync Python Playwright has no `await`: inside a plain `def` the added
    // keyword is a SyntaxError written to disk. Whether a Python call sits in
    // an `async def` needs scope this regex pass does not have, so the fix is
    // not unambiguous there and is not applied.
    if (!path.endsWith('.py')) code = fixMissingAwait(code, result.changes);

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
