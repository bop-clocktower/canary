# Knowledge Gap Report

Generated: 2026-05-17 | Pipeline run: 2 (--fix applied) | Convergence: 1 iteration

## Remediation Summary

| Action | Count | Entries |
|--------|-------|---------|
| Staged (new) | 95 | business rules, concepts, test descriptions across 9 new domains |
| Removed (stale) | 2 | deleted generated test files from tests/generated/ |
| Updated (drifted) | 3 | TestTestExecutor → TestOracleTestExecutor (PR #44) |
| Contradicting | 0 | none |

## Domain Summary

| Domain | Entries | Types |
|--------|---------|-------|
| classifier | 5 | business_rule |
| framework | 4 | business_concept |
| cli | 5 | business_concept |
| provider | 5 | business_concept |
| executor | 3 | business_rule (names updated) |
| orchestrator | 4 | business_rule, business_concept |
| selector_healer | 36 | business_rule, business_concept, test descriptions |
| migrator | 44 | business_rule, business_concept, test descriptions |
| reporter | 3 | business_rule, business_concept |
| ci_env | 2 | business_rule, business_concept |
| ide_plugins | 7 | business_concept (from spec) |
| domain_scanner | 0 | test descriptions not yet staged (34 pending) |
| metadata_scanner | 0 | test descriptions not yet staged (24 pending) |
| pattern_matcher | 0 | test descriptions not yet staged (48 pending) |
| **Total staged** | **108** | |

## Remaining Coverage Gaps

### No diagram coverage
No `.mmd`, `.d2`, `.puml`, or `.plantuml` files found. The core
orchestration flow (classify → recommend → generate → execute → heal),
the selector-healing fork (selector path vs symbol-grep path), and the
migration flow (detect → dry-run → apply) have no diagram-as-code
representation. Consider adding a `docs/diagrams/` directory.

### domain_scanner / metadata_scanner / pattern_matcher test descriptions not staged
106 test descriptions from these 3 modules were detected as `new` but
not staged in this run (they cover Project Intelligence internals). Stage
in the next `--fix` pass or author domain entries directly.

### No connector integrations
No Jira, Slack, or Confluence connectors configured.

## Verdict

**PASS** — 0 stale, 0 drifted, 0 contradicting after remediation.
108 total knowledge entries across 11 active domains.
