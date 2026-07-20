---
project: canary
created: 2026-07-20
---

# Python / pipx release checklist

Canary ships in **two halves**, and only one of them is covered by harness's
`release-readiness` tooling:

| Half                       | Package (registry)      | Covered by `harness release-readiness`? |
| -------------------------- | ----------------------- | --------------------------------------- |
| npm shim (end-user CLI)    | `canary-test-cli` (npm) | **Yes** — it audits the npm package     |
| Python engine (pipx / pip) | `canary-test-ai` (PyPI) | **No** — audits nothing here            |

`harness release-readiness` inspects the npm package only, so the Python/pipx
half needs this manual checklist (#337). npm is the **canonical** end-user
install; PyPI/pipx is the secondary path used to run the engine directly.

---

## Pre-release (any tag)

- [ ] **Version parity.** Bump the version in **both** `pyproject.toml` and
      `npm/package.json` to the same value. CI's `npm/pyproject version parity`
      check fails the build if they drift.
- [ ] **Suites green.** `python3 -m pytest tests/unit -q` and, for npm changes,
      `cd npm && npm run build -s && npm test`.
- [ ] **Lint clean.** `ruff check agent tests`; `markdownlint` on touched docs.
- [ ] **De-identification clean.** `python3 scripts/check_removed_symbols.py`
      prints `clean` (no removed-symbol or proprietary leaks).
- [ ] **CHANGELOG** updated for the release.

## Cut the release

- [ ] Tag `v<version>` and push it. `.github/workflows/release.yml` then runs:
  - `build-binaries` — PyInstaller binaries for linux-x64 / darwin-arm64 /
    win32-x64.
  - `publish` — creates the GitHub Release with the binaries **and**
    `npm publish --access public --provenance` (`canary-test-cli`).
  - `publish-pypi` — builds the sdist + wheel from `pyproject.toml` and uploads
    `canary-test-ai` to PyPI via **Trusted Publishing (OIDC)**.

## Python-half gotcha: PyPI Trusted Publishing must be configured

The `publish-pypi` job is intentionally **non-fatal** — a PyPI misconfiguration
must not red-fail a release whose npm half succeeded. The trade-off: if PyPI
Trusted Publishing is **not** set up, the job **silently skips** and no new
`canary-test-ai` version reaches PyPI, so `pip install canary-test-ai` /
`pipx install canary-test-ai` keep serving the last published version (or 404 if
none was ever published).

**One-time setup (do this to actually ship the Python half):** on `pypi.org` →
the `canary-test-ai` project → _Publishing_, register a Trusted Publisher for
this repository's `release.yml` workflow (environment as configured in the job).
Until then, treat the Python/pipx half as **not released** regardless of a green
pipeline.

## Post-release verification

- [ ] npm: `npm view canary-test-cli version` shows the new version.
- [ ] GitHub Release exists with all three platform binaries attached.
- [ ] PyPI (only if Trusted Publishing is configured):
      `pip index versions canary-test-ai` (or
      `pip install canary-test-ai==<version>`) shows the new version. If it does
      not, confirm the Trusted Publisher is registered — a skipped
      `publish-pypi` job is the usual cause.

---

## Related

- `.github/workflows/release.yml` — the pipeline this checklist tracks.
- [CLI Deprecation](../specs/cli-deprecation.md) — why npm is the canonical
  install and pipx prints a pointer.
