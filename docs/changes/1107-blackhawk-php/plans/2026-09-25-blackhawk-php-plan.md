# Plan: canary-blackhawk PHP support (#1107)

Spec: `docs/changes/1107-blackhawk-php/proposal.md`. Single phase, complexity
low, 4 tasks, 1 checkpoint. Auto-approved (no approval signal fired: low
complexity, no concerns, 4 tasks).

All paths are relative to `agents/skills/`.

## Task 1: failing tests (TDD red)

**Files:** `test/canary-blackhawk.test.ts`

Add a `PHP support (#1107)` describe block covering, with synthetic,
de-identified PHPUnit / WordPress lines:

- BH001-BH004: positives and negatives per rule (spec D5, D6, D8).
- Frozen-clock suppression per PHP marker; BH003 not suppressed.
- String literal, full-line comment and trailing comment rejection (D4).
- Language gating: PHP-only tokens do not fire on `.py` / `.ts` (D1).
- Path selection: `tests/ClockTest.php`, `test-clock.php` scanned;
  `src/Clock.php` skipped in a directory walk; `.php` named explicitly is
  scanned.

Run `npx vitest run test/canary-blackhawk.test.ts`; the new block must be red.

## Task 2: rule variants

**Files:** `claude-code/canary-blackhawk/scripts/rules.mjs`

PHP markers, `php: { pattern, keep }` per rule, `delayIsPositive` over all
`delay*` groups, `phpNaiveDatetime` keep for BH004.

## Task 3: scanner

**Files:** `claude-code/canary-blackhawk/scripts/scanner.mjs`

`.php` suffix, PHP test-file naming, per-language variant selection, PHP
trailing-comment rejection. Tests go green.

`[checkpoint:human-verify]` (autonomous: planted positive instead) - break one
PHP pattern and confirm the suite goes red, then restore.

## Task 4: docs and gates

**Files:** `claude-code/canary-blackhawk/SKILL.md`

Rules table, markers, file naming, suffix list. Run prettier, then the
`agents/skills` gates (typecheck, format:check, test) and the `ts/` gates
(build, typecheck, format:check, test).
