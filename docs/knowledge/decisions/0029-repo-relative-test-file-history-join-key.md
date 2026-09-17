---
number: 0029
title: Repo-relative test_file is the history join key
date: 2026-09-16
status: accepted
tier: medium
source: docs/changes/460-predictive-test-ordering/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0029 — Repo-relative test_file is the history join key

**Status:** accepted **Date:** 2026-09-16 **Deciders:** Bri Stevenski
**Related:** docs/changes/460-predictive-test-ordering/proposal.md (D1, D2,
success criterion 1); docs/changes/460-predictive-test-ordering/spike.md (Q2);
ADR 0013 (async history store); `ts/src/history/keys/test-file-key.ts`

## Context

`canary history record` writes one run per line to
`test-results/reports/history-v2.jsonl`. Each test row carries a `test_file`,
but the spike for #460 found three different path bases in it:

- the vitest reader wrote `file.name`, an absolute path on the machine that ran
  the suite;
- the Playwright reader wrote a path relative to the config's `testDir`;
- the JUnit reader wrote the `file` attribute when the producer set one, and
  `''` otherwise.

A diff path such as `ts/src/history/cli.ts` matched none of them. Every consumer
that joins history to a change (predictive ordering in #460, replay in #461)
needs one key. The run's `commit_sha` had the same problem on a developer
machine: without `GITHUB_SHA` it was the literal `'local'`, which joins to no
commit.

The spec's D1 puts this store change before any ranking code, and D2 picks the
key. The proposal flags D1 + D2 for an ADR because every later history consumer
depends on the key.

Options considered:

- A) Store `test_file` relative to the git top-level, with `/` separators, at
  write time. Keep and count a path that cannot be made so.
- B) Store paths as each reader emits them, and normalize at query time.
- C) Store the absolute path and strip a prefix at query time.

## Decision

Adopt option A.

- `record` resolves the git top-level once and rewrites each row's `test_file`
  to a repo-relative POSIX path. This is the same form `git diff --name-only`
  and `git ls-files` print.
- A relative path is resolved against its real base first: the report config's
  `rootDir` (else the first project's `testDir`) for Playwright, and the working
  directory for vitest and JUnit. A Playwright report with no config gives no
  base, so its relative paths are not guessed.
- A path that is empty, outside the repository, relative to an unknown base, or
  recorded outside any repository is **kept as written and counted**. The
  success line prints `unjoinableTestFiles: n of m` and `--json` carries
  `unjoinableTestFiles: n` beside `checked: m`.
- `record` refuses `commit_sha: 'local'` inside a git repository where `HEAD`
  resolves, records `HEAD` instead, and says so on stderr. Outside a repository,
  or before the first commit, `'local'` stays because there is no truer value.
- `SCHEMA_VERSION` does not change. The field already existed; only the values
  written from now on are normalized.

## Consequences

- A history row joins to a diff with plain string equality. No consumer has to
  know which runner wrote the row.
- The unjoinable count makes the join's denominator visible. A JUnit report with
  no `file` attributes reports every row as unjoinable instead of 0, so a later
  join that matches nothing can be traced to the data, not the ranker.
- Rows written before this change keep their old values. The store is
  append-only and the schema did not change, so there is no migration; a
  consumer that needs a clean join window starts from runs recorded after this
  ADR. Canary's own CI store was rebuilt from empty on every run until the
  `fleet-health` cache (#1021, phase 1c), so there is no old canary history to
  carry.
- A report recorded on a different machine or checkout from the one that ran the
  suite (for example a CI artifact recorded locally) has absolute paths outside
  the local repo. Those rows are counted as unjoinable rather than rewritten.
  Recording where the suite ran is the supported flow.
- `record` now shells out to `git` once per run, twice when it has to resolve
  `HEAD`. A missing `git` binary is treated as "not a repository", so the
  command still records, and it counts every row as unjoinable.
