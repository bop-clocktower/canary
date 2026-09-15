# Schemathesis spike (kept on purpose)

This directory is the recorded spike that led canary to adopt Schemathesis
(Issue #131, PR #194). It ran Schemathesis against `POST /v1/checkout` from
`examples/pytest-api-checkout` and found two bugs the hand-written suite missed.
[`SPIKE_REPORT.md`](SPIKE_REPORT.md) has the findings.

It stays for two reasons:

- It is exploration history, not dead code. ADR 0012
  (`docs/knowledge/decisions/0012-entropy-ratchet.md`) records keeping it:
  deleting a recorded spike is not a cleanup.
- `docs/roadmap-archive.md` links to its report as the evidence for adopting
  Schemathesis.

The two `.py` files are the spike's own harness. They are **not** canary engine
code: the Python engine was removed in the v6 cutover, and nothing in `ts/` or
CI imports or runs them. Schemathesis support itself lives in
`ts/src/data/frameworks/registry.json`.
