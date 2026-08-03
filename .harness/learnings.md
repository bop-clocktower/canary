
## 2026-05-14 — Multi-Provider LLM execution

- [skill:harness-execution] [outcome:success] All 5 tasks completed; 33 unit tests pass across all providers
- [skill:harness-execution] [outcome:gotcha] google.generativeai package is deprecated — FutureWarning on import; migrate to google.genai in a follow-up
- [skill:harness-execution] [outcome:gotcha] System /tmp ENOSPC mid-run caused by full root filesystem (npm cache + Library/Caches); clearing npm cache resolved it
- [skill:harness-execution] [outcome:decision] Codex provider implemented as distinct class (not alias) with gpt-4o default; keeps model selection independent from OpenAIProvider

## 2026-08-02 — No-Silent-Abstention Wave 2 (guardian)

- [skill:harness-execution] [outcome:success] All 12 tasks executed as written, one commit each, TDD red observed per task. Suite 1671 -> 1689 (18 new tests); tsc, prettier, harness validate green at every task boundary.
- [skill:harness-execution] [outcome:gotcha] Task 8's plan test contradicted its own implementation step: it asserted `stdout.toLowerCase()` did NOT contain 'abstained' while the same task added a lowercase `abstained` JSON key. Fixed by asserting the CAPITALIZED human line ('⚠ Abstained — ...') instead. Lesson: when a task adds a field AND asserts a substring absent, check whether the field name collides with the copy — case-insensitive assertions on JSON-bearing stdout are a trap.
- [skill:harness-execution] [outcome:gotcha] The plan's Task 12 said `npx prettier --check src test`, which is BROADER than the repo's own `format:check` (`src/**/*.ts test/**/*.ts *.ts`). The broader command flags 11 pre-existing golden JSON fixtures that are byte-pinned by parity tests — reformatting them would break the goldens. Verify a formatting command against the project's real gate before "fixing" what it reports.
- [skill:harness-execution] [outcome:decision] `HardGateAbstained` subclasses `HardGateBlocked` so pre-#508 catch sites keep working; the CLI arm for the subclass MUST precede the parent arm or the subclass is swallowed and exits 1 instead of 3.
- [skill:harness-execution] [outcome:gotcha] Setting a roadmap row to `in-progress` without an `assignee` violates RMH005 and turns `harness validate` red. Caught at PREPARE while establishing a clean baseline; fixed in PR #525 using the repo's de-identified `@example.com` convention rather than the real git identity (this repo was de-identified in #249-#251).
