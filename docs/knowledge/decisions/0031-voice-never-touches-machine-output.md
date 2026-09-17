---
number: 0031
title: Voice never touches machine-readable output
date: 2026-09-17
status: accepted
tier: medium
source: docs/changes/340-voice-pack/proposal.md
---

<!-- markdownlint-disable-file MD025 -->

# ADR 0031 — Voice never touches machine-readable output

**Status:** accepted **Date:** 2026-09-17 **Deciders:** Bri Stevenski
**Related:** docs/changes/340-voice-pack/proposal.md (invariant, F2, F3, F5,
criteria 1-8); `voice/lines.json`;
[`voice.mjs`](../../../agents/skills/claude-code/canary-test-reporter/scripts/voice.mjs)

## Context

Canary has character voice profiles (`voice/profiles/*.md`) and an off-switch
(`CANARY_NO_FLAVOR`), but until #340 no output a user saw carried a voiced line.
Wiring voice into real surfaces, on by default (F2), puts it next to outputs
other programs parse: JSON reports, exit codes, CI annotations. A voiced line
that leaks into any of those turns cosmetic text into a breaking change for a
consumer that never asked for flavor.

## Decision

Voice is presentation only. On every surface, now and later:

- **JSON outputs** (`--json`, `--json-out`, `run.json`, MCP tool results) are
  byte-identical with flavor on and off.
- **Exit codes** are identical with flavor on and off.
- **Annotation lines** (`::error`, `::warning`, `::notice`) carry no voiced
  text.
- **A voiced line is never the only carrier of a fact.** Removing every voiced
  line leaves a report that states the same results.
- **Resolution failure is silent.** A missing or malformed lines file, or an
  unknown profile or moment, yields the unvoiced output with an unchanged exit
  code.

Mechanics adopted with it:

- Lines live in `voice/lines.json` keyed by profile and moment (F3), not parsed
  out of profile prose. A self-contained skill ships a byte-identical copy, held
  equal by a test.
- A line is chosen from the output's own counts (F5), so identical results give
  an identical line and snapshot tests stay stable.
- Off-switch: `CANARY_NO_FLAVOR` or `NO_FLAVOR` truthy, or a `--no-flavor` flag
  where the surface has a CLI.
- A surface appends voice **after** its machine outputs are built, so the code
  path that produces them never sees it.

## Consequences

- Every new voiced surface must ship the invariant tests: JSON SHA equality and
  exit-code equality across flavor on and off, and no voiced text in
  annotations.
- A profile's own rules still bind: Black Canary is the alarm voice and "never
  for green runs", so the test reporter's footer is silent on a passing run.
- Voice resolution is per surface (F4a). Project-level selection through
  `.canary/voice.md` is not wired to engine surfaces yet.
