# Plan: canary-mission-briefing skill + `--comment` surface (#593, PR 2+3 combined)

<!-- markdownlint-disable-file MD013 -->
<!-- Plan tasks quote exact code lines, which cannot wrap at 80 columns. -->

**Date:** 2026-09-16 | **Spec:** docs/changes/593-mission-briefing/proposal.md |
**Tasks:** 12 | **Time:** ~50 min | **Integration Tier:** medium

## Goal

`canary briefing` accepts skill-written judgment (mission, verify-by-hand items,
edge cases) and keeps only items citing a changed line, and `--comment` posts
the charter as its own sticky PR comment that never touches the guardian's. This
PR finishes the spec (criteria 6, 9, 10), so #593 can close.

## Observable Truths (Acceptance Criteria)

1. When `canary briefing --judgment j.json` is given valid judgment, the
   Markdown charter shall contain `**Mission:**`, `### Verify by hand` (a
   `- [ ]` item per kept verify entry, citing `` `path:line` ``) and
   `### Edge cases this diff invites` (one `####` group for each category that
   kept an item), placed after the header and before `### Existing tests`.
2. **(criterion 9, enforced in code)** If a verify or edge-case item has no
   cite, a cite that is not `path:line`, a path that is not a scoped unit, or a
   line outside that unit's `added_ranges`, then the charter shall not render it
   under Verify/Edge cases. It is listed under `### Out of this charter` with
   the reason.
3. If an edge-case `category` is not one of the six from
   `canary-edge-case-discovery` (Boundary values, Race conditions, Locale and
   timezone, Partial network, Unexpected input shapes, Accessibility), then the
   item is dropped with reason `unknown edge-case category`.
4. If the judgment file cannot be read or is not valid judgment JSON, then the
   command shall write `WARNING: judgment ignored: <reason>` to stderr, print
   the facts-only charter and exit 0 (never 1).
5. When `--judgment` and `--json` are both given, the JSON shall contain a
   `judgment` block `{ mission, verify, edge_cases, dropped }`, with
   `schema_version` still 1 (additive).
6. **(criterion 6)** When `--comment` runs in a PR context, the posted body
   shall start with `<!-- canary-mission-briefing -->`, and a comment whose body
   starts with `<!-- canary-pr-guardian -->` shall keep its body byte for byte
   (fake-client test with and without a guardian sticky). A second run updates
   the briefing comment instead of adding another one.
7. **(criterion 10)** If the comment write returns 403, the command shall print
   the charter to stdout, print a
   `::warning::canary briefing: token lacks write permission on PR comments (HTTP 403) — charter printed to stdout instead`
   line, and exit 0.
8. When `--comment` runs with no PR context, the command shall print the charter
   to stdout, plus a stderr note `no PR context; charter printed to stdout`, and
   exit 0.
9. When a comment post succeeds, stdout shall be one line:
   `Charter posted as a PR comment (created|updated, id N).`
10. `agents/skills/claude-code/canary-mission-briefing/SKILL.md` exists with the
    frontmatter `cli: canary briefing` and `requires: [node>=20]`, and
    `npx vitest run test/skill-` passes.
11. `docs/naming-registry.md` lists `canary-mission-briefing` as `shipped`;
    `agents/skills/README.md` and the guide list the skill and the new flags.
12. The four gates pass from `ts/`:
    `npm run build && npm run typecheck && npm run format:check && npm test`.
    `harness check-arch`, entropy and perf ratchets introduce no new violations
    (arch module-size growth is covered by an allowance file).

## Uncertainties

- [ASSUMPTION] Non-403 comment errors (for example a 401 from a missing
  `GITHUB_TOKEN`, or a network failure) get the same treatment as a 403: charter
  to stdout, `::warning::` with the error message, exit 0. Criterion 8 (never
  exit 1) outranks surfacing a crash. If wrong, Task 8 changes.
- [ASSUMPTION] Adding `judgment` to `--json` is additive, so `schema_version`
  stays 1.
- [ASSUMPTION] Risk order for verify items = the order of the cited unit in
  `facts.units` (which `assembleFacts` already sorts by `rank_score`,
  `facts.ts:85`), and the skill's order within a unit. No second ranking.
- [ASSUMPTION] With `--comment --json`, the comment body is still the Markdown
  charter. Stdout gets the JSON on degradation or no PR context, and the posted
  line on success.
- [ASSUMPTION] `ts/src/main-deps.ts` (composition layer) may import
  `guardian/pr-comment.js`; verified by `harness check-deps` in Task 7.
- [ASSUMPTION] The guide and spec call for a slash command. Commands in
  `agents/commands/claude-code/harness/` are generated
  (`harness generate-slash-commands`), and `canary-batwoman` ships without one.
  Task 10 writes the file in the same generated format as
  `canary-edge-case-discovery.md`.
- [DEFERRABLE] The spec's "skill eval checks citations" becomes a mechanical
  check in `applyJudgment` plus unit tests. No LLM eval harness is added.
- [DEFERRABLE] ADR for D1 (scopeDiff as a public seam) stays optional under the
  spec. No ADR in this plan.
- [DEFERRABLE] The exact arch module-size number is measured in Task 9, after
  the code lands.

## File Map

- CREATE ts/src/briefing/judgment.ts (types, `EDGE_CASE_CATEGORIES`,
  `parseJudgment`, `applyJudgment`)
- CREATE ts/test/briefing-judgment.test.ts
- CREATE ts/src/briefing/judgment-sections.ts (render sections 2-4 and the
  dropped lines)
- CREATE ts/test/briefing-judgment-sections.test.ts
- MODIFY ts/src/briefing/charter.ts (`renderCharter(facts, judgment?)`)
- CREATE ts/src/briefing/comment.ts (`BRIEFING_MARKER`, `postCharter`)
- CREATE ts/test/briefing-comment.test.ts
- MODIFY ts/src/main-deps.ts (`buildCommentClient`)
- MODIFY ts/src/briefing/briefing-cli.ts (`--judgment`, `--comment`)
- MODIFY ts/test/briefing-cli.test.ts
- MODIFY harness.config.json (both entryPoints arrays)
- CREATE .harness/arch/allowances/feat-593-briefing-skill-comment.json
- CREATE agents/skills/claude-code/canary-mission-briefing/SKILL.md
- CREATE agents/skills/claude-code/canary-mission-briefing/skill.yaml
- CREATE agents/commands/claude-code/harness/canary-mission-briefing.md
- MODIFY agents/skills/README.md
- MODIFY docs/naming-registry.md
- MODIFY AGENTS.md
- MODIFY docs/guides/mission-briefing.md
- MODIFY agents/skills/claude-code/canary-pr-guardian/SKILL.md

## Skeleton

1. Judgment core: parse, cite validation, rendering (~4 tasks, ~18 min)
2. CLI `--judgment` wiring (~1 task, ~5 min)
3. Comment surface: poster, deps seam, CLI wiring (~3 tasks, ~13 min)
4. Ratchets (~1 task, ~5 min)
5. Skill, registries, docs (~3 tasks, ~10 min)

**Estimated total:** 12 tasks, ~50 min. _Skeleton approved: the orchestrator
fixed the design direction in its brief. No human approved the skeleton itself._

## Tasks

All test commands run from `ts/`. "Gates" means
`npm run build && npm run typecheck && npm run format:check && npm test`. Do not
commit in any task (the orchestrator commits). Each task ends with
`harness validate` from the worktree root. Run `npx prettier --write` on every
touched `.ts`/`.md`/`.json` file before running the gates.

### Task 1: Judgment types and `parseJudgment`

**Depends on:** none | **Files:** ts/src/briefing/judgment.ts,
ts/test/briefing-judgment.test.ts

1. Create `ts/test/briefing-judgment.test.ts`:

   ```ts
   import { describe, expect, it } from 'vitest';
   import { parseJudgment } from '../src/briefing/judgment.js';

   describe('parseJudgment', () => {
     it('accepts the skill contract shape', () => {
       const j = parseJudgment(
         JSON.stringify({
           mission: 'Explore the discount.',
           verify: [{ text: 'Apply 10%', cite: 'src/discount.ts:2' }],
           edge_cases: [
             {
               category: 'Boundary values',
               text: '0% and 100%',
               cite: 'src/discount.ts:2',
             },
           ],
         }),
       );
       expect(typeof j).toBe('object');
     });
     it('returns a reason string for non-JSON', () => {
       expect(parseJudgment('{nope')).toMatch(/not valid JSON/);
     });
     it('returns a reason string when mission is missing or not a string', () => {
       expect(parseJudgment('{"verify":[],"edge_cases":[]}')).toMatch(
         /mission/,
       );
     });
     it('returns a reason string when verify or edge_cases is not an array', () => {
       expect(
         parseJudgment('{"mission":"m","verify":{},"edge_cases":[]}'),
       ).toMatch(/verify/);
     });
     it('defaults absent arrays to empty', () => {
       const j = parseJudgment('{"mission":"m"}');
       expect(j).toEqual({ mission: 'm', verify: [], edge_cases: [] });
     });
   });
   ```

2. Run `npx vitest run test/briefing-judgment.test.ts` and confirm it fails (the
   module is missing).
3. Create `ts/src/briefing/judgment.ts`:

   ```ts
   /**
    * Judgment half of the mission-briefing charter (#593, criterion 9).
    *
    * The skill writes judgment; this module decides what of it the charter may
    * carry. An item that does not cite a changed line is dropped, not trusted,
    * so "every item cites a line inside the added ranges" is enforced by code
    * rather than hoped for from a prompt.
    */
   import type { BriefingUnit } from './facts.js';

   /** The six categories named by canary-edge-case-discovery's SKILL.md. */
   export const EDGE_CASE_CATEGORIES = [
     'Boundary values',
     'Race conditions',
     'Locale and timezone',
     'Partial network',
     'Unexpected input shapes',
     'Accessibility',
   ] as const;

   export interface RawItem {
     text?: unknown;
     cite?: unknown;
     category?: unknown;
   }
   export interface Judgment {
     mission: string;
     verify: RawItem[];
     edge_cases: RawItem[];
   }

   function arrayField(
     o: Record<string, unknown>,
     key: string,
   ): RawItem[] | string {
     const v = o[key];
     if (v === undefined) return [];
     return Array.isArray(v) ? (v as RawItem[]) : `'${key}' is not an array`;
   }

   /** Parse skill-written judgment JSON; a string return is the reason it was rejected. */
   export function parseJudgment(raw: string): Judgment | string {
     let data: unknown;
     try {
       data = JSON.parse(raw);
     } catch {
       return 'judgment is not valid JSON';
     }
     if (typeof data !== 'object' || data === null || Array.isArray(data)) {
       return 'judgment is not a JSON object';
     }
     const o = data as Record<string, unknown>;
     if (typeof o['mission'] !== 'string')
       return "'mission' is missing or not a string";
     const verify = arrayField(o, 'verify');
     if (typeof verify === 'string') return verify;
     const edge = arrayField(o, 'edge_cases');
     if (typeof edge === 'string') return edge;
     return { mission: o['mission'], verify, edge_cases: edge };
   }
   ```

4. Run the test again and confirm it passes. Run `harness validate`.

### Task 2: `applyJudgment` validates citations against added ranges

**Depends on:** Task 1 | **Files:** ts/src/briefing/judgment.ts,
ts/test/briefing-judgment.test.ts

1. Append these tests (import `applyJudgment` and the `BriefingUnit` type):

   ```ts
   const units: BriefingUnit[] = [
     {
       path: 'src/b.ts',
       added_ranges: [[10, 12]],
       coverage: 'unknown',
       execution_evidence: null,
       imported_by: null,
       uncovered_lines: [],
     },
     {
       path: 'src/a.ts',
       added_ranges: [[1, 3]],
       coverage: 'unknown',
       execution_evidence: null,
       imported_by: null,
       uncovered_lines: [],
     },
   ];
   const judge = (verify: RawItem[], edge_cases: RawItem[] = []) =>
     applyJudgment({ mission: 'm', verify, edge_cases }, units);

   describe('applyJudgment (criterion 9)', () => {
     it('keeps an item citing a line inside an added range', () => {
       expect(judge([{ text: 't', cite: 'src/a.ts:3' }]).verify).toEqual([
         { text: 't', cite: 'src/a.ts:3' },
       ]);
     });
     it.each([
       [{ text: 't' }, 'no citation'],
       [{ text: 't', cite: 'src/a.ts' }, 'citation is not path:line'],
       [{ text: 't', cite: 'src/a.ts:0' }, 'citation is not path:line'],
       [
         { text: 't', cite: 'src/zzz.ts:1' },
         'cites a file outside this charter',
       ],
       [
         { text: 't', cite: 'src/a.ts:4' },
         'cites a line outside the added ranges',
       ],
       [{ cite: 'src/a.ts:1' }, 'no text'],
     ])('drops %j with reason %s', (item, reason) => {
       const r = judge([item]);
       expect(r.verify).toEqual([]);
       expect(r.dropped[0]).toMatchObject({ section: 'verify', reason });
     });
     it('drops an edge case with an unknown category', () => {
       const r = judge(
         [],
         [{ category: 'Vibes', text: 't', cite: 'src/a.ts:1' }],
       );
       expect(r.edge_cases).toEqual([]);
       expect(r.dropped[0]!.reason).toBe('unknown edge-case category');
     });
     it('orders verify items by the unit order in facts (risk order), stably', () => {
       const r = judge([
         { text: 'a1', cite: 'src/a.ts:1' },
         { text: 'b1', cite: 'src/b.ts:10' },
         { text: 'a2', cite: 'src/a.ts:2' },
       ]);
       expect(r.verify.map((v) => v.text)).toEqual(['b1', 'a1', 'a2']);
     });
   });
   ```

2. Run `npx vitest run test/briefing-judgment.test.ts` and confirm the new tests
   fail.
3. Append to `judgment.ts`:

   ```ts
   export type EdgeCaseCategory = (typeof EDGE_CASE_CATEGORIES)[number];
   export interface VerifyItem {
     text: string;
     cite: string;
   }
   export interface EdgeCaseItem extends VerifyItem {
     category: EdgeCaseCategory;
   }
   export interface DroppedItem {
     section: 'verify' | 'edge_cases';
     text: string;
     cite: string | null;
     reason: string;
   }
   export interface JudgmentResult {
     mission: string;
     verify: VerifyItem[];
     edge_cases: EdgeCaseItem[];
     dropped: DroppedItem[];
   }

   /** Why a cite is unusable for `units`, or null when it lands on an added line. */
   export function citeProblem(
     cite: unknown,
     units: BriefingUnit[],
   ): string | null {
     if (typeof cite !== 'string' || cite.trim() === '') return 'no citation';
     const m = /^(.+):([1-9]\d*)$/.exec(cite.trim());
     if (m === null) return 'citation is not path:line';
     const unit = units.find((u) => u.path === m[1]);
     if (unit === undefined) return 'cites a file outside this charter';
     const line = Number(m[2]);
     const inside = unit.added_ranges.some(([s, e]) => line >= s && line <= e);
     return inside ? null : 'cites a line outside the added ranges';
   }

   function itemProblem(item: RawItem, units: BriefingUnit[]): string | null {
     if (typeof item.text !== 'string' || item.text.trim() === '')
       return 'no text';
     return citeProblem(item.cite, units);
   }

   function dropped(
     section: DroppedItem['section'],
     item: RawItem,
     reason: string,
   ): DroppedItem {
     return {
       section,
       text: typeof item.text === 'string' ? item.text : '',
       cite: typeof item.cite === 'string' ? item.cite : null,
       reason,
     };
   }

   function unitRank(cite: string, units: BriefingUnit[]): number {
     return units.findIndex((u) => cite.startsWith(`${u.path}:`));
   }

   function isCategory(c: unknown): c is EdgeCaseCategory {
     return (EDGE_CASE_CATEGORIES as readonly unknown[]).includes(c);
   }

   /** Keep only items citing a changed line; everything else is dropped with a reason. */
   export function applyJudgment(
     j: Judgment,
     units: BriefingUnit[],
   ): JudgmentResult {
     const result: JudgmentResult = {
       mission: j.mission.trim(),
       verify: [],
       edge_cases: [],
       dropped: [],
     };
     for (const item of j.verify) {
       const problem = itemProblem(item, units);
       if (problem !== null)
         result.dropped.push(dropped('verify', item, problem));
       else
         result.verify.push({
           text: item.text as string,
           cite: (item.cite as string).trim(),
         });
     }
     for (const item of j.edge_cases) {
       const problem = isCategory(item.category)
         ? itemProblem(item, units)
         : 'unknown edge-case category';
       if (problem !== null)
         result.dropped.push(dropped('edge_cases', item, problem));
       else
         result.edge_cases.push({
           category: item.category as EdgeCaseCategory,
           text: item.text as string,
           cite: (item.cite as string).trim(),
         });
     }
     result.verify.sort(
       (a, b) => unitRank(a.cite, units) - unitRank(b.cite, units),
     );
     return result;
   }
   ```

   (`Array.prototype.sort` is stable in Node >= 12, so the skill's order holds
   within a unit. If `citeProblem`'s regex trips a perf finding, move it into a
   module constant.)

4. Run the test again and confirm it passes. Run `harness validate`.

### Task 3: Render judgment sections 2-4 and the dropped lines

**Depends on:** Task 2 | **Files:** ts/src/briefing/judgment-sections.ts,
ts/test/briefing-judgment-sections.test.ts

1. Create `ts/test/briefing-judgment-sections.test.ts`:

   ```ts
   import { describe, expect, it } from 'vitest';
   import {
     droppedLines,
     judgmentLines,
   } from '../src/briefing/judgment-sections.js';

   const result = {
     mission: 'Explore the discount.',
     verify: [{ text: 'Apply 10%', cite: 'src/a.ts:2' }],
     edge_cases: [
       {
         category: 'Boundary values' as const,
         text: '100%',
         cite: 'src/a.ts:2',
       },
     ],
     dropped: [
       {
         section: 'verify' as const,
         text: 'Vague',
         cite: null,
         reason: 'no citation',
       },
     ],
   };

   describe('judgment sections', () => {
     it('renders mission, a verify checklist and grouped edge cases in order', () => {
       const md = judgmentLines(result).join('\n');
       expect(md).toContain('**Mission:** Explore the discount.');
       expect(md).toContain('- [ ] Apply 10% (`src/a.ts:2`)');
       expect(md).toContain('#### Boundary values');
       expect(md).not.toContain('#### Race conditions');
       expect(md.indexOf('### Verify by hand')).toBeLessThan(
         md.indexOf('### Edge cases this diff invites'),
       );
     });
     it('states an empty section instead of printing a bare heading', () => {
       const md = judgmentLines({ ...result, verify: [], edge_cases: [] }).join(
         '\n',
       );
       expect(md).toContain('No verify item cited a changed line.');
       expect(md).toContain('No edge case cited a changed line.');
     });
     it('lists dropped items with their reason', () => {
       expect(droppedLines(result.dropped)).toContain(
         '- Dropped verify item "Vague" — no citation',
       );
     });
     it('uses no status emoji and no pass/fail words (criterion 7)', () => {
       const md = judgmentLines(result).join('\n');
       expect(md).not.toMatch(
         /\bpass(ed)?\b|\bfail(ed)?\b|[\u{2705}\u{274C}]/iu,
       );
     });
   });
   ```

2. Run `npx vitest run test/briefing-judgment-sections.test.ts` and confirm it
   fails.
3. Create `ts/src/briefing/judgment-sections.ts`:

   ```ts
   /** Markdown for charter sections 2-4 and the dropped-judgment lines (#593). */
   import {
     EDGE_CASE_CATEGORIES,
     type DroppedItem,
     type JudgmentResult,
   } from './judgment.js';

   function verifyLines(r: JudgmentResult): string[] {
     const lines = ['### Verify by hand', ''];
     if (r.verify.length === 0)
       return [...lines, 'No verify item cited a changed line.'];
     return [
       ...lines,
       ...r.verify.map((v) => `- [ ] ${v.text} (\`${v.cite}\`)`),
     ];
   }

   function edgeCaseLines(r: JudgmentResult): string[] {
     const lines = ['### Edge cases this diff invites', ''];
     if (r.edge_cases.length === 0)
       return [...lines, 'No edge case cited a changed line.'];
     for (const category of EDGE_CASE_CATEGORIES) {
       const items = r.edge_cases.filter((e) => e.category === category);
       if (items.length === 0) continue;
       lines.push(
         `#### ${category}`,
         '',
         ...items.map((e) => `- ${e.text} (\`${e.cite}\`)`),
         '',
       );
     }
     return lines.slice(0, -1);
   }

   /** Sections 2, 3 and 4, in charter order. */
   export function judgmentLines(r: JudgmentResult): string[] {
     const mission = r.mission === '' ? [] : [`**Mission:** ${r.mission}`, ''];
     return [...mission, ...verifyLines(r), '', ...edgeCaseLines(r)];
   }

   /** Out-of-charter lines for items that did not cite a changed line. */
   export function droppedLines(dropped: DroppedItem[]): string[] {
     return dropped.map((d) => {
       const kind = d.section === 'verify' ? 'verify item' : 'edge case';
       return `- Dropped ${kind} "${d.text}" \u{2014} ${d.reason}`;
     });
   }
   ```

4. Run the test again and confirm it passes. Run `harness validate`.

### Task 4: `renderCharter` accepts an optional judgment

**Depends on:** Task 3 | **Files:** ts/src/briefing/charter.ts,
ts/test/briefing-judgment-sections.test.ts

1. Append a test that builds a minimal `BriefingFacts` (one unit, `skipped: []`,
   `coverage: { status: 'unavailable' }`, `inventory: 'unavailable'`,
   `risk_ranking: 'unavailable'`, `schema_version: 1`, `provenance: 'Diff: x'`)
   and asserts:
   - `renderCharter(facts)` is unchanged: it still contains the "come from the
     `canary-mission-briefing` skill" line and no `### Verify by hand`.
   - `renderCharter(facts, result)` has `Mission` < `### Verify by hand` <
     `### Edge cases this diff invites` < `### Existing tests` (by `indexOf`).
     It also contains `Dropped verify item "Vague"` after
     `### Out of this charter`, and no longer contains the "come from the ...
     skill" line.
2. Run the tests and confirm they fail.
3. In `charter.ts`:
   - Add `import { droppedLines, judgmentLines } from './judgment-sections.js';`
     and `import type { JudgmentResult } from './judgment.js';`.
   - Change the signature to
     `outOfCharterLines(facts: BriefingFacts, judgment?: JudgmentResult)`.
     Before the closing `lines.push('', 'What to explore by hand ...')`, add
     `if (judgment !== undefined) { lines.push(...droppedLines(judgment.dropped)); return lines; }`,
     so the pointer to the skill prints only when no judgment was supplied.
   - Change `renderCharter(facts: BriefingFacts, judgment?: JudgmentResult)` so
     it returns
     `[...headerLines(facts), '', ...(judgment ? [...judgmentLines(judgment), ''] : []), ...existingTestLines(facts), '', ...nothingCoversLines(facts), '', ...outOfCharterLines(facts, judgment), ''].join('\n')`.
4. Run
   `npx vitest run test/briefing-judgment-sections.test.ts test/briefing-cli.test.ts`
   and confirm both pass (the PR 1 tests are unchanged). Run `harness validate`.

### Task 5: `--judgment <file>` on `canary briefing`

**Depends on:** Task 4 | **Files:** ts/src/briefing/briefing-cli.ts,
ts/test/briefing-cli.test.ts

1. Add to the `describe('canary briefing')` block in `briefing-cli.test.ts` (the
   fixture `DIFF` adds `src/discount.ts` lines 1-3):

   ```ts
   const writeJudgment = (body: unknown): string => {
     const p = join(root, 'judgment.json');
     writeFileSync(
       p,
       typeof body === 'string' ? body : JSON.stringify(body),
       'utf-8',
     );
     return p;
   };
   const JUDGMENT = {
     mission: 'Explore the discount.',
     verify: [
       { text: 'Apply 10%', cite: 'src/discount.ts:2' },
       { text: 'Off-diff', cite: 'src/discount.ts:9' },
     ],
     edge_cases: [
       { category: 'Boundary values', text: '100%', cite: 'src/discount.ts:2' },
       { category: 'Accessibility', text: 'uncited' },
     ],
   };

   /** Criterion 9: only items citing an added line reach the charter. */
   it('renders cited judgment and drops out-of-range items with a reason', async () => {
     const res = await invokeCanary(
       ['briefing', '--diff', diffPath, '--judgment', writeJudgment(JUDGMENT)],
       { cwd: root },
     );
     expect(res.code).toBe(0);
     expect(res.stdout).toContain('- [ ] Apply 10% (`src/discount.ts:2`)');
     expect(res.stdout).toContain('#### Boundary values');
     expect(res.stdout).not.toContain('#### Accessibility');
     const out = res.stdout.slice(
       res.stdout.indexOf('### Out of this charter'),
     );
     expect(out).toContain(
       '"Off-diff" \u{2014} cites a line outside the added ranges',
     );
     expect(out).toContain('"uncited" \u{2014} no citation');
   });

   it('adds a judgment block to --json', async () => {
     const res = await invokeCanary(
       [
         'briefing',
         '--diff',
         diffPath,
         '--json',
         '--judgment',
         writeJudgment(JUDGMENT),
       ],
       { cwd: root },
     );
     const facts = JSON.parse(res.stdout);
     expect(facts.schema_version).toBe(1);
     expect(facts.judgment.verify).toHaveLength(1);
     expect(facts.judgment.dropped).toHaveLength(2);
   });

   it.each([
     ['invalid JSON', '{nope'],
     ['missing file', null],
   ])(
     'ignores %s judgment with a warning and still exits 0',
     async (_label, body) => {
       const p =
         body === null ? join(root, 'absent.json') : writeJudgment(body);
       const res = await invokeCanary(
         ['briefing', '--diff', diffPath, '--judgment', p],
         { cwd: root },
       );
       expect(res.code).toBe(0);
       expect(res.stderr).toContain('WARNING: judgment ignored:');
       expect(res.stdout).toContain('### Existing tests');
       expect(res.stdout).not.toContain('### Verify by hand');
     },
   );
   ```

2. Run `npx vitest run test/briefing-cli.test.ts` and confirm the new tests
   fail.
3. In `briefing-cli.ts`:
   - Add `judgment?: string;` to `BriefingOpts`, and import
     `{ type JudgmentResult, applyJudgment, parseJudgment } from './judgment.js'`
     plus `type BriefingFacts` from `./facts.js`.
   - Add:

     ```ts
     /** Read skill judgment; any problem degrades to a facts-only charter, never exit 1. */
     function loadJudgment(
       path: string | undefined,
       facts: BriefingFacts,
       deps: MainDeps,
     ): JudgmentResult | undefined {
       if (path === undefined) return undefined;
       let raw: string;
       try {
         raw = readFileSync(path, 'utf-8');
       } catch (e) {
         deps.err(
           `WARNING: judgment ignored: '${path}' could not be read (${(e as Error).message})`,
         );
         return undefined;
       }
       const parsed = parseJudgment(raw);
       if (typeof parsed === 'string') {
         deps.err(`WARNING: judgment ignored: ${parsed}`);
         return undefined;
       }
       return applyJudgment(parsed, facts.units);
     }
     ```

   - In `runBriefing`, after the `facts === null` abstain, replace the final
     `deps.out(...)` with:

     ```ts
     const judgment = loadJudgment(opts.judgment, facts, deps);
     const output =
       opts.json === true
         ? jsonIndent2(judgment === undefined ? facts : { ...facts, judgment })
         : renderCharter(facts, judgment);
     deps.out(output);
     ```

   - Add the option
     `.option('--judgment <file>', 'Skill-written judgment JSON (mission, verify, edge_cases); items must cite path:line in the added ranges.')`.
4. Run the test again and confirm it passes. Run `harness validate`.

### Task 6: `BRIEFING_MARKER` and `postCharter`

**Depends on:** none | **Files:** ts/src/briefing/comment.ts,
ts/test/briefing-comment.test.ts

1. Create `ts/test/briefing-comment.test.ts`:

   ```ts
   import { describe, expect, it } from 'vitest';
   import { BRIEFING_MARKER, postCharter } from '../src/briefing/comment.js';
   import {
     FakeGitHubClient,
     STICKY_MARKER,
   } from '../src/guardian/pr-comment.js';

   const bot = { login: 'github-actions[bot]', type: 'Bot' };
   const guardianBody = `${STICKY_MARKER}\n## Guardian verdict`;

   describe('postCharter (criteria 6, 10)', () => {
     it.each([
       ['with a guardian sticky', true],
       ['without one', false],
     ])(
       'posts under its own marker %s and never edits the guardian comment',
       async (_l, withGuardian) => {
         const fake = new FakeGitHubClient({
           comments: withGuardian
             ? [{ id: 1, body: guardianBody, user: bot }]
             : [],
         });
         const r = await postCharter(
           fake,
           '## Test charter (advisory, not a gate)',
         );
         expect(r.kind).toBe('posted');
         const mine = fake.comments.filter((c) =>
           c.body?.startsWith(BRIEFING_MARKER),
         );
         expect(mine).toHaveLength(1);
         if (withGuardian) expect(fake.comments[0]!.body).toBe(guardianBody);
       },
     );
     it('updates its own comment on a second run instead of stacking', async () => {
       const fake = new FakeGitHubClient();
       await postCharter(fake, 'one');
       const r = await postCharter(fake, 'two');
       expect(r).toMatchObject({ kind: 'posted', action: 'updated' });
       expect(fake.comments).toHaveLength(1);
       expect(fake.comments[0]!.body).toBe(`${BRIEFING_MARKER}\ntwo`);
     });
     it('degrades on 403 with a briefing-specific notice', async () => {
       const r = await postCharter(
         new FakeGitHubClient({ deny_writes: true }),
         'c',
       );
       expect(r.kind).toBe('degraded');
       if (r.kind === 'degraded')
         expect(r.notice).toMatch(/^canary briefing: .*HTTP 403/);
     });
     it('degrades on any other client error rather than throwing', async () => {
       const broken = new FakeGitHubClient();
       broken.listComments = async () => {
         throw new Error('boom');
       };
       const r = await postCharter(broken, 'c');
       expect(r).toMatchObject({ kind: 'degraded' });
     });
   });
   ```

   (Check `DEFAULT_IDENTITY.login` in `pr-comment.ts` and use it for `bot` so
   the guardian sticky would be matched by guardian's `findSticky`.)

2. Run `npx vitest run test/briefing-comment.test.ts` and confirm it fails.
3. Create `ts/src/briefing/comment.ts`:

   ```ts
   /**
    * Post the charter as its OWN sticky PR comment (#593 D3, criteria 6 and 10).
    *
    * The marker differs from guardian's, and `findSticky` matches on a body that
    * STARTS WITH the marker, so neither comment can overwrite the other. Every
    * write failure degrades: the charter is advisory, so a missing comment
    * must never turn into an exit 1.
    */
   import {
     type GitHubClient,
     GitHubPermissionError,
     upsertStickyComment,
   } from '../guardian/pr-comment.js';

   export const BRIEFING_MARKER = '<!-- canary-mission-briefing -->';

   export type PostResult =
     | { kind: 'posted'; action: string; commentId: number | null }
     | { kind: 'degraded'; notice: string };

   const FORBIDDEN_NOTICE =
     'canary briefing: token lacks write permission on PR comments (HTTP 403) \u{2014} charter printed to stdout instead';

   export async function postCharter(
     client: GitHubClient,
     charter: string,
   ): Promise<PostResult> {
     try {
       const r = await upsertStickyComment(
         client,
         `${BRIEFING_MARKER}\n${charter}`,
         BRIEFING_MARKER,
       );
       if (r.action === 'degraded')
         return { kind: 'degraded', notice: FORBIDDEN_NOTICE };
       return { kind: 'posted', action: r.action, commentId: r.comment_id };
     } catch (e) {
       const notice =
         e instanceof GitHubPermissionError
           ? FORBIDDEN_NOTICE
           : `canary briefing: could not post the charter comment (${(e as Error).message}) \u{2014} charter printed to stdout instead`;
       return { kind: 'degraded', notice };
     }
   }
   ```

4. Run the test again and confirm it passes. Run `harness validate`.

### Task 7: `buildCommentClient` seam on `MainDeps`

**Depends on:** none | **Files:** ts/src/main-deps.ts

1. Add a failing assertion to `ts/test/briefing-comment.test.ts`:

   ```ts
   import { defaultMainDeps } from '../src/main-deps.js';
   import { RestGitHubClient } from '../src/guardian/pr-comment.js';
   it('defaults the comment client to the REST client', () => {
     expect(defaultMainDeps().buildCommentClient('o/r', 7)).toBeInstanceOf(
       RestGitHubClient,
     );
   });
   ```

   Run it and confirm it fails.

2. In `ts/src/main-deps.ts`:
   - Import
     `{ type GitHubClient, RestGitHubClient } from './guardian/pr-comment.js'`.
   - Add to `MainDeps`, after `loadCompanyKnowledge`:
     `/** PR comment client for \`canary briefing --comment\` (#593). */
     buildCommentClient(repo: string, prNumber: number): GitHubClient;`
   - Add to `defaultMainDeps()`:
     `buildCommentClient: (repo, prNumber) => new RestGitHubClient(repo, prNumber, process.env['GITHUB_TOKEN'] ?? ''),`
3. Run `npx tsc --noEmit -p .`. If a test builds a full `MainDeps` literal, add
   `buildCommentClient: () => new FakeGitHubClient()` to it. Find such literals
   with `grep -rn "makeSkillRegistry:" test/`.
4. Run the test and confirm it passes. From the worktree root, run
   `harness check-deps` (the composition layer imports guardian) and
   `harness validate`.

### Task 8: `--comment` wiring on `canary briefing`

**Depends on:** Task 5, Task 6, Task 7 | **Files:**
ts/src/briefing/briefing-cli.ts, ts/test/briefing-cli.test.ts

1. Add tests to `briefing-cli.test.ts` (import `FakeGitHubClient`,
   `STICKY_MARKER` from `../src/guardian/pr-comment.js` and `BRIEFING_MARKER`
   from `../src/briefing/comment.js`):

   ```ts
   const PR_ENV = { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/7/merge' };

   /** Criterion 6: own marker, guardian sticky untouched. */
   it('posts the charter under its own marker and leaves the guardian comment alone', async () => {
     const guardianBody = `${STICKY_MARKER}\nverdict`;
     const fake = new FakeGitHubClient({
       comments: [
         {
           id: 1,
           body: guardianBody,
           user: { login: 'github-actions[bot]', type: 'Bot' },
         },
       ],
     });
     const res = await invokeCanary(
       ['briefing', '--diff', diffPath, '--comment'],
       {
         cwd: root,
         env: PR_ENV,
         deps: { buildCommentClient: () => fake },
       },
     );
     expect(res.code).toBe(0);
     expect(res.stdout).toMatch(
       /^Charter posted as a PR comment \(created, id \d+\)\./,
     );
     expect(fake.comments[0]!.body).toBe(guardianBody);
     expect(
       fake.comments[1]!.body!.startsWith(
         `${BRIEFING_MARKER}\n## Test charter`,
       ),
     ).toBe(true);
   });

   /** Criterion 10: a 403 prints the charter with ::warning:: and exits 0. */
   it('prints the charter with a ::warning:: on 403 and exits 0', async () => {
     const res = await invokeCanary(
       ['briefing', '--diff', diffPath, '--comment'],
       {
         cwd: root,
         env: PR_ENV,
         deps: {
           buildCommentClient: () =>
             new FakeGitHubClient({ deny_writes: true }),
         },
       },
     );
     expect(res.code).toBe(0);
     expect(res.stdout).toContain('## Test charter (advisory, not a gate)');
     expect(res.stdout).toContain(
       '::warning::canary briefing: token lacks write permission',
     );
   });

   it('prints the charter with a note when there is no PR context', async () => {
     let built = false;
     const res = await invokeCanary(
       ['briefing', '--diff', diffPath, '--comment'],
       {
         cwd: root,
         env: {
           GITHUB_REPOSITORY: undefined,
           GITHUB_REF: undefined,
           GITHUB_EVENT_PATH: undefined,
         },
         deps: {
           buildCommentClient: () => {
             built = true;
             return new FakeGitHubClient();
           },
         },
       },
     );
     expect(res.code).toBe(0);
     expect(built).toBe(false);
     expect(res.stdout).toContain('## Test charter');
     expect(res.stderr).toContain('no PR context; charter printed to stdout');
   });
   ```

   Use the login value confirmed in Task 6. If the testkit does not already
   clear `GITHUB_EVENT_PATH`, the explicit `undefined` above covers it.

2. Run `npx vitest run test/briefing-cli.test.ts` and confirm the new tests
   fail.
3. In `briefing-cli.ts`:
   - Add `comment?: boolean;` to `BriefingOpts`. Import `prContextFromEnv` from
     `../guardian/cli.js` (extend the existing import) and `postCharter` from
     `./comment.js`.
   - Add:

     ```ts
     /** `--comment`: post, else print with a note or ::warning:: (never exit 1). */
     async function deliverComment(
       charter: string,
       stdout: string,
       deps: MainDeps,
     ): Promise<void> {
       const ctx = prContextFromEnv(deps.env);
       if (ctx === null) {
         deps.err('canary briefing: no PR context; charter printed to stdout');
         deps.out(stdout);
         return;
       }
       const result = await postCharter(
         deps.buildCommentClient(ctx[0], ctx[1]),
         charter,
       );
       if (result.kind === 'posted') {
         deps.out(
           `Charter posted as a PR comment (${result.action}, id ${result.commentId}).`,
         );
         return;
       }
       deps.out(stdout);
       deps.out(degradationAnnotation(result.notice));
     }
     ```

     (Import `degradationAnnotation` from `../guardian/pr-comment.js`, or inline
     `` `::warning::${result.notice}` `` if that import would push
     `briefing-cli.ts` past the fan-out limit PR 1 cut it to.)

   - Make `runBriefing` `async` and return `Promise<void>`. Replace the final
     `deps.out(output)` with:

     ```ts
     if (opts.comment === true) {
       await deliverComment(renderCharter(facts, judgment), output, deps);
       return;
     }
     deps.out(output);
     ```

   - Add
     `.option('--comment', 'Upsert the charter as its own sticky PR comment (advisory; never the guardian comment).')`
     and change the action to
     `.action(async (opts: BriefingOpts) => { await runBriefing(opts, deps); })`.
4. Run the test file again and confirm every test passes, the PR 1 tests
   included. Run `harness validate`.

### Task 9: Ratchets: entryPoints and arch allowance

[checkpoint:human-verify] The allowance number and reason need human approval,
as the PR 1 allowance did.

**Depends on:** Task 8 | **Files:** harness.config.json,
.harness/arch/allowances/feat-593-briefing-skill-comment.json

1. In `harness.config.json`, add these three entries after
   `"ts/src/briefing/inputs.ts",` in **both** arrays (around lines 241 and 337),
   keeping alphabetical order within the briefing block:
   `"ts/src/briefing/comment.ts"` (before `facts.ts`),
   `"ts/src/briefing/judgment-sections.ts"` and `"ts/src/briefing/judgment.ts"`
   (after `inputs.ts`). Do NOT change any `maxFindings`.
2. Run the gates from `ts/`. From the worktree root, run
   `harness check-arch --json > $TMPDIR/arch.json` and read `newViolations` and
   the `module-size` regression. Then run `harness cleanup --type entropy` and
   `harness check-perf` (or the commands the CI workflow uses; see
   `.github/workflows/` for exact invocations) and confirm there are no new
   findings. If perf reports complexity on `applyJudgment` or
   `outOfCharterLines`, split the function. Never allowance it.
3. If `module-size` regressed, create
   `.harness/arch/allowances/feat-593-briefing-skill-comment.json` in the shape
   of `feat-593-briefing-facts-cli.json`: `reason` (the measured before and
   after values, the CLI version, the base SHA, and what the growth is: judgment
   validation, judgment sections, comment poster, criteria 6/9/10),
   `"categories": { "module-size": <measured> }`, `"violationIds": []`, and
   `"createdFrom": "<git rev-parse --short origin/main>"`. Measure in this
   worktree after `git fetch origin`, not in the main checkout.
4. Run `harness validate` and `harness check-arch`.

### Task 10: The skill: SKILL.md, skill.yaml, slash command

**Depends on:** Task 8 | **Files:**
agents/skills/claude-code/canary-mission-briefing/SKILL.md,
agents/skills/claude-code/canary-mission-briefing/skill.yaml,
agents/commands/claude-code/harness/canary-mission-briefing.md

1. Run `npx vitest run test/skill-` from `ts/` for a baseline and record the
   pass count.
2. Create `SKILL.md`:

   ```markdown
   ---
   name: canary-mission-briefing
   description: >
     Turns a PR diff into a test charter for a human tester: what to verify by
     hand, which edge cases this diff invites, which tests already touch the
     changed code, and what nothing covers. Use when asked for a "test charter",
     "what should I test by hand on this PR", or "brief a tester". Advisory,
     never a gate: it writes no test file and changes no check. NOT
     canary-pr-guardian (a verdict) and NOT canary-generate-test (test code).
   cli: canary briefing
   requires: [node>=20]
   ---

   # Canary: Mission Briefing

   <one paragraph: charter vs verdict vs generated test, then the three-surface
   table from the spec>

   ## When to Use / When NOT to Use

   ## Workflow

   1. **Facts.** Run
      `canary briefing --json [--diff <file>] [--coverage <report>]`. Exit 3
      means it abstained. Relay the `Abstained:` line and stop, with no charter.
      Never exit 1.
   2. **Risk.** If `risk_ranking` is `available`, the units are already highest
      risk first. Run `canary-failure-impact` for the top unit only, to keep
      cost bounded (spec D6).
   3. **Edge cases.** For each unit, invoke `canary-edge-case-discovery` on the
      added ranges only. Keep only cases you can tie to one added line. Use the
      exact category names: Boundary values, Race conditions, Locale and
      timezone, Partial network, Unexpected input shapes, Accessibility.
   4. **Judgment file.** Write JSON:
      `{ "mission": "...", "verify": [{ "text": "...", "cite": "path:line" }], "edge_cases": [{ "category": "...", "text": "...", "cite": "path:line" }] }`.
      Every `cite` must be a line inside that unit's `added_ranges`. The CLI
      drops anything else and lists it under "Out of this charter". A dropped
      item is a signal to re-cite, not to argue.
   5. **Render.** Run `canary briefing --judgment <file>` (stdout), or add
      `--comment` in CI to upsert a sticky comment under
      `<!-- canary-mission-briefing -->`. A 403 prints the charter with a
      `::warning::` and exits 0.

   ## Honesty rules

   <coverage unknown is not uncovered; imports are not execution; no pass/fail
   words or status emoji; never edit the guardian comment>

   ## Related skills

   canary-edge-case-discovery, canary-critical-areas, canary-failure-impact,
   canary-pr-guardian, canary-generate-test; guide
   docs/guides/mission-briefing.md
   ```

   Fill the three bracketed placeholders from the spec's Overview and the
   guide's "Honesty rules" section. Copy their wording and do not invent new
   rules.

3. Create `skill.yaml` modelled on `canary-edge-case-discovery/skill.yaml`:
   `name: canary-mission-briefing`, `version: '1.0.0'`, a one-sentence
   description, `stability: static`, `triggers: [manual]`,
   `platforms: [claude-code]`, `type: rigid`, `tools: []`, `tier: 2`, and
   `depends_on: [canary-edge-case-discovery, canary-critical-areas]`.
4. Create `agents/commands/claude-code/harness/canary-mission-briefing.md`, a
   byte-for-byte copy of `canary-edge-case-discovery.md` with the name
   (`harness:canary-mission-briefing`), description, objective and the two
   `@agents/skills/claude-code/canary-mission-briefing/...` paths swapped, and
   `allowed-tools: [Read, Write, Bash]`. Or run
   `harness generate-slash-commands` if it regenerates only this file. Check
   with `git status` and revert any unrelated regenerated files.
5. Run `npx vitest run test/skill-` again. The pass count should be the baseline
   plus the new skill's parametrised cases. Fix any registry or frontmatter
   assertion that fails. Run `harness validate`.

### Task 11: Registries: README, naming registry, AGENTS.md

**Depends on:** Task 10 | **Files:** agents/skills/README.md,
docs/naming-registry.md, AGENTS.md **Category:** integration

1. `agents/skills/README.md`: add `│   ├── canary-mission-briefing/` to the
   structure tree in alphabetical position. Under a fitting "Available Skills"
   subsection (next to `canary-edge-case-discovery`, around line 72), add:
   ``- [`canary-mission-briefing`](./claude-code/canary-mission-briefing/SKILL.md) — Turns a PR diff into a test charter for a human tester (verify by hand, edge cases cited to changed lines, existing tests, nothing covers). Advisory, never a gate; `cli: canary briefing`.``
2. `docs/naming-registry.md` line 98: change `reserved` to `shipped`.
3. `AGENTS.md`: find the skill list with
   `grep -n "canary-edge-case-discovery\|canary-batwoman" AGENTS.md` and add one
   line for `canary-mission-briefing` (#593) in the same format.
4. From `ts/`, run
   `npx prettier --write ../agents/skills/README.md ../docs/naming-registry.md ../AGENTS.md`,
   then `npm run format:check`, then `harness validate`.

### Task 12: Guide and guardian pointer; final gates

**Depends on:** Task 9, Task 11 | **Files:** docs/guides/mission-briefing.md,
agents/skills/claude-code/canary-pr-guardian/SKILL.md **Category:** integration

1. `docs/guides/mission-briefing.md`:
   - Rewrite "What ships today" (lines 21-28). Both halves ship now: the CLI
     gives the facts and renders skill judgment through `--judgment`, and
     `--comment` posts it. Remove "Until that skill ships ...".
   - Add these rows to the Flags table: `--judgment <file>` (skill-written JSON;
     items not citing an added line are dropped into "Out of this charter";
     unreadable input warns and degrades to facts only) and `--comment` (sticky
     PR comment under `<!-- canary-mission-briefing -->`; never edits the
     guardian comment; no PR context or 403 prints to stdout, the 403 case with
     `::warning::`, exit 0).
   - Add a "Charter sections" list (1 Header ... 7 Out of this charter) and a
     `judgment` JSON example next to the `BriefingFacts` section.
2. `agents/skills/claude-code/canary-pr-guardian/SKILL.md`: under
   `## Safety model` add one line: `- The \`<!-- canary-mission-briefing -->\`
   test charter comment is not guardian output and never a verdict; guardian
   neither reads nor edits it (see canary-mission-briefing).`
3. Run prettier on both files. From `ts/`, run the gates:
   `npm run build && npm run typecheck && npm run format:check && npm test`.
   Read the test totals (the denominator) and make sure the counts are nonzero
   and include the new files `briefing-judgment`, `briefing-judgment-sections`
   and `briefing-comment`.
4. From the worktree root, run `harness validate`, `harness check-deps` and
   `harness check-arch`.

## Traceability

| Truth | Tasks   |
| ----- | ------- |
| 1     | 3, 4, 5 |
| 2, 3  | 2, 5    |
| 4, 5  | 1, 5    |
| 6     | 6, 8    |
| 7     | 6, 8    |
| 8, 9  | 8       |
| 10    | 10      |
| 11    | 11, 12  |
| 12    | 9, 12   |

Parallel opportunities: Tasks 6 and 7 do not depend on Tasks 1-5. Task 10 only
needs the flags to be settled, so it can start alongside Task 9.
