---
project: canary
created: 2026-07-17
---

# `doctor.json` schema reference

An overlay can ship a check manifest at `.canary/doctor.json` in its repository.
`canary doctor` reads the manifest from each tracked overlay's clone and runs
the checks it declares, reporting each with the manifest's own `remedy` on
failure. This lets an overlay author say "here is what a healthy setup looks
like for my users" as data, without changing the engine.

See the [`canary doctor` reference](doctor.md) for how these checks are run,
filtered, and gated.

---

## Shape

```json
{
  "checks": [
    {
      "id": "skills-present",
      "type": "file-exists",
      "path": ".canary/skills",
      "remedy": "This overlay is missing its skills directory — re-clone it.",
      "persona": ["alpha"]
    },
    {
      "id": "api-reachable",
      "type": "url-reachable",
      "url": "https://api.example.com/health",
      "remedy": "Check your network / VPN, or set the API base URL in .canary/company.json."
    },
    {
      "id": "smoke-test",
      "type": "command-succeeds",
      "command": ["npm", "run", "smoke"],
      "remedy": "Install dependencies (npm ci) before running doctor.",
      "persona": ["beta"]
    }
  ]
}
```

The top-level value must be an object with a `checks` array. Anything else — a
non-object, a missing or non-array `checks`, an invalid check entry, or a file
that does not parse as JSON — degrades to a **single** failing check that names
the error and the manifest path. A missing manifest is not an error (the overlay
simply contributes no tier-2 checks).

---

## Common fields (every check)

| Field     | Required | Description                                                                                                                                                         |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | yes      | Non-empty string. Stable identifier shown on the check line.                                                                                                        |
| `type`    | yes      | One of `file-exists`, `url-reachable`, `command-succeeds`.                                                                                                          |
| `remedy`  | yes      | Non-empty string. Shown indented under the line when the check fails.                                                                                               |
| `persona` | no       | Array of free-form strings. A check with no `persona` runs for every persona; otherwise it runs only when `--persona <tag>` matches one of them (case-insensitive). |

---

## Check types

### `file-exists`

| Field  | Required | Description                                                                       |
| ------ | -------- | --------------------------------------------------------------------------------- |
| `path` | yes      | Path **relative to the overlay clone**. Passes when the file or directory exists. |

### `url-reachable`

| Field | Required | Description                                                                                                                                 |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `url` | yes      | An HTTP(S) URL. Passes on a `2xx`/`3xx` response (redirects followed); a connection error, a non-2xx/3xx status, or a timeout is a failure. |

### `command-succeeds`

| Field     | Required | Description                                                                                                                                          |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command` | yes      | A non-empty **argv array** (e.g. `["npm", "run", "smoke"]`). Run in the clone directory, **without a shell**, under a timeout. Exit code `0` = pass. |

> **Argv only — no shell.** The command is an array, not a shell string, so a
> cloned manifest cannot inject shell syntax. Chain steps with a script the
> overlay ships (e.g. `["npm", "run", "smoke"]`), not with `&&`, pipes, or
> globs.

---

## Trust model for `command-succeeds`

`command-succeeds` is the only check type that runs a command from a cloned
repository, so it executes **only with recorded consent**:

- On `canary overlay add`, if the manifest declares any `command-succeeds`
  checks, the command list is printed and you must confirm. The decision is
  stored in `overlays.json` alongside a fingerprint of the command set.
- Without consent, those checks are reported as **skipped**, not failed — every
  other check type still runs.
- If a later `canary overlay update` changes the `command-succeeds` set, the
  fingerprint no longer matches and consent is treated as **not granted** until
  you re-confirm. A changed command never runs under stale consent.

---

## Timeouts

Every `url-reachable` and `command-succeeds` check runs under a bounded timeout.
A check that hangs fails its own line at the timeout and does not delay the
engine checks or any other overlay's checks.

---

## Authoring notes

- Keep `id`s stable — they are how a user reading a failure maps it back to your
  manifest.
- Write `remedy` as an imperative the user can act on ("Run `npm ci`", "Set
  `apiBaseUrl` in `.canary/company.json`"), not a restatement of the failure.
- `persona` tags are yours to define. Document them in your overlay's own docs;
  Canary neither validates nor interprets the strings.
