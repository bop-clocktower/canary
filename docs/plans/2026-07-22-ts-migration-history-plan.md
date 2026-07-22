# Plan: TS migration — subsystem 2 (agent/history → TS)

**Date:** 2026-07-22 | **Approach:** strangler (Python keeps shipping) |
**Toolchain:** established in the analysis pilot (`ts/`, strict tsc, Vitest,
arch gate)

Second subsystem of the Python→TS migration, per the pilot decision gate
([ts-migration-pilot-DECISION.md](ts-migration-pilot-DECISION.md)). The analysis
pilot already ported the **read side** (`ndjson-store` queries, `detector`,
`record` types); this completes the `history/` vertical by porting the **write
side** and the store factory, so TS owns the full write→read→report loop.

## Scope (decisions locked with the user)

- **Supabase:** full port now, using `@supabase/supabase-js`, behind the
  `make_store` factory (Local vs Supabase by db-url/env). Mocked in tests — no
  live network.
- **CLI:** out of scope (library only — not cutting over the shipping CLI).
- **Out of scope:** the Python `agent/history/cli.py`; any user-facing cutover.

## Observable truths

1. `make_run_id(suite, commit, epoch)` in TS returns
   `{suite}-{commit[:8]}-{epoch}`, matching Python exactly.
2. **Write seam (the new proof):** a record written by TS `pushRun` is read
   correctly by the **Python** `LocalHistoryStore` (cross-language), and a
   record written by Python is read by TS (already proven). Dedup by `run_id`
   holds on both sides.
3. `makeStore(dbUrl?, ndjsonPath?)` returns a `SupabaseHistoryStore` when a
   db-url is configured, else an `NdjsonHistoryStore` (mirrors `make_store`).
4. `SupabaseHistoryStore` builds the same queries/URL parsing as Python
   (verified against a mocked client); `_parse_project_url` matches.
5. `classify_flake_trend` / `FlakeTrend` ported with matching thresholds.
6. TS gate green (typecheck + prettier + vitest 90/85); `harness ci check` arch
   clean except the expected module-size growth (baseline refreshed once).
7. Python `history/` unchanged; still ships.

## File map

```text
MODIFY ts/src/history/record.ts        (full RunRecord/TestResult fields for write)
CREATE ts/src/history/schema.ts (+test) (makeRunId + record/result serialization)
MODIFY ts/src/history/ndjson-store.ts   (add pushRun write side + dedup)
CREATE ts/src/history/store.ts (+test)   (makeStore factory)
CREATE ts/src/history/supabase-store.ts (+test) (@supabase/supabase-js port, mocked)
MODIFY ts/src/history/detector.ts        (add classify_flake_trend/FlakeTrend if absent)
CREATE ts/test/write-seam.test.ts        (round-trip + cross-language)
CREATE scripts/read_ts_written_history.py (Python reads a TS-written jsonl → asserts)
MODIFY ts/package.json                    (+ @supabase/supabase-js)
```

## Task groups

1. **Schema + full record types** — `schema.ts` (`makeRunId`, serialize), extend
   `record.ts` to the full write field set. TDD. (~3 tasks)
2. **Write side** — `pushRun` on `NdjsonHistoryStore` (append + dedup), matching
   Python's serialization. TDD + a TS read-back test. (~2 tasks)
3. **Store factory** — `makeStore(dbUrl?, ndjsonPath?)`. TDD. (~1 task)
4. **Supabase store** — `@supabase/supabase-js` port with a mocked client;
   `_parse_project_url`, push/query mapping. Keep functions < cc 10. (~3 tasks)
5. **Detector completion** — `classify_flake_trend` + `FlakeTrend`. TDD. (~1
   task)
6. **Cross-language write-seam proof** — `scripts/read_ts_written_history.py`
   reads a TS-written jsonl via the Python `LocalHistoryStore` and asserts query
   parity; `write-seam.test.ts` drives it. (~2 tasks)
7. **Gate + baseline** — `harness ci check` clean; refresh module-size baseline
   for the growth; PR. (me)

## Risks

- **Write-format parity:** JSON key order differs (TS insertion vs Python
  dataclass order) but does not affect round-trip readability — the proof is
  read-back correctness, not byte-identical lines. Include all fields (null for
  absent) so Python `.get()` and TS both resolve them.
- **Supabase SDK:** mock the client in tests; no live calls. Isolate URL parsing
  as a pure function for direct parity testing.
- **Arch complexity:** apply the `def()`-helper + small-function discipline from
  the pilot; run `harness ci check` before finishing.
