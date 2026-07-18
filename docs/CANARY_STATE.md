# Canary — Current State

Canary ships as a Claude Code plugin (four personas: `canary-test-author`,
`canary-test-reviewer`, `canary-framework-advisor`, `canary-flake-hunter`)
plus a deterministic CLI (`canary recommend/init/run/migrate/version`). See
the [README](../README.md) for installation and usage, and
[roadmap.md](roadmap.md) for planned and in-progress work.

This file is the project ledger — Canary skills append a one-line entry
below after generating, promoting, or setting up test infrastructure, so
downstream sessions can pick up context without re-deriving it.

## Log

<!-- Skills append one-line entries here, e.g.:
     2026-07-18 — canary-generate-test: login-flow.spec.ts generated
     (playwright), pass
     2026-07-18 — canary-setup-harness: harness setup completed
     (commit 8a039e4) -->
