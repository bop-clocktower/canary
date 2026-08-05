/**
 * The sticky PR comment must tell a developer what to DO, not just that
 * something is wrong.
 *
 * Three pieces of information were computed and then discarded before they
 * reached the comment:
 *
 *  1. **Which lines are uncovered.** `resolveCoverage` computes
 *     `CoverageResult.uncovered_lines`, but `buildFindings` constructed a
 *     `Finding` without that field, so the comment could only say
 *     "12 uncovered" out of a 19-line range. The reader had to re-run coverage
 *     locally to learn which 12.
 *  2. **A suggested next action.** `Finding.suggestion` existed, was
 *     JSON-serialized, and was rendered by the local CLI — but nothing ever
 *     populated it, so it was permanently `''`. A field that is present in the
 *     schema and empty in every record reads as alive and is dead.
 *  3. **A link to the code.** The file cell was plain code text, so the reader
 *     copy-pasted a path instead of clicking to the line.
 *
 * Degradation is part of the contract: when the repo/SHA cannot be resolved
 * there must be NO link rather than a dead one, and a tier that genuinely has
 * no line-level data must not render empty parentheses.
 */

import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { activeFindingPaths } from '../src/guardian/adjudication.js';
import { blobBaseFromEnv } from '../src/guardian/cli.js';
import {
  ChangedUnit,
  CoverageResult,
  Fidelity,
} from '../src/guardian/coverage.js';
import { Severity } from '../src/guardian/impact-mapper.js';
import {
  buildFindings,
  buildWeakTestFindings,
  Finding,
  render,
} from '../src/guardian/pr-check.js';

function unit(
  path: string,
  ranges: [number, number][] = [[40, 58]],
): ChangedUnit {
  return { path, added_ranges: ranges };
}

function result(over: Partial<CoverageResult> = {}): CoverageResult {
  return {
    unit: unit('src/pay.ts'),
    covered: false,
    fidelity: Fidelity.CoverageVerified,
    evidence: 'lines 40-58: 12 uncovered',
    uncovered_lines: [44, 45, 46, 47, 48, 49, 52, 53, 54, 55, 56, 58],
    ...over,
  } as CoverageResult;
}

// ---------------------------------------------------------------------------
// 1. Which lines are uncovered
// ---------------------------------------------------------------------------

describe('uncovered line numbers survive to the comment', () => {
  it('buildFindings carries uncovered_lines off the CoverageResult', () => {
    const [finding] = buildFindings([result()]);
    expect(finding!.uncovered_lines).toEqual([
      44, 45, 46, 47, 48, 49, 52, 53, 54, 55, 56, 58,
    ]);
  });

  it('comment names the uncovered ranges, not just a count', () => {
    const out = render(buildFindings([result()]), 'comment');
    // Collapsed into inclusive ranges so a 12-line list stays one short cell.
    expect(out).toContain('44-49');
    expect(out).toContain('52-56');
    expect(out).toContain('58');
  });

  it('a tier with no line-level data renders no empty parentheses', () => {
    const findings = buildFindings([
      result({
        fidelity: Fidelity.GraphVerified,
        evidence: 'no test node reaches src/pay.ts via calls/imports',
        uncovered_lines: [],
      }),
    ]);
    const out = render(findings, 'comment');
    expect(out).not.toContain('()');
    expect(out).not.toContain('uncovered: |');
  });

  it('a huge uncovered list is truncated so one finding cannot eat the budget', () => {
    const many = Array.from({ length: 400 }, (_, i) => i * 2 + 1); // 400 lone ranges
    const out = render(
      buildFindings([result({ uncovered_lines: many })]),
      'comment',
    );
    expect(out).toContain('more');
    // The cell must stay far short of the whole list.
    const row = out.split('\n').find((l) => l.includes('src/pay.ts'))!;
    expect(row.length).toBeLessThan(400);
  });

  it('json carries the structured uncovered_lines for downstream tooling', () => {
    const data = JSON.parse(render(buildFindings([result()]), 'json'));
    expect(data.findings[0].uncovered_lines).toEqual([
      44, 45, 46, 47, 48, 49, 52, 53, 54, 55, 56, 58,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. A suggested next action
// ---------------------------------------------------------------------------

describe('suggestion is populated and rendered', () => {
  it('coverage-verified findings suggest exercising the named lines', () => {
    const [finding] = buildFindings([result()]);
    expect(finding!.suggestion).not.toBe('');
    expect(finding!.suggestion).toContain('44-49');
  });

  it('graph-verified findings suggest calling the uncovered symbol', () => {
    const [finding] = buildFindings([
      result({
        unit: {
          path: 'src/pay.ts',
          symbol: 'refund',
          added_ranges: [[40, 58]],
        },
        fidelity: Fidelity.GraphVerified,
        uncovered_lines: [],
      } as Partial<CoverageResult>),
    ]);
    expect(finding!.suggestion).toContain('refund');
  });

  it('heuristic findings say what would make a test file match', () => {
    const [finding] = buildFindings([
      result({ fidelity: Fidelity.Heuristic, uncovered_lines: [] }),
    ]);
    expect(finding!.suggestion.toLowerCase()).toContain('pay');
  });

  it('weak-test findings suggest adding an assertion', () => {
    const diff = `diff --git a/test/widget.test.ts b/test/widget.test.ts
--- /dev/null
+++ b/test/widget.test.ts
@@ -0,0 +1,3 @@
+it('does a thing', () => {
+  const widget = build();
+});
`;
    const findings = buildWeakTestFindings(
      [unit('test/widget.test.ts', [[1, 3]])],
      diff,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.suggestion.toLowerCase()).toContain('assert');
  });

  it('the comment renders the suggestion alongside the evidence', () => {
    const out = render(buildFindings([result()]), 'comment');
    // Rendered as a distinct call-to-action, not silently folded into evidence.
    expect(out).toContain('extend a test to execute');
    expect(out).toContain('<br>');
  });

  it('an empty suggestion adds no dangling arrow', () => {
    const out = render(
      [
        new Finding({
          path: 'src/pay.ts',
          unit: 'src/pay.ts',
          evidence: 'something',
          suggestion: '',
        }),
      ],
      'comment',
    );
    expect(out).not.toContain('<br>→ </sub>');
    expect(out).not.toContain('→ |');
  });
});

// ---------------------------------------------------------------------------
// 3. Links to the code
// ---------------------------------------------------------------------------

describe('blobBaseFromEnv', () => {
  it('returns null with no GITHUB_REPOSITORY (no repo, no link)', () => {
    expect(blobBaseFromEnv({ GITHUB_SHA: 'abc123' })).toBeNull();
  });

  it('returns null when no SHA is resolvable', () => {
    expect(blobBaseFromEnv({ GITHUB_REPOSITORY: 'o/r' })).toBeNull();
  });

  it('prefers the PR head SHA from the event payload over GITHUB_SHA', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardian-evt-'));
    const eventPath = join(dir, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { head: { sha: 'headsha' } } }),
    );
    expect(
      blobBaseFromEnv({
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_SHA: 'mergesha',
        GITHUB_EVENT_PATH: eventPath,
      }),
    ).toBe('https://github.com/o/r/blob/headsha');
  });

  it('falls back to GITHUB_SHA when the event payload has no head sha', () => {
    expect(
      blobBaseFromEnv({ GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'mergesha' }),
    ).toBe('https://github.com/o/r/blob/mergesha');
  });

  it('does not throw on an unreadable event payload', () => {
    expect(
      blobBaseFromEnv({
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_SHA: 'mergesha',
        GITHUB_EVENT_PATH: '/nonexistent/event.json',
      }),
    ).toBe('https://github.com/o/r/blob/mergesha');
  });
});

describe('comment permalinks', () => {
  const base = 'https://github.com/o/r/blob/deadbeef';

  it('links the file to its first uncovered line range', () => {
    const out = render(
      buildFindings([result()]),
      'comment',
      0,
      null,
      null,
      base,
    );
    expect(out).toContain(`${base}/src/pay.ts#L44-L49`);
  });

  it('falls back to the added range when no line-level data exists', () => {
    const out = render(
      buildFindings([
        result({ fidelity: Fidelity.GraphVerified, uncovered_lines: [] }),
      ]),
      'comment',
      0,
      null,
      null,
      base,
    );
    expect(out).toContain(`${base}/src/pay.ts#L40-L58`);
  });

  it('uses a single-line anchor when only one line is uncovered', () => {
    const out = render(
      buildFindings([result({ uncovered_lines: [44] })]),
      'comment',
      0,
      null,
      null,
      base,
    );
    expect(out).toContain(`${base}/src/pay.ts#L44`);
    expect(out).not.toContain('#L44-L44');
  });

  it('percent-encodes parentheses so a route-group path is not a broken link', () => {
    // `app/(marketing)/page.tsx` — a Next.js route group. A bare `)` would
    // close the markdown link early and render the rest as literal text.
    const out = render(
      buildFindings([result({ unit: unit('app/(marketing)/page.tsx') })]),
      'comment',
      0,
      null,
      null,
      base,
    );
    expect(out).toContain(`${base}/app/%28marketing%29/page.tsx#L44-L49`);
    // The visible label keeps the readable form.
    expect(out).toContain('`app/(marketing)/page.tsx`');
    // The parser must still recover the real path from the linked row.
    expect(activeFindingPaths(out)).toEqual(['app/(marketing)/page.tsx']);
  });

  it('emits plain code text when no base is available (never a dead link)', () => {
    const out = render(buildFindings([result()]), 'comment');
    expect(out).not.toContain('https://github.com');
    expect(out).toContain('`src/pay.ts`');
  });

  it('keeps the unit arrow outside the link', () => {
    const out = render(
      buildFindings([
        result({
          unit: {
            path: 'src/pay.ts',
            symbol: 'refund',
            added_ranges: [[40, 58]],
          },
        } as Partial<CoverageResult>),
      ]),
      'comment',
      0,
      null,
      null,
      base,
    );
    expect(out).toContain('`refund`');
    expect(out).toContain(base);
  });

  it('text format never emits links or HTML', () => {
    const out = render(buildFindings([result()]), 'text', 0, null, null, base);
    expect(out).not.toContain('https://');
    expect(out).not.toContain('<br>');
  });
});

// ---------------------------------------------------------------------------
// The adjudication parser consumes render's output — they must not drift.
// ---------------------------------------------------------------------------

describe('activeFindingPaths survives the linked file cell', () => {
  // Fed from render's OWN output rather than a hand-written fixture: a fixture
  // would re-encode the very assumption under test (that the cell opens with a
  // backtick), so producer and consumer could drift apart again unnoticed.
  it('reads paths out of an unlinked body', () => {
    const body = render(buildFindings([result()]), 'comment');
    expect(activeFindingPaths(body)).toEqual(['src/pay.ts']);
  });

  it('reads paths out of a permalinked body', () => {
    const body = render(
      buildFindings([result()]),
      'comment',
      0,
      null,
      null,
      'https://github.com/o/r/blob/deadbeef',
    );
    // A silent [] here is the failure mode that matters: it would zero the
    // precision denominator instead of raising an error (#490, #508).
    expect(activeFindingPaths(body)).toEqual(['src/pay.ts']);
  });

  it('still ignores the header and separator rows when linked', () => {
    const body = render(
      buildFindings([
        result({ unit: unit('src/a.ts') }),
        result({ unit: unit('src/b.ts') }),
      ]),
      'comment',
      0,
      null,
      null,
      'https://github.com/o/r/blob/deadbeef',
    );
    expect(activeFindingPaths(body)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

// ---------------------------------------------------------------------------
// Regression guard: the size cap still holds with the richer cells.
// ---------------------------------------------------------------------------

describe('richer cells stay within the comment budget', () => {
  it('200 findings with lines, suggestions, and links stay under the cap', () => {
    const findings = buildFindings(
      Array.from({ length: 200 }, (_, i) =>
        result({ unit: unit(`src/mod-${i}/file-with-a-long-name.ts`) }),
      ),
    );
    const out = render(
      findings,
      'comment',
      0,
      null,
      null,
      'https://github.com/o/r/blob/deadbeef',
    );
    // The budget is the invariant; whether these particular 200 overflow it is
    // an artifact of the fixture, so asserting on the overflow note would be
    // testing the fixture rather than the cap (#457 owns the overflow path).
    expect(out.length).toBeLessThan(60_000);
  });
});
