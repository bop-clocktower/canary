# canary evidence export

Write one evidence pack for a time window from outputs canary already produced,
with each item mapped to the controls it supports.

An audit asks for evidence that a written process was followed: a fix was
verified, a skipped test had an owner and a reason, a gate ran. Canary already
records that in four places. `canary evidence export` reads them for a window
and writes `evidence-pack.json` for GRC tooling and `evidence-pack.md` for a
reviewer (#855).

> This mapping is an aid, not an attestation. Canary cannot certify compliance.
> A listed item shows that a check ran and what it recorded; it does not show
> that a control is met.

The same text is in both files. The pack lists evidence and counts it. It has no
score, and it never says a control is met.

## Usage

```bash
canary evidence export --since 2026-01-01
canary evidence export --since 2026-01-01 --until 2026-04-01
canary evidence export --since 2026-01-01 --repo acme/widgets --out packs/q1
canary evidence export --since 2026-01-01 --batwoman saved-reports
```

| Flag         | Default                     | Meaning                                |
| ------------ | --------------------------- | -------------------------------------- |
| `--since`    | required                    | Window start, included                 |
| `--until`    | the time of the export      | Window end, not included               |
| `--root`     | current directory           | Repository the sources are read from   |
| `--batwoman` | `<root>/.canary/batwoman`   | Directory of saved batwoman reports    |
| `--out`      | `<root>/.canary/evidence`   | Where the two files are written        |
| `--repo`     | `GITHUB_REPOSITORY`, if set | `owner/name`, used only to build links |

A date is `YYYY-MM-DD` (midnight UTC) or a date-time that ends in `Z` or an
offset such as `+02:00`. A date-time with no zone is refused, because it would
mean a different window on a different machine.

The window is half-open: an item dated exactly at `--since` is in, and one dated
exactly at `--until` is out. Two packs whose windows meet never count an item
twice. An export overwrites the pack already in `--out`.

## Sources

| Source     | Read from                                      | One item per | Dated at           |
| ---------- | ---------------------------------------------- | ------------ | ------------------ |
| `batwoman` | `*.json` in the batwoman directory             | saved report | `mergedAt`         |
| `katana`   | `<root>/.canary/quarantine.json`               | ledger row   | `date`             |
| `history`  | `<root>/test-results/reports/history-v2.jsonl` | recorded run | `timestamp`        |
| `ci-ready` | the `canary ci-ready` scorer, run at export    | export       | the export instant |

The export reads local files and makes no network call. Batwoman needs `gh`, so
its reports are saved ahead of time, one file per issue:

```bash
mkdir -p .canary/batwoman
canary batwoman --issue 12 --json > .canary/batwoman/12.json
```

Two saved reports for one issue are two items, and each names its file.

The `ci-ready` item is dated at the export and linked to the `HEAD` commit of
`--root`. Because the default window ends at the export itself, this one item
counts as inside the window when the export time equals `--until`.

Every source is listed in both files with one of five states:

- `read`: read in full. The count of items in the window may still be 0.
- `partial`: read, but some records had no usable date or no identifier, or a
  file in the batwoman directory was not a report. The reason names each.
- `absent`: nothing at the default path, or `ci-ready` had no input to score.
- `unreadable`: the file exists and cannot be used. The reason names the errno
  code, the corrupt line, or the missing `HEAD` commit.
- `out-of-window`: `ci-ready` only. The export ran outside the window.

Every state but `read` carries a reason. A source that cannot be read is
reported, never skipped, and the rest of the pack is still written.

## Controls

The catalogue is data:
[controls.json](../../ts/src/data/evidence/controls.json). Each row names the
sources that support it.

| Control id             | Reference                                | Sources                   |
| ---------------------- | ---------------------------------------- | ------------------------- |
| `nist-800-40r4-2.3.3`  | NIST SP 800-40 Rev. 4, 2.3.3             | batwoman                  |
| `nist-800-40r4-2.3.4`  | NIST SP 800-40 Rev. 4, 2.3.4             | history, ci-ready         |
| `iso-27001-2022-a.8.8` | ISO/IEC 27001:2022 Annex A 8.8           | batwoman, history         |
| `cis-v8-7`             | CIS Controls v8, Control 7 (7.2 and 7.7) | batwoman                  |
| `soc2-cc7.1`           | SOC 2 CC7.1                              | history, ci-ready         |
| `soc2-cc8.1`           | SOC 2 CC8.1                              | history, katana, ci-ready |

Every row is in every pack. A control whose sources produced no item in the
window has `"status": "no-evidence"` in the JSON and reads `NO EVIDENCE` in the
Markdown, next to the state of each source it depends on. An empty row is never
dropped, because a pack that hides its gaps would mislead the person it is
handed to.

## What an item carries

- `at`: the time it is dated at.
- `summary`: what the source recorded. A run carries its counts and never its
  failure text, which can hold secrets. A ledger row carries the author the
  ledger recorded and its cause, when the cause is one canary-katana defines; a
  cause it does not define is printed as `unrecognised cause`. A row with no
  cause carries the reason the ledger derived from the commit subject. A
  batwoman report carries its per-file statuses, including `not-exercised`.
- `ref`: a run id, a ledger key `file::test`, or a commit SHA, so the item can
  be found again in its source. A commit gets a GitHub URL only from the
  repository you gave (`--repo`, else `GITHUB_REPOSITORY`) and a full SHA. A
  `repo` field inside a saved report is never linked to; when it differs from
  yours, the item says it is unverified. A URL is never guessed from a git
  remote.
- `controls`: the catalogue ids the item supports.

A failed run, a `not-ready` score and a report whose files were never exercised
are all items. The pack does not choose what an auditor sees.

The Markdown lists at most 25 items per source, newest first, and then says how
many more are in the JSON. The JSON holds all of them.

## Untrusted text

Ledger rows, run records and saved reports are written by other tools and by
people, and the pack is read by auditors and by agents. So every value that came
from a source is printed as inert text:

- In the Markdown, the characters Markdown and HTML read as syntax are written
  as numeric entities (`|` becomes `&#124;`), control characters and newlines
  become a space, and ids and commits sit in code spans a backtick cannot close.
  A viewer shows the original text; nothing becomes a heading, a link, an image
  or an extra table cell.
- A commit link is written only for the exact
  `https://github.com/<owner>/<name>/commit/<sha>` form.
- On stdout and stderr, each message stays on one line, with control and ANSI
  sequences removed and long text clamped.
- The window, the export time and the commit are checked before anything is
  rendered. A value that is not an ISO 8601 instant or a hex SHA is a usage
  error.

The JSON file holds the values as recorded. JSON encoding keeps them as data.

## Exit codes

- `0`: the pack was written. This includes a pack with no items at all, which
  prints an `Abstained` warning line naming each source's state and the first
  step to take.
- `2`: usage error. A date that is not ISO 8601, a `--since` that is not before
  `--until`, a `--root` or `--batwoman` path that does not exist, or a `--repo`
  that is not `owner/name`. A path you typed that is missing is treated as a
  typo; only a missing default path is `absent`.
- `1`: the pack could not be written. The message names the directory and the
  errno code.

The command is advisory. It gates nothing.

## Where the code lives

- [cli.ts](../../ts/src/evidence/cli.ts): flags, the window, the `ci-ready`
  item, writing the files.
- [sources.ts](../../ts/src/analysis/evidence/sources.ts): the three file
  readers and the catalogue loader.
- [pack.ts](../../ts/src/analysis/evidence/pack.ts): maps items to controls and
  builds the pack.
- [render.ts](../../ts/src/analysis/evidence/render.ts): the Markdown report.
- [types.ts](../../ts/src/analysis/evidence/types.ts): the pack's shapes.
