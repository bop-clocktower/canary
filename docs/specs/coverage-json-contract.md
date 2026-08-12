---
project: canary
version: 1
created: 2026-07-24
---

# Coverage-JSON Contract (`coverage.json` v1)

> The coverage format the PR guardian consumes at its highest fidelity tier.
> `canary guardian pr-check` reads a coverage report and maps changed lines to
> covered/uncovered; when the report is this JSON shape, findings are labeled
> **coverage-verified** (the strongest tier). Any tool that can emit per-line
> hit data — a coverage plugin, a CI post-processor, a bespoke script — can
> produce a canary-consumable report by following this contract, instead of
> canary having to learn every tool's native format.
>
> Validate a file against this contract with
> `canary guardian validate-coverage <file>`.

## Shape

```json
{
  "schema_version": 1,
  "files": {
    "src/pkg/orders.py": {
      "line_hits": { "12": 3, "13": 1, "14": 0 },
      "covered_lines": [12, 13],
      "instrumented_lines": [12, 13, 14]
    },
    "src/pkg/util.py": {
      "line_hits": { "1": 5, "2": 5 }
    }
  }
}
```

## Fields

| Field                            | Type             | Notes                                                                                                                                                                        |
| -------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`                 | int _(optional)_ | `1`. Omit to default to `1`. A version this build doesn't understand → the whole document is refused (see Conventions). Bumped only on a breaking change; evolve additively. |
| `files`                          | object           | **Required.** Maps a file path to that file's coverage. Empty object is valid.                                                                                               |
| `files[path]`                    | object           | Per-file coverage. One or both of `line_hits` / `covered_lines`.                                                                                                             |
| `files[path].line_hits`          | object _(opt.)_  | `{ "<line>": <hits> }` — line number (as a string key) → execution count.                                                                                                    |
| `files[path].covered_lines`      | int[] _(opt.)_   | Line numbers with `hits >= 1`. Shorthand; cannot express an unhit line.                                                                                                      |
| `files[path].instrumented_lines` | int[] _(opt.)_   | Lines the tool measured. Declaring it makes a changed line **outside** the set not coverable rather than uncovered ([#657]).                                                 |

## Declaring what you measured (`instrumented_lines`)

Added in [#657]. **Optional and additive** — a document without it is read
exactly as before, so no existing producer changes behaviour.

Without it this format cannot say "this line was never instrumented", only "this
line is not covered". The two are very different downstream: the consumer counts
a changed line it cannot account for as a coverage miss, so a comment, an
import, or a `type` declaration in a new file becomes a reported gap at the
`coverage-verified` label. A producer transcoding lcov into this format hits
that squarely, because lcov's non-instrumented lines simply have no record to
transcode.

Declaring the set fixes it:

```json
{
  "files": {
    "src/new_module.ts": {
      "line_hits": { "10": 3, "11": 0 },
      "instrumented_lines": [10, 11, 12]
    }
  }
}
```

| Line   | Verdict         | Why                                          |
| ------ | --------------- | -------------------------------------------- |
| `10`   | covered         | recorded, 3 hits                             |
| `11`   | uncovered       | recorded, 0 hits — a real miss               |
| `12`   | uncovered       | declared instrumented, no hit record         |
| `1..9` | _not coverable_ | outside the declared set — scored by neither |

Rules:

- **`line_hits` stays authoritative.** A `{"11": 0}` line remains uncovered even
  if `covered_lines` also lists it; declaring instrumentation is not a way
  around that frozen rule.
- **A recorded line outside the declaration is still coverable.** Real
  measurement outranks a declaration that disagrees with it — dropping the line
  would discard a hit count the producer actually took. The validator warns.
- **A malformed declaration is ignored**, not fatal: the entry falls back to the
  rules below, matching the parser's leniency everywhere else.
- **If no changed line is coverable**, the guardian abstains for that file and
  falls through to a lower-fidelity tier — never a clean pass, never a finding.

`canary guardian validate-coverage` warns when a document leans on
`covered_lines` without declaring `instrumented_lines` and without recording any
unhit line, because that document cannot express a miss at all. It is advisory;
only `--strict` turns warnings into a non-zero exit.

## Conventions (frozen)

- **`line_hits` is authoritative and the preferred field.** Keys are line
  numbers written as JSON strings (JSON object keys must be strings); values are
  execution counts. `"14": 0` means **instrumented but unhit** — a genuine
  uncovered line, distinct from a line that was never instrumented.
- **`covered_lines` is a convenience shorthand** for "these lines ran at least
  once." A line listed here is treated as `hits >= 1`. It **cannot** express an
  unhit line, so a producer that knows its zero-hit lines should use `line_hits`
  to surface them.
- **`line_hits` is authoritative when both fields are present.** `covered_lines`
  may _add_ a line that `line_hits` didn't mention, but it never overrides an
  explicit `line_hits` entry — so a line recorded as `{"14": 0}` (unhit) stays
  uncovered even if `covered_lines` also lists `14`. Listing the same line in
  both with contradictory intent is a producer bug the validator warns on; never
  rely on `covered_lines` to "upgrade" an unhit line.
- **Line numbers are 1-based** and must be `>= 1`. **Hit counts** must be
  `>= 0`. Both must be genuine JSON **integers** — a string (`"3"`), float
  (`3.0`), or boolean is rejected rather than coerced, so a producer never
  silently truncates a fractional count or slips a `true` through as `1`.
  (Because JSON object keys are always strings, `line_hits` keys are the integer
  written as a string — `"12"` — and are parsed back to an int.)
- **A line absent from both fields is treated as uncovered** (`hits = 0`) by the
  consumer, **unless `instrumented_lines` says otherwise**. Only record the
  lines you have data for; you need not enumerate every source line.

  Without a declaration this is the **opposite** of how the consumer reads lcov
  and Cobertura, and the difference is deliberate. Those formats enumerate every
  line they _instrumented_, so a line they never mention could not have been
  executed by anything — a comment, an import, a type declaration — and is
  excluded from both sides of the ratio rather than counted as a miss ([#655]).
  This format makes no such promise by default: `covered_lines` cannot express
  an unhit line, so absence is the only way a producer using the shorthand can
  report one.

  The consequence for producers is worth stating plainly: **a producer
  transcoding lcov into this format loses the distinction** unless it says so,
  and its non-instrumented lines will be reported as coverage gaps. Pick one:
  declare `instrumented_lines` (the direct fix, see above), emit `line_hits`
  with explicit `0` entries for genuinely-unhit lines and omit the rest, or hand
  the guardian the lcov directly.

- **Paths** are matched against the diff by path-suffix on a separator boundary,
  so a report path may carry a leading source root the diff path lacks
  (`src/main/java/…/Foo.java` resolves a `…/Foo.java` unit). Repository-relative
  paths are recommended.
- **Unknown _fields_ are ignored** (additive-safe): a future minor revision may
  add keys, and a v1 consumer skips ones it doesn't recognize rather than
  rejecting. This is distinct from an unknown **`schema_version`** — a version
  bump signals a _breaking_ change, so a document whose `schema_version` this
  build doesn't understand is refused whole (the consumer falls through to a
  lower fidelity tier) rather than partially consumed and mislabeled.

## Producer feedback (why validate)

The consumer (`ts/src/guardian/diff-coverage/formats/coverage-json.ts`,
re-exported from `ts/src/guardian/coverage.ts`) is deliberately **lenient**: a
file entry that isn't an object, a non-integer hit value, or a non-integer line
is silently skipped so one malformed row never sinks a whole report. The cost is
silence — a producer emitting a slightly-wrong shape sees its coverage quietly
degrade to a lower fidelity tier with no error.

`canary guardian validate-coverage <file>` is the loud counterpart. It reports,
at two severities, exactly what the parser would discard:

- **error** — the document (or a file entry) is structurally unusable; that
  coverage is **lost**. Exit code `1`.
- **warning** — a sub-part (a bad line or value) is ignored but the rest is
  used; coverage is **degraded**, not lost. Exit code `0` (or `1` under
  `--strict`).

A missing or non-JSON file exits `2`. Add the command to a producer's CI to
catch drift before canary silently downgrades the report.

## Consumers

- `canary guardian pr-check` (`--coverage <file>`) — resolves changed-line
  coverage at the **coverage-verified** tier from this format (also accepts
  `lcov.info` and Cobertura `coverage.xml`; see
  [PR Guardian](../guides/pr-guardian.md)).

The format is generic — it names only file paths, line numbers, and hit counts,
with no project-, employer-, or client-specific content.

[#655]: https://github.com/bop-clocktower/canary/issues/655
[#657]: https://github.com/bop-clocktower/canary/issues/657
