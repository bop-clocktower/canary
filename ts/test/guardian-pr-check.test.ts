/**
 * Faithful TypeScript port of `tests/unit/test_guardian_pr_check.py`.
 *
 * Phase 1 (agent-free). Covers diff scoping, findings, suppression, gate exit
 * codes, and renderers. The Typer CLI cases (`TestPrCheckCLI`) and the Python
 * package-export smoke test are DEFERRED to the later CLI wave.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ChangedUnit,
  type CoverageResult,
  Fidelity,
} from '../src/guardian/coverage.js';
import { type CoverageInputState } from '../src/guardian/diff-coverage/orchestrator.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import {
  DEFAULT_SKIP_GLOBS,
  GuardianFinding,
  applySuppressions,
  buildFindings,
  computeExitCode,
  filterHeuristicNoise,
  filterSkipped,
  filterTestUnits,
  findReexportOnly,
  isCoverageAbstention,
  renderFindings,
  scopeDiff,
} from '../src/guardian/pr-check.js';
import { buildWeakTestFindings } from '../src/guardian/weak-test.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIFF_TWO_FILES = `diff --git a/agent/core/foo.py b/agent/core/foo.py
index 1111111..2222222 100644
--- a/agent/core/foo.py
+++ b/agent/core/foo.py
@@ -11,0 +12,17 @@ def existing():
+added line 12
+added line 13
+added line 14
+added line 15
+added line 16
+added line 17
+added line 18
+added line 19
+added line 20
+added line 21
+added line 22
+added line 23
+added line 24
+added line 25
+added line 26
+added line 27
+added line 28
diff --git a/agent/core/bar.py b/agent/core/bar.py
index 3333333..4444444 100644
--- a/agent/core/bar.py
+++ b/agent/core/bar.py
@@ -1,2 +1,3 @@
 keep
+new bar line
 keep2
`;

const DIFF_PURE_DELETE = `diff --git a/agent/core/gone.py b/agent/core/gone.py
index 5555555..6666666 100644
--- a/agent/core/gone.py
+++ b/agent/core/gone.py
@@ -5,3 +5,0 @@ def doomed():
-removed line 5
-removed line 6
-removed line 7
`;

const DIFF_DELETED_FILE = `diff --git a/agent/core/dead.py b/agent/core/dead.py
deleted file mode 100644
index 7777777..0000000
--- a/agent/core/dead.py
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;

function byPath(units: ChangedUnit[]): Record<string, ChangedUnit> {
  return Object.fromEntries(units.map((u) => [u.path, u]));
}

// ---------------------------------------------------------------------------
// scopeDiff
// ---------------------------------------------------------------------------

describe('scopeDiff', () => {
  it('two files → added ranges', () => {
    const units = scopeDiff(DIFF_TWO_FILES);
    const by = byPath(units);
    expect(new Set(Object.keys(by))).toEqual(
      new Set(['agent/core/foo.py', 'agent/core/bar.py']),
    );

    // 17 consecutive added lines starting at 12 → merged range [12, 28].
    expect(by['agent/core/foo.py']!.added_ranges).toEqual([[12, 28]]);
    expect(by['agent/core/bar.py']!.added_ranges).toEqual([[2, 2]]);
  });

  it('pure deletion yields no added ranges → excluded entirely', () => {
    const units = scopeDiff(DIFF_PURE_DELETE);
    expect(units.every((u) => u.added_ranges.length > 0)).toBe(true);
    expect(units.map((u) => u.path)).not.toContain('agent/core/gone.py');
  });

  it('deleted file skipped', () => {
    expect(scopeDiff(DIFF_DELETED_FILE)).toEqual([]);
  });

  it('empty diff', () => {
    expect(scopeDiff('')).toEqual([]);
  });

  it('added body line starting `+++` is not a phantom header (FIX 7)', () => {
    const diff =
      'diff --git a/pkg/mod.py b/pkg/mod.py\n' +
      'index 1111111..2222222 100644\n' +
      '--- a/pkg/mod.py\n' +
      '+++ b/pkg/mod.py\n' +
      '@@ -1,2 +1,3 @@\n' +
      ' keep\n' +
      '+++ evil\n' +
      ' keep2\n';
    const by = byPath(scopeDiff(diff));
    expect('evil' in by).toBe(false); // no phantom file header
    expect('pkg/mod.py' in by).toBe(true);
    // The `+++ evil` add lands on new-file line 2 (after context ` keep`).
    expect(by['pkg/mod.py']!.added_ranges).toEqual([[2, 2]]);
  });

  it('decodes a git-quoted (non-ASCII) path header', () => {
    // `git diff` quotes a path containing non-ASCII bytes (core.quotePath
    // defaults to true), emitting `+++ "b/caf\303\251.ts"`. The quotes and the
    // octal escapes are diff SYNTAX, not part of the filename.
    const diff =
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n' +
      'index 1111111..2222222 100644\n' +
      '--- "a/caf\\303\\251.ts"\n' +
      '+++ "b/caf\\303\\251.ts"\n' +
      '@@ -1 +1,2 @@\n' +
      ' a\n' +
      '+b\n';
    const paths = scopeDiff(diff).map((u) => u.path);
    expect(paths).toEqual(['café.ts']);

    // False-green consequence: with the quotes left on, the unit's extension
    // reads as `.ts"`, `isSourcePath` says "not program source", and
    // filterHeuristicNoise drops the uncovered finding silently.
    const unit = scopeDiff(diff)[0]!;
    const [kept] = filterHeuristicNoise(
      [
        {
          unit,
          covered: false,
          fidelity: Fidelity.Heuristic,
          evidence: 'no test file mentions this',
        } as CoverageResult,
      ],
      [],
    );
    expect(kept).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildFindings
// ---------------------------------------------------------------------------

function result(
  covered: boolean,
  fidelity: Fidelity,
  path = 'pkg/foo.py',
  evidence = 'ev',
): CoverageResult {
  return {
    unit: { path, added_ranges: [[1, 3]] },
    covered,
    fidelity,
    evidence,
    uncovered_lines: [],
  };
}

describe('buildFindings', () => {
  it('covered result yields no finding', () => {
    expect(buildFindings([result(true, Fidelity.CoverageVerified)])).toEqual(
      [],
    );
  });

  it('uncovered heuristic is MEDIUM', () => {
    const findings = buildFindings([result(false, Fidelity.Heuristic)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe(Severity.MEDIUM);
    expect(findings[0]!.fidelity).toBe(Fidelity.Heuristic);
    expect(findings[0]!.kind).toBe('untested-new-code');
  });

  it('uncovered graph is HIGH', () => {
    const findings = buildFindings([result(false, Fidelity.GraphVerified)]);
    expect(findings[0]!.severity).toBe(Severity.HIGH);
  });

  it('uncovered report is HIGH', () => {
    const findings = buildFindings([result(false, Fidelity.CoverageVerified)]);
    expect(findings[0]!.severity).toBe(Severity.HIGH);
  });

  it('findings sorted critical → low', () => {
    const findings = buildFindings([
      result(false, Fidelity.Heuristic, 'a.py'), // MEDIUM
      result(false, Fidelity.GraphVerified, 'b.py'), // HIGH
    ]);
    expect(findings.map((f) => f.severity)).toEqual([
      Severity.HIGH,
      Severity.MEDIUM,
    ]);
  });

  it('evidence and path propagated', () => {
    const finding = buildFindings([
      result(
        false,
        Fidelity.GraphVerified,
        'pkg/bar.py',
        'no test reaches pkg/bar.py',
      ),
    ])[0]!;
    expect(finding.path).toBe('pkg/bar.py');
    expect(finding.evidence).toBe('no test reaches pkg/bar.py');
    expect(finding).toBeInstanceOf(GuardianFinding);
  });
});

// ---------------------------------------------------------------------------
// Suppressions
// ---------------------------------------------------------------------------

describe('applySuppressions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canary-prcheck-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, body: string): void {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf-8');
  }

  it('hash annotation suppresses', () => {
    write(
      'pkg/foo.py',
      'def foo():\n    return 1  # canary:allow-untested legacy shim\n',
    );
    const out = applySuppressions(
      [new GuardianFinding({ path: 'pkg/foo.py', unit: 'foo' })],
      dir,
    );
    expect(out[0]!.suppressed).toBe(true);
    expect(out[0]!.suppression_reason).toBe('legacy shim');
  });

  it('slash annotation suppresses', () => {
    write(
      'pkg/foo.ts',
      'export function foo() {} // canary:allow-untested vendor code\n',
    );
    const out = applySuppressions(
      [new GuardianFinding({ path: 'pkg/foo.ts', unit: 'foo' })],
      dir,
    );
    expect(out[0]!.suppressed).toBe(true);
    expect(out[0]!.suppression_reason).toBe('vendor code');
  });

  it('no annotation not suppressed', () => {
    write('pkg/bar.py', 'def bar():\n    return 2\n');
    const out = applySuppressions(
      [new GuardianFinding({ path: 'pkg/bar.py', unit: 'bar' })],
      dir,
    );
    expect(out[0]!.suppressed).toBe(false);
    expect(out[0]!.suppression_reason).toBeNull();
  });

  it('suppressed finding stays in list', () => {
    write('a.py', 'x = 1  # canary:allow-untested reason\n');
    const out = applySuppressions(
      [new GuardianFinding({ path: 'a.py', unit: 'a' })],
      dir,
    );
    expect(out).toHaveLength(1);
  });

  it('string-literal token does not suppress (FIX 1)', () => {
    write(
      'pkg/foo.py',
      'def foo():\n    x = "canary:allow-untested bypass"\n    return x\n',
    );
    const out = applySuppressions(
      [
        new GuardianFinding({
          path: 'pkg/foo.py',
          unit: 'foo',
          added_ranges: [[1, 3]],
        }),
      ],
      dir,
    );
    expect(out[0]!.suppressed).toBe(false);
    expect(out[0]!.suppression_reason).toBeNull();
  });

  it('comment leader on added line suppresses (FIX 1)', () => {
    write(
      'pkg/foo.py',
      'def foo():\n    return 1  # canary:allow-untested legacy shim\n',
    );
    const out = applySuppressions(
      [
        new GuardianFinding({
          path: 'pkg/foo.py',
          unit: 'foo',
          added_ranges: [[2, 2]],
        }),
      ],
      dir,
    );
    expect(out[0]!.suppressed).toBe(true);
    expect(out[0]!.suppression_reason).toBe('legacy shim');
  });

  it('annotation outside added range ignored (FIX 1)', () => {
    write(
      'pkg/foo.py',
      'def foo():  # canary:allow-untested unrelated old comment\n' +
        '    added = 1\n' +
        '    return added\n',
    );
    const out = applySuppressions(
      [
        new GuardianFinding({
          path: 'pkg/foo.py',
          unit: 'foo',
          added_ranges: [[2, 3]],
        }),
      ],
      dir,
    );
    expect(out[0]!.suppressed).toBe(false);
  });

  it('inline-comment close stripped from reason (FIX 1)', () => {
    write(
      'pkg/foo.ts',
      'export const x = 1;  // canary:allow-untested vendor code */\n',
    );
    const out = applySuppressions(
      [
        new GuardianFinding({
          path: 'pkg/foo.ts',
          unit: 'x',
          added_ranges: [[1, 1]],
        }),
      ],
      dir,
    );
    expect(out[0]!.suppressed).toBe(true);
    expect(out[0]!.suppression_reason).toBe('vendor code');
  });
});

// ---------------------------------------------------------------------------
// computeExitCode
// ---------------------------------------------------------------------------

describe('computeExitCode', () => {
  it('hard unaddressed HIGH exits nonzero', () => {
    const findings = [
      new GuardianFinding({ path: 'a.py', unit: 'a', severity: Severity.HIGH }),
    ];
    expect(computeExitCode(findings, 'hard')).toBe(1);
  });

  it('hard unaddressed CRITICAL exits nonzero', () => {
    const findings = [
      new GuardianFinding({
        path: 'a.py',
        unit: 'a',
        severity: Severity.CRITICAL,
      }),
    ];
    expect(computeExitCode(findings, 'hard')).toBe(1);
  });

  it('hard suppressed HIGH exits zero', () => {
    const findings = [
      new GuardianFinding({
        path: 'a.py',
        unit: 'a',
        severity: Severity.HIGH,
        suppressed: true,
      }),
    ];
    expect(computeExitCode(findings, 'hard')).toBe(0);
  });

  it('hard only MEDIUM/LOW exits zero', () => {
    const findings = [
      new GuardianFinding({
        path: 'a.py',
        unit: 'a',
        severity: Severity.MEDIUM,
      }),
      new GuardianFinding({ path: 'b.py', unit: 'b', severity: Severity.LOW }),
    ];
    expect(computeExitCode(findings, 'hard')).toBe(0);
  });

  it('soft unaddressed CRITICAL exits zero', () => {
    const findings = [
      new GuardianFinding({
        path: 'a.py',
        unit: 'a',
        severity: Severity.CRITICAL,
      }),
    ];
    expect(computeExitCode(findings, 'soft')).toBe(0);
  });

  it('empty findings exits zero', () => {
    expect(computeExitCode([], 'hard')).toBe(0);
  });

  it('hard wrong kind exits zero', () => {
    const findings = [
      new GuardianFinding({
        path: 'a.py',
        unit: 'a',
        kind: 'weak-test',
        severity: Severity.HIGH,
      }),
    ];
    expect(computeExitCode(findings, 'hard')).toBe(0);
  });

  it('hard mixed case still enforces (FIX 5)', () => {
    const findings = [
      new GuardianFinding({ path: 'a.py', unit: 'a', severity: Severity.HIGH }),
    ];
    expect(computeExitCode(findings, 'Hard')).toBe(1);
  });

  it('hard padded still enforces (FIX 5)', () => {
    const findings = [
      new GuardianFinding({ path: 'a.py', unit: 'a', severity: Severity.HIGH }),
    ];
    expect(computeExitCode(findings, ' hard ')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// renderFindings
// ---------------------------------------------------------------------------

function finding(
  overrides: Partial<ConstructorParameters<typeof GuardianFinding>[0]> = {},
): GuardianFinding {
  return new GuardianFinding({
    path: 'pkg/foo.py',
    unit: 'foo',
    severity: Severity.HIGH,
    fidelity: Fidelity.GraphVerified,
    evidence: 'no test reaches foo',
    ...overrides,
  });
}

describe('renderFindings', () => {
  it('comment has sticky marker and fidelity', () => {
    const out = renderFindings([finding()], 'comment');
    expect(out).toContain('<!-- canary-pr-guardian -->');
    expect(out).toContain('graph-verified');
    expect(out).toContain('pkg/foo.py');
  });

  it('comment marks suppressed', () => {
    const out = renderFindings(
      [finding({ suppressed: true, suppression_reason: 'legacy' })],
      'comment',
    );
    expect(out.toLowerCase()).toContain('suppressed');
  });

  it('comment footer shows tier and degraded notice', () => {
    const out = renderFindings([finding()], 'comment', 0, 'graph stale');
    expect(out.toLowerCase()).toContain('tier 0');
    expect(out).toContain('graph stale');
  });

  it('comment is actionable — header count, what-to-do, suppress hint', () => {
    const out = renderFindings([finding()], 'comment');
    expect(out).toContain('need'); // "1 file needs test coverage"
    expect(out).toContain('canary:allow-untested'); // the pragma that works
    expect(out).toContain('| Sev | File'); // scannable table
    expect(out).toContain('coverage-verified'); // plain-English confidence note
    expect(out).toContain('deterministic check, no LLM'); // demystified tier
  });

  it('advertises no remediation the tool does not implement (#489)', () => {
    // The sticky comment told every reviewer to reply
    // `/guardian suppress <file> <reason>`. Nothing has ever implemented a
    // slash command -- guardian does not read PR comments for input at all --
    // so the one instruction in the comment was the one thing that could not
    // work. This assertion is the guard: the previous version of the test
    // above actively pinned the false claim in place.
    const rendered = [
      renderFindings([finding()], 'comment'),
      renderFindings([], 'comment'),
      renderFindings([finding()], 'comment', 0, 'graph stale'),
    ];
    for (const out of rendered) {
      expect(out).not.toContain('/guardian ');
    }
  });

  it('comment does not print the path twice for a file-level finding', () => {
    const out = renderFindings(
      [finding({ path: 'pkg/foo.py', unit: 'pkg/foo.py' })],
      'comment',
    );
    expect(out).not.toContain('pkg/foo.py` → `pkg/foo.py'); // no self-arrow
    expect(out).not.toContain('(pkg/foo.py)'); // no `path (path)` duplication
    expect(out).toContain('`pkg/foo.py`');
  });

  it('comment shows the unit only when it differs from the path', () => {
    const out = renderFindings(
      [finding({ path: 'pkg/foo.py', unit: 'do_it' })],
      'comment',
    );
    expect(out).toContain('`pkg/foo.py` → `do_it`');
  });

  it('comment is clean when there are no active findings', () => {
    expect(renderFindings([], 'comment')).toContain('no test-coverage gaps');
  });

  it('json round-trips all findings', () => {
    const findings = [
      finding({ path: 'a.py', unit: 'a' }),
      finding({
        path: 'b.py',
        unit: 'b',
        severity: Severity.MEDIUM,
        fidelity: Fidelity.Heuristic,
      }),
    ];
    const data = JSON.parse(renderFindings(findings, 'json'));
    expect(data.tier).toBe(0);
    expect(data.findings).toHaveLength(2);
    expect(new Set(data.findings.map((f: { path: string }) => f.path))).toEqual(
      new Set(['a.py', 'b.py']),
    );
  });

  it('text has no HTML marker', () => {
    const out = renderFindings([finding()], 'text');
    expect(out).not.toContain('<!--');
    expect(out).toContain('pkg/foo.py');
  });

  it('json escapes non-ASCII like ensure_ascii (em-dash → \\u2014)', () => {
    // FIX 2: a weak-test finding's evidence carries an em-dash (U+2014). Python
    // `json.dumps(ensure_ascii=True)` escapes it; JSON.stringify would emit raw
    // UTF-8 and diverge byte-for-byte. Build a real weak-test finding.
    const diff = `diff --git a/tests/test_widget.py b/tests/test_widget.py
new file mode 100644
--- /dev/null
+++ b/tests/test_widget.py
@@ -0,0 +1,3 @@
+def test_widget():
+    w = make_widget()
+    print(w)
`;
    const [, units] = filterTestUnits(scopeDiff(diff));
    const findings = buildWeakTestFindings(units, diff);
    expect(findings).toHaveLength(1);

    const out = renderFindings(findings, 'json');
    // The escaped sequence is present; no raw em-dash survives.
    expect(out).toContain('\\u2014');
    expect(out).not.toContain('—');
    // No byte >= 0x80 anywhere in the rendered output.
    expect([...out].every((ch) => ch.charCodeAt(0) < 0x80)).toBe(true);
    // Still valid JSON that round-trips the real (unescaped) evidence.
    const data = JSON.parse(out);
    expect(data.findings[0].evidence).toContain('—');
  });
});

describe('renderFindings json gate meta (#508)', () => {
  it('adds checked/abstained when meta is provided', () => {
    const out = JSON.parse(
      renderFindings([], 'json', 0, null, { checked: 3, abstained: false }),
    );
    expect(out.checked).toBe(3);
    expect(out.abstained).toBe(false);
    expect(out.findings).toEqual([]);
  });

  it('omits the fields when meta is absent (byte-stable for emit)', () => {
    const out = JSON.parse(renderFindings([], 'json'));
    expect('checked' in out).toBe(false);
    expect('abstained' in out).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterSkipped
// ---------------------------------------------------------------------------

describe('filterSkipped', () => {
  it('skips matching globs, order-preserving', () => {
    const units: ChangedUnit[] = [
      { path: 'docs/guide.md', added_ranges: [[1, 2]] },
      { path: 'README.md', added_ranges: [[1, 2]] },
      { path: 'agent/core/foo.py', added_ranges: [[1, 2]] },
    ];
    const [kept, skipped] = filterSkipped(units, ['docs/**', '**/*.md']);
    expect(kept.map((u) => u.path)).toEqual(['agent/core/foo.py']);
    expect(skipped.map((u) => u.path)).toEqual(['docs/guide.md', 'README.md']);
  });

  it('empty globs keeps all', () => {
    const units: ChangedUnit[] = [
      { path: 'agent/core/foo.py', added_ranges: [[1, 2]] },
    ];
    const [kept, skipped] = filterSkipped(units, []);
    expect(kept).toEqual(units);
    expect(skipped).toEqual([]);
  });

  // #413: the default skip set must cover the dotfile/config/nested-harness FPs
  // a downstream overlay saw in its first guardian round (`.gitignore`,
  // `.neorc.dev`, nested `.harness/`).
  it('DEFAULT_SKIP_GLOBS skips dotfiles, nested harness, config, and fixtures', () => {
    const units: ChangedUnit[] = [
      { path: 'services/neo/.harness/.gitignore', added_ranges: [[1, 1]] },
      { path: 'services/neo/.neorc.dev', added_ranges: [[1, 1]] },
      { path: 'services/neo/.harness/state.json', added_ranges: [[1, 1]] },
      { path: 'vite.config.ts', added_ranges: [[1, 1]] },
      { path: 'src/__fixtures__/user.ts', added_ranges: [[1, 1]] },
      { path: 'packages/ui/src/Button.tsx', added_ranges: [[1, 1]] }, // real source
    ];
    const [kept, skipped] = filterSkipped(units, [...DEFAULT_SKIP_GLOBS]);
    expect(kept.map((u) => u.path)).toEqual(['packages/ui/src/Button.tsx']);
    expect(skipped.map((u) => u.path)).toContain('services/neo/.neorc.dev');
    expect(skipped.map((u) => u.path)).toContain(
      'services/neo/.harness/.gitignore',
    );
  });

  it('double-star matches nested', () => {
    const units: ChangedUnit[] = [
      { path: 'docs/a/b/c.md', added_ranges: [[1, 2]] },
    ];
    const [kept, skipped] = filterSkipped(units, ['docs/**']);
    expect(kept).toEqual([]);
    expect(skipped.map((u) => u.path)).toEqual(['docs/a/b/c.md']);
  });
});

// ---------------------------------------------------------------------------
// findReexportOnly
// ---------------------------------------------------------------------------

function diffFor(path: string, added: string): string {
  // Mirror Python `added.splitlines()` — split on \n and drop the trailing
  // empty element a final newline produces.
  const bodyLines = added.split('\n');
  if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop();
  }
  const plus = bodyLines.map((line) => '+' + line).join('\n');
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 1111111..2222222 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${bodyLines.length} @@\n` +
    `${plus}\n`
  );
}

describe('findReexportOnly', () => {
  it('TS re-export barrel detected', () => {
    const diff = diffFor(
      'pkg/index.ts',
      "export { foo } from './foo';\nexport * from './bar';\n",
    );
    expect(findReexportOnly(diff)).toEqual(new Set(['pkg/index.ts']));
  });

  it('TS local re-export and default', () => {
    const diff = diffFor(
      'pkg/index.ts',
      "import { foo } from './foo';\nexport { foo };\nexport default foo;\n",
    );
    expect(findReexportOnly(diff)).toEqual(new Set(['pkg/index.ts']));
  });

  it('real declaration disqualifies', () => {
    const diff = diffFor(
      'pkg/thing.ts',
      'export function thing() { return 1 }\n',
    );
    expect(findReexportOnly(diff)).toEqual(new Set());
  });

  it('export const with value disqualifies', () => {
    const diff = diffFor(
      'pkg/mix.ts',
      "export * from './bar';\nexport const X = 5;\n",
    );
    expect(findReexportOnly(diff)).toEqual(new Set());
  });

  it('python __init__ re-export barrel', () => {
    const diff = diffFor('pkg/__init__.py', 'from .x import Y\nimport os\n');
    expect(findReexportOnly(diff)).toEqual(new Set(['pkg/__init__.py']));
  });

  it('python __all__ list barrel', () => {
    const diff = diffFor(
      'pkg/__init__.py',
      'from .x import Y\n__all__ = [\n    "Y",\n]\n',
    );
    expect(findReexportOnly(diff)).toEqual(new Set(['pkg/__init__.py']));
  });

  it('python def disqualifies', () => {
    const diff = diffFor(
      'pkg/mod.py',
      'from .x import Y\ndef run():\n    return Y\n',
    );
    expect(findReexportOnly(diff)).toEqual(new Set());
  });

  it('comments and blanks are neutral', () => {
    const diff = diffFor(
      'pkg/index.ts',
      "// barrel\n\nexport * from './bar';\n",
    );
    expect(findReexportOnly(diff)).toEqual(new Set(['pkg/index.ts']));
  });

  it('only comments is not a barrel', () => {
    const diff = diffFor('pkg/index.ts', '// just a comment\n');
    expect(findReexportOnly(diff)).toEqual(new Set());
  });
});

describe('plain unified diff without diff --git separators', () => {
  it('attributes each file its own added lines once a hunk is spent', () => {
    const diff = [
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,0 +1,1 @@',
      '+const a = 1;',
      '--- a/y.ts',
      '+++ b/y.ts',
      '@@ -4,0 +5,1 @@',
      '+const b = 2;',
    ].join('\n');
    expect(scopeDiff(diff)).toEqual([
      { path: 'x.ts', added_ranges: [[1, 1]] },
      { path: 'y.ts', added_ranges: [[5, 5]] },
    ]);
  });
});

describe('dynamic import is not a barrel', () => {
  it('does not flag a file whose only added line calls import()', () => {
    const diff = [
      'diff --git a/src/boot.ts b/src/boot.ts',
      '--- a/src/boot.ts',
      '+++ b/src/boot.ts',
      '@@ -0,0 +1,1 @@',
      "+import('./app').then((m) => m.start());",
    ].join('\n');
    expect(findReexportOnly(diff)).toEqual(new Set());
  });

  it('does not flag a file whose only added line reads import.meta', () => {
    const diff = [
      'diff --git a/src/env.ts b/src/env.ts',
      '--- a/src/env.ts',
      '+++ b/src/env.ts',
      '@@ -0,0 +1,1 @@',
      '+import.meta.env.DEV && enableDebug();',
    ].join('\n');
    expect(findReexportOnly(diff)).toEqual(new Set());
  });
});

describe('reason-less allow-untested pragma', () => {
  it('does not suppress, so the hard gate still fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-blank-reason-'));
    try {
      writeFileSync(
        join(root, 'a.ts'),
        'export const x = 1; // canary:allow-untested   \n',
      );
      const finding = new GuardianFinding({
        path: 'a.ts',
        unit: 'a.ts',
        severity: Severity.HIGH,
        added_ranges: [[1, 1]],
      });
      applySuppressions([finding], root);
      expect(finding.suppressed).toBe(false);
      expect(computeExitCode([finding], 'hard')).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Branch coverage (test-fleet): git path quoting edge cases
// ---------------------------------------------------------------------------

/** A one-file diff whose `+++` header is exactly `header`. */
function diffWithHeader(header: string): string {
  return (
    'diff --git a/x b/x\n' +
    'index 1111111..2222222 100644\n' +
    '--- a/x\n' +
    `+++ ${header}\n` +
    '@@ -1 +1,2 @@\n' +
    ' a\n' +
    '+b\n'
  );
}

describe('scopeDiff path header decoding', () => {
  it('decodes a single-character C escape (\\t) inside a quoted path', () => {
    // git quotes a path holding a control byte and emits `\t` for a tab.
    const paths = scopeDiff(diffWithHeader('"b/tab\\there.ts"')).map(
      (u) => u.path,
    );
    expect(paths).toEqual(['tab\there.ts']);
  });

  it('leaves a quoted path with an unknown escape verbatim', () => {
    // `\q` is not an escape git emits; the documented contract is "leave the
    // value alone" rather than guess, so the quotes and prefix survive.
    const paths = scopeDiff(diffWithHeader('"b/x\\qy.ts"')).map((u) => u.path);
    expect(paths).toEqual(['"b/x\\qy.ts"']);
  });

  it('leaves a quoted path ending in a lone backslash verbatim', () => {
    const paths = scopeDiff(diffWithHeader('"b/x\\"')).map((u) => u.path);
    expect(paths).toEqual(['"b/x\\"']);
  });

  it('keeps an unprefixed (--no-prefix) path as written', () => {
    const paths = scopeDiff(diffWithHeader('src/app.ts')).map((u) => u.path);
    expect(paths).toEqual(['src/app.ts']);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage (test-fleet): barrel detection edge cases
// ---------------------------------------------------------------------------

describe('findReexportOnly edge cases', () => {
  it('a call inside a multi-line __all__ list disqualifies the barrel', () => {
    const diff = diffFor(
      'pkg/__init__.py',
      'from .x import Y\n__all__ = [\n    "Y",\n    make_name(),\n]\n',
    );
    expect(findReexportOnly(diff)).toEqual(new Set());
  });

  it('a comment inside a multi-line __all__ list stays neutral', () => {
    const diff = diffFor(
      'pkg/__init__.py',
      'from .x import Y\n__all__ = [\n    # public API\n    "Y",\n]\n',
    );
    expect(findReexportOnly(diff)).toEqual(new Set(['pkg/__init__.py']));
  });

  it('a block-comment tail line without a leading `*` is not neutral', () => {
    // Conservative contract: when unsure, NOT a barrel (a false flag beats a
    // false skip). `for the package */` has no comment leader, so it counts
    // as content and the file is flagged.
    const diff = diffFor(
      'pkg/index.ts',
      "/* re-exports\n   for the package */\nexport * from './a';\n",
    );
    expect(findReexportOnly(diff)).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// Branch coverage (test-fleet): `?` glob
// ---------------------------------------------------------------------------

describe('filterSkipped `?` glob', () => {
  it('matches exactly one non-slash character', () => {
    const units: ChangedUnit[] = ['src/a.ts', 'src/ab.ts', 'src/x/a.ts'].map(
      (path) => ({ path, added_ranges: [[1, 1]] }),
    );
    const [kept, skipped] = filterSkipped(units, ['src/?.ts']);
    expect(skipped.map((u) => u.path)).toEqual(['src/a.ts']);
    expect(kept.map((u) => u.path)).toEqual(['src/ab.ts', 'src/x/a.ts']);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage (test-fleet): buildFindings unit + suggestion shapes
// ---------------------------------------------------------------------------

describe('buildFindings suggestion and unit shapes', () => {
  function heuristicSuggestion(path: string): string {
    return buildFindings([result(false, Fidelity.Heuristic, path)])[0]!
      .suggestion;
  }

  it('heuristic suggestion names the stem before the first dot', () => {
    expect(heuristicSuggestion('src/widget.helper.ts')).toContain(
      'no test file mentions `widget`',
    );
  });

  it('heuristic suggestion keeps an extensionless basename whole', () => {
    expect(heuristicSuggestion('tools/Makefile')).toContain(
      'no test file mentions `Makefile`',
    );
  });

  it('heuristic suggestion keeps a dotfile basename whole', () => {
    expect(heuristicSuggestion('cfg/.eslintrc')).toContain(
      'no test file mentions `.eslintrc`',
    );
  });

  it('a unit symbol becomes the finding unit and the graph suggestion target', () => {
    const [f] = buildFindings([
      {
        unit: {
          path: 'pkg/parse.ts',
          symbol: 'parseThing',
          added_ranges: [[1, 2]],
        },
        covered: false,
        fidelity: Fidelity.GraphVerified,
        evidence: 'no caller reaches parseThing',
        uncovered_lines: [],
      },
    ]);
    expect(f!.unit).toBe('parseThing');
    expect(f!.suggestion).toBe(
      'add a test that calls `parseThing`, directly or through a caller.',
    );
  });

  it('a coverage-verified record with no uncovered_lines field grades HIGH', () => {
    // An absent line list means "the tier could not say", never "few lines
    // unhit" (ADR 0010) — so it escalates rather than grading MEDIUM.
    const record = {
      ...result(false, Fidelity.CoverageVerified),
      uncovered_lines: undefined,
    } as unknown as CoverageResult;
    const [f] = buildFindings([record]);
    expect(f!.severity).toBe(Severity.HIGH);
    expect(f!.uncovered_lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage (test-fleet): suppression scan bounds
// ---------------------------------------------------------------------------

describe('applySuppressions range bounds', () => {
  it('ignores added ranges that fall past the end of the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-oob-'));
    try {
      writeFileSync(
        join(root, 'a.ts'),
        'export const x = 1; // canary:allow-untested legacy\n',
      );
      const finding = new GuardianFinding({
        path: 'a.ts',
        unit: 'a.ts',
        severity: Severity.HIGH,
        // Line 1 carries the pragma but is outside the added range; lines 5-7
        // do not exist, so nothing is scanned and nothing is suppressed.
        added_ranges: [[5, 7]],
      });
      applySuppressions([finding], root);
      expect(finding.suppressed).toBe(false);
      expect(computeExitCode([finding], 'hard')).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Branch coverage (test-fleet): isCoverageAbstention guards
// ---------------------------------------------------------------------------

function coverageState(
  overrides: Partial<CoverageInputState> = {},
): CoverageInputState {
  return {
    requested: 'coverage/lcov.info',
    found: true,
    parsed: true,
    filesInReport: 1,
    unitsMatched: 1,
    unitsTotal: 1,
    ...overrides,
  };
}

describe('isCoverageAbstention guards', () => {
  const heuristicOnly = [finding({ fidelity: Fidelity.Heuristic })];
  const blind = coverageState({
    requested: null,
    found: false,
    parsed: false,
    filesInReport: 0,
    unitsMatched: 0,
    unitsTotal: 2,
  });

  it('is an abstention when coverage is unavailable and every finding is heuristic', () => {
    expect(isCoverageAbstention(blind, heuristicOnly)).toBe(true);
  });

  it('is not an abstention when no coverage state exists', () => {
    expect(isCoverageAbstention(null, heuristicOnly)).toBe(false);
  });

  it('is not an abstention when the ladder judged zero units', () => {
    expect(
      isCoverageAbstention({ ...blind, unitsTotal: 0 }, heuristicOnly),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage (test-fleet): renderFindings surfaces
// ---------------------------------------------------------------------------

describe('renderFindings abstention, exemption and suppression surfaces', () => {
  it('abstained comment with findings headlines the abstention, not a count', () => {
    const out = renderFindings(
      [finding({ fidelity: Fidelity.Heuristic })],
      'comment',
      0,
      null,
      { checked: 2, abstained: true },
    );
    expect(out).toContain(
      'abstained: no coverage data (2 files judged heuristically)',
    );
    expect(out).toContain('nothing below is a coverage verdict');
    expect(out).not.toContain('needs test coverage');
  });

  it('abstained comment with no active findings still headlines the abstention', () => {
    const out = renderFindings([], 'comment', 0, null, {
      checked: 1,
      abstained: true,
    });
    expect(out).toContain(
      'abstained: no coverage data (1 file judged heuristically)',
    );
    expect(out).not.toContain('no test-coverage gaps');
  });

  it('abstained text surface opens with the plain-text abstention line', () => {
    const out = renderFindings([finding()], 'text', 0, null, {
      checked: 3,
      abstained: true,
    });
    expect(out.split('\n')[0]).toBe(
      'Canary PR Guardian — abstained: no coverage data (3 files judged heuristically)',
    );
  });

  it('discloses coverage-exempt units on the findings path', () => {
    const out = renderFindings([finding()], 'comment', 0, null, {
      checked: 1,
      abstained: false,
      coverage: coverageState({
        unitsExempt: 2,
        exemptGlobs: ['vendor/**', 'legacy/**'],
      }),
    });
    expect(out).toContain(
      '_2 files skipped as coverage-exempt (vendor/**, legacy/**); judged at graph/heuristic tier only._',
    );
  });

  it('counts suppressed findings under the table when others are still active', () => {
    const out = renderFindings(
      [
        finding({ path: 'a.py' }),
        finding({ path: 'b.py', suppressed: true, suppression_reason: 'x' }),
      ],
      'comment',
    );
    expect(out).toContain('1 file needs test coverage');
    expect(out).toContain(
      '<sub>1 finding(s) suppressed as intentional and not counted above.</sub>',
    );
  });

  it('text surface marks a suppressed finding inline', () => {
    const out = renderFindings([finding({ suppressed: true })], 'text');
    expect(out).toContain(
      '[high] pkg/foo.py → foo — no test reaches foo (graph-verified) (suppressed)',
    );
  });

  it('links to the bare file when a finding has no line ranges', () => {
    const base = 'https://example.com/acme/repo/blob/abc123';
    const out = renderFindings(
      [finding({ unit: 'pkg/foo.py' })],
      'comment',
      0,
      null,
      null,
      base,
    );
    expect(out).toContain(`[\`pkg/foo.py\`](${base}/pkg/foo.py)`);
    expect(out).not.toContain(`${base}/pkg/foo.py#L`);
  });

  it('renders an empty instrumented-tree root as `.` in the scope-gap headline', () => {
    const out = renderFindings([], 'comment', 0, null, {
      checked: 2,
      abstained: false,
      coverage: coverageState({
        unitsTotal: 2,
        unitsEligible: 0,
        instrumentedTrees: ['', 'pkg'],
      }),
    });
    expect(out).toContain(
      'not coverage-checked: 1 file outside instrumented trees (., pkg)',
    );
  });

  it('a clean run over an unparsed report says coverage was unavailable', () => {
    const out = renderFindings([], 'comment', 0, null, {
      checked: 1,
      abstained: false,
      coverage: coverageState({
        requested: null,
        found: false,
        parsed: false,
        filesInReport: 0,
        unitsMatched: 0,
      }),
    });
    expect(out).toContain('no gaps found, but coverage was unavailable');
  });
});
