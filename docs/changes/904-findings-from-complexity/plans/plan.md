# #904: guarded refactor of `findingsFrom` (entropy ratchet parser)

`findingsFrom` in `scripts/entropy-ratchet.mjs` parses the report of the
**blocking** entropy ratchet. A refactor that extracts a different count keeps
that gate green over findings it no longer sees, so the order was fixed: pin
first, prove the pins bite, refactor, then converge on both instruments.

## Root cause (the surprise)

`findingsFrom` was 17 lines with about 6 decision points, but
`harness check-perf` (CLI 12.7.0) reported it as **194 lines long, complexity
21**. The analyzer counts braces inside string literals, and
`trimmed.startsWith('{')` opened a brace that never closed. So it read the
function as running to the end of the file and summed every function below it.
The fix has two parts: split the per-line parse into `contractFindings(line)`,
and spell the brace guard as `'\x7b'`.

## Branch table

Pinned in `ts/test/entropy-ratchet.test.ts`, block
`findingsFrom characterization (#904)`.

| #       | Branch                           | Pinned by                                                                                     |
| ------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| B1      | loop over zero useful lines      | empty report, whitespace-only report -> abstain                                               |
| B2      | `trim()`                         | CRLF endings, leading indentation -> 7                                                        |
| B3      | line does not start with a brace | JSON not at line start, JSON array line -> abstain                                            |
| B4      | `JSON.parse` throws              | malformed JSON, lone brace -> abstain; malformed before/after a valid line -> 7               |
| B5      | `check !== 'cleanup'`            | other check, missing check, case differs -> abstain; later other-check line does not override |
| B6      | `findings` not an integer        | string, float, missing, null -> abstain; later non-integer line does not override             |
| B7      | last valid line wins             | `1` then `7` -> 7; contract line mid-noise -> 7; no trailing newline -> 7                     |
| B8      | no contract line -> `null`       | truncated real report -> abstain; explicit `0` -> 0; `-1` -> -1                               |
| Real    | captured 12.7.0 report           | `ts/test/fixtures/entropy-cleanup-report-12.7.0.txt` -> exactly 144                           |
| Planted | real report + 1 planted finding  | -> exactly 145, and exit 1 with `+1` against a 144 ceiling                                    |

Each case asserts the exact OK line (count and headroom), not just the exit
code. That makes 27 characterization cases: 25 table rows, the real report, and
the planted positive.

## Mutation matrix (run against the pre-refactor parser, all reverted)

| Mutation                          | Result                                  |
| --------------------------------- | --------------------------------------- |
| M1 drop `trim()`                  | CAUGHT (1 red)                          |
| M2 drop the leading-brace guard   | SURVIVED, equivalent mutant (see below) |
| M3 malformed line aborts the scan | CAUGHT (1 red)                          |
| M4 drop the `check` filter        | CAUGHT (4 red)                          |
| M5 drop the integer check         | CAUGHT (4 red)                          |
| M6 accept any number (floats)     | CAUGHT (1 red)                          |
| M7 first line wins                | CAUGHT (1 red)                          |
| M8 off-by-one value               | CAUGHT (13 red)                         |
| M9 skip the last line             | CAUGHT (6 red)                          |
| M10 abstention reads as zero      | CAUGHT (14 red)                         |

The pins caught all 9 non-equivalent mutations. M2 can't change the output: any
JSON text that doesn't start with a brace parses to a non-object, so its `check`
is undefined and B5 rejects it. The guard is only a fast path.

## Convergence (same tree, CLI 12.7.0, no narrowing flag, same invocation as CI)

| Instrument                        | Before                                | After                           |
| --------------------------------- | ------------------------------------- | ------------------------------- |
| `harness check-perf` total        | 224                                   | 222                             |
| `findingsFrom` findings           | complexity 21 (error), 194 lines long | none                            |
| new identities                    | n/a                                   | 0 (perf-ratchet delta: 0 new)   |
| `entropy-ratchet.mjs` file size   | 298 lines (`wc -l`), no finding       | 299 lines, no finding           |
| `harness cleanup --findings-json` | 144                                   | 144 (same set, reordered only)  |
| entropy ratchet on that report    | OK 144 / baseline 145                 | delta +0, OK 144 / baseline 145 |

After the refactor, `findingsFrom` has complexity about 2 and `contractFindings`
about 5, and both are nested at depth 2 or less. No ceiling, baseline or
suppression was touched.
