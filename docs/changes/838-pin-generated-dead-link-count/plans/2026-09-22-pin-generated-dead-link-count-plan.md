# Plan — pin the generator-stamped dead-link count

Spec: `docs/changes/838-pin-generated-dead-link-count/proposal.md` Refs #838
(partial slice; root fix is upstream in `harness-engineering`). Base:
`origin/main` @ `7995370b`. Branch: `test/838-pin-dead-link-count`.

## Phase 1 — Measure (done before any edit)

| Step | Action                                    | Result                                                   |
| ---- | ----------------------------------------- | -------------------------------------------------------- |
| 1.1  | `node scripts/check_doc_links.mjs --json` | `generatedFindings` = 30, `generatedFiles` = 38          |
| 1.2  | Compare against the issue body            | issue says 36 files / 255 scanned — both stale; 30 holds |
| 1.3  | Check `filesScanned` stability            | 381 (clean worktree) vs 382 (tree with an untracked doc) |

Conclusion carried into the design: pin `generatedFindings`, never
`filesScanned`.

## Phase 2 — Test first (TDD)

| Step | Action                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | Add `it('pins the generator-stamped dead-link count')` inside the existing `describe('the repository itself')` in `ts/test/doc-links.test.ts` |
| 2.2  | Plant a positive: set the constant to a wrong value and run the file; confirm the case goes RED and the message names the growth direction    |
| 2.3  | Restore the constant to 30; confirm GREEN                                                                                                     |
| 2.4  | Plant the denominator positive: force the `generatedFiles > 0` assertion to see 0; confirm it fails on the denominator line, not on the count |

No production code changes. `scripts/check_doc_links.mjs` is not touched — no
exclusion, no ceiling, no narrowing of the scan.

## Phase 3 — Gates

| Step | Command                | Where     |
| ---- | ---------------------- | --------- |
| 3.1  | `npm run build`        | `ts/`     |
| 3.2  | `npm run typecheck`    | `ts/`     |
| 3.3  | `npm run format:check` | `ts/`     |
| 3.4  | `npm test`             | `ts/`     |
| 3.5  | `check-deps`           | repo root |

There is no `lint` script in `ts/` — build, typecheck, format:check and test are
the four gates.

## Phase 4 — Ratchets this change does and does not touch

- **Entropy:** no new module, no new `scripts/lib/*.mjs`, no new `.test.ts` file
  — nothing to declare in either `entropy.entryPoints` array, and `maxFindings`
  is not touched.
- **Perf delta / arch allowances:** no new CLI surface, no new import.
- **Docs ratchet:** the added `docs/changes/…` files are prose with no
  cross-file links, so the gated dead-link denominator is unchanged.

## Phase 5 — Land

| Step | Action                                                                                     |
| ---- | ------------------------------------------------------------------------------------------ |
| 5.1  | `prettier --write` the touched md/ts                                                       |
| 5.2  | Commit `test(doc-links): pin the generator-stamped dead-link count` (no co-author trailer) |
| 5.3  | Commit `provenance.json`, then `harness waypoint record-provenance …`                      |
| 5.4  | Push, open PR with `Refs #838` — **no closing keyword anywhere near 838**                  |
| 5.5  | Stop at a green, reviewable PR. Do not merge.                                              |
