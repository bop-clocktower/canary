# Security Ledger

<!-- markdownlint-disable-file MD013 -->

Auto-generated summary of `.harness/security/timeline.json`
and `.harness/security/supply-chain.json`.
Do not edit by hand — run `node scripts/security_ledger.mjs`
to refresh.

## Latest Snapshot

- **Captured:** 2026-11-06T22:23:43.378Z
- **Commit:** `30e21eb77bb8`
- **Score:** 99
- **Findings:** 3 (error: 0, warning: 1, info: 2)
- **Supply chain:** 0 (critical: 0, high: 0, moderate: 0, low: 0, info: 0) across 3 lockfiles, audited 2026-11-06 at `30e21eb77bb8`
- **Suppressions:** 0

## Recent Snapshots (last 10)

| Captured | Commit | Score | Findings | Err/Warn/Info |
| --- | --- | ---: | ---: | --- |
| 2026-07-01T01:42:23 | `bf91dc4` | 100 | 2 | 0/0/2 |
| 2026-07-01T03:56:47 | `dc14ff8` | 100 | 2 | 0/0/2 |
| 2026-07-01T05:44:28 | `a55dd93` | 100 | 2 | 0/0/2 |
| 2026-07-08T01:29:10 | `6657838` | 100 | 2 | 0/0/2 |
| 2026-07-18T22:39:06 | `b82e007` | 97 | 9 | 0/1/8 |
| 2026-07-18T23:43:07 | `72fa4f5` | 79 | 15 | 6/1/8 |
| 2026-07-26T18:52:34 | `f438109` | 78 | 10 | 7/0/3 |
| 2026-07-27T23:27:13 | `c025931` | 100 | 0 | 0/0/0 |
| 2026-10-19T16:44:02 | `78ab2be` | 100 | 0 | 0/0/0 |
| 2026-11-06T22:23:43 | `30e21eb` | 99 | 3 | 0/1/2 |

## Open Findings

- **SEC-PTH-001** (warning, path-traversal) — `ts/src/history/ndjson-store.ts` first seen 2026-11-06T22:23:43
- **SEC-NET-003** (info, network) — `ts/src/core/scaffold-templates.ts` first seen 2026-11-06T22:23:43
- **SEC-NET-003** (info, network) — `npm/scripts/__tests__/testtracker-perf-cli.test.js` first seen 2026-11-06T22:23:43

## Stats

- Total snapshots recorded: 30
- Findings resolved (lifetime): 19
- Findings open: 3
