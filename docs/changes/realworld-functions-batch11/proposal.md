# Real-World Function Examples — Batch 11

**Status:** implemented **Type:** docs/examples (prompt-only) — small change, no
production code **Keywords:** realworld-functions, examples, prompt-only,
vitest, path-traversal, containment, catalog

## Overview

Adds `examples/realworld-functions/path-normalizer-posix/` (`prompt.txt` +
`README.md`), the batch-10 ideation's recorded next-up candidate
(`docs/ideation/realworld-function-batch10-2026-09-17.md`, rank 3, score 4.00,
"first candidate up if the cut moves to Top 3"). It takes the catalog to 22
examples (10 pytest / 12 vitest).

## Decisions made

| Decision         | Choice                                                                         | Rationale                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Batch size       | **1**                                                                          | Every other batch-10 below-the-cut candidate was cut for overlap or hard-rejected in that doc, and nothing has changed to rescue them. `bankers-rounding-splitter` was considered and dropped for the doc's own reason: half-to-even alone is too thin a delta over `money-allocator` and `bytes-humanizer`. |
| Containment test | Final path only, compared **segment by segment** against the base              | The lesson is the `startsWith` prefix trap: `/srv/app-evil` shares the string prefix `/srv/app`. Judging the final path pins `../app/x` (leave and return) as accepted, so two implementations agree.                                                                                                        |
| Base boundary    | The base itself is inside; its parent is outside                               | The off-by-one pair `a/b/../..` (inside) vs `a/b/../../..` (escape) is the batch-10 doc's named boundary                                                                                                                                                                                                     |
| Bounded surface  | No symlinks, Windows paths, encoding or filesystem access                      | Each forks the semantics; the doc records this bound as the reason the candidate is tractable                                                                                                                                                                                                                |
| Error contract   | `RangeError` for malformed input; `Error` containing `escapes base` for escape | Keeps "the input was wrong" separate from "the input was a traversal", so a suite can tell which rule fired                                                                                                                                                                                                  |
| Numeric contract | None — string-only input                                                       | S4 does not apply; recorded so the absence is not read as an omission                                                                                                                                                                                                                                        |

## Verification

Every expected value in `prompt.txt` was checked against a throwaway reference
implementation of the contract before shipping: 9 resolutions and 7 rejections
all agree, and the reference reproduces the trap — a naive `startsWith(base)`
check accepts `../app-evil/x`. The README's embedded prompt is byte-identical to
`prompt.txt`.

## Next batch

The batch-10 pool is now exhausted: the remaining candidates were cut for
overlap or rejected on unbounded surfaces. Batch 12 needs fresh ideation
(`harness:ideate`) against the 22-example novelty map.
