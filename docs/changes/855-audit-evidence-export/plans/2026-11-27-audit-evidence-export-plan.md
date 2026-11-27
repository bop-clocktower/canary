# Plan: Audit evidence export (control-mapped evidence pack)

**Date:** 2026-11-27 | **Spec:**
docs/changes/855-audit-evidence-export/proposal.md | **Tasks:** 12 | **Time:**
~55 min | **Integration Tier:** medium | **Checkpoints:** 0

## Goal

`canary evidence export --since <date>` reads the four outputs canary already
produces for a time window and writes `evidence-pack.json` and
`evidence-pack.md`, with every catalogue control and every source listed whether
or not it has evidence.

## Observable Truths (Acceptance Criteria)

The numbers match the spec's twelve success criteria.

1. When a control's mapped sources have no item in the window, the system shall
   list that control with `status: "no-evidence"` in the JSON and `NO EVIDENCE`
   in the Markdown. With every source empty, all six controls appear in both
   formats. Tasks 2, 3, 8.
2. When the history store is corrupt, the system shall still write the pack,
   report the history source as `unreadable` with the line named, and keep the
   items of controls fed by other sources. Tasks 3, 8.
3. When a default source path is missing, the system shall report that source as
   `absent` with a reason. If `--batwoman` names a missing directory, then the
   system shall not write a pack and shall exit 2. Tasks 3, 4, 8.
4. The system shall give every item in the JSON a `ref` with a non-empty `id`
   and at least one control id, across all four sources. Tasks 3, 4, 8.
5. The system shall carry the disclaimer text in both formats. Task 2.
6. When an item is dated exactly at `--since`, the system shall include it; when
   it is dated exactly at `--until`, the system shall exclude it. Task 3.
7. When `--until` is omitted, the system shall end the window at the export time
   (fixed clock, flag omitted). Task 8.
8. When 500 runs are in the window, the Markdown shall list 25 run items and
   state that 475 more are in the JSON, and the JSON shall hold all 500. Task 5.
9. When no source produced an item, the system shall exit 0, write the pack, and
   print a warning line naming the cause and the first fix step. Tasks 6, 8, 9.
10. When a second export writes into the same `--out`, the system shall replace
    the first pack; no item from the first survives. Tasks 6, 8.
11. When a batwoman report's files are all `not-exercised`, the system shall
    list it as an item with those statuses in its summary. The pack shall hold
    no `passed`, `score` or `compliant` field. Tasks 2, 4.
12. `npm run build`, `typecheck`, `format:check` and `test` pass from `ts/`, and
    the arch, perf, entropy and docs ratchets pass with no allowance and no
    baseline edit. Task 12.

## Assumptions

No human was available. Each question the skill would have asked was answered
with its recommended option and is recorded here so a reviewer can overturn it.

- **A1. The `ci-ready` item is inside the window when
  `since <= export time <= until`.** The spec contradicts itself here: D3 makes
  the window half-open and defaults `--until` to the export time, and D10 dates
  the one `ci-ready` item at the export time. Read literally, a default export
  would always report `ci-ready` as `out-of-window`. Recommended option taken:
  dated records keep the half-open rule (criterion 6), and the single `ci-ready`
  item is closed at `until`. If this is rejected, Task 8's `ciReadySource` and
  its three `ci-ready` tests change.
- **A2.** When every `ci-ready` check skipped, the source is `absent` with the
  reason `no check scored`. D10 says only that it yields no item.
- **A3.** `ci-ready` states are decided in this order: `out-of-window`, then
  `unreadable` (no `HEAD`), then `absent`, then `read`. The scorer runs only
  when the first two do not apply.
- **A4.** `out-of-window` is used for `ci-ready` only, where D10 defines it. A
  file source that read records but has none in the window is `read` with
  `inWindow: 0`.
- **A5.** A record with a date but no identifier (a run with no `run_id`, a
  ledger row with no `file` or no `test`) is not an item. It makes the source
  `partial` with the count named. This is what keeps criterion 4 true.
- **A6.** A date-time with no zone (`2026-01-01T10:00`) is a usage error. It
  would mean a different window on a different machine.
- **A7.** Source paths in the pack are root-relative (`.canary/batwoman`), so an
  auditor does not receive a home directory. A typed `--batwoman` directory is
  printed as typed.
- **A8.** A commit URL is built only from an `owner/name` slug and a hex SHA. A
  `--repo` or `GITHUB_REPOSITORY` value that is not a slug exits 2. A malformed
  `repo` field inside a batwoman report yields no URL.
- **A9.** A `--batwoman` path that exists but is not a directory is
  `unreadable (ENOTDIR)`, not exit 2. D9 covers a path that does not exist.
- **A10.** Items are ordered newest first, with source and id breaking ties, so
  two exports of the same files list the same order.
- **A11.** The catalogue is read at runtime, not imported. `ts/tsconfig.json`
  has no `resolveJsonModule`, and `ts/scripts/copy-data.mjs` already ships
  `src/data/` to `dist/data/`.
- **A12.** The skeleton and the plan sign-off were taken automatically.

## Uncertainties

- [ASSUMPTION] The entropy scan counts a test import as a use, so `buildPack`,
  `renderMarkdown` and `DISCLAIMER` (each imported by a test and used inside
  their own file) are not dead exports. A scan of a copy of `ts/` with the entry
  points that exist there found no new finding. Task 12 measures it for real.
- [ASSUMPTION] The docs-coverage ratchet counts the five Markdown links in the
  guide (Task 10). Task 12 measures it.
- [ASSUMPTION] CI runs the tests on a POSIX runner as a non-root user. Two
  assertions rely on `/` as the separator and one on `chmod 000` being enforced
  (`ts/test/ci-ready-cli.test.ts` already relies on the same).
- [DEFERRABLE] Exact wording of reasons and of the guide. The tests pin only the
  parts a reader acts on.

## Budgets the executor must hold

**Line budget.** New and changed TypeScript under `ts/src` may add at most 480
non-blank lines net. The code in this plan measures 477. There are 3 lines of
slack, so write the code exactly as given and do not add comments.

| File                                  | Non-blank lines |
| ------------------------------------- | --------------- |
| `ts/src/analysis/evidence/types.ts`   | 56              |
| `ts/src/analysis/evidence/sources.ts` | 175             |
| `ts/src/analysis/evidence/pack.ts`    | 85              |
| `ts/src/analysis/evidence/render.ts`  | 99              |
| `ts/src/evidence/cli.ts`              | 61              |
| `ts/src/ci-ready-cli.ts`              | -1              |
| `ts/src/commands/audit/cli.ts`        | +2              |
| **Net**                               | **477**         |

The `ci-ready-cli.ts` change replaces 12 lines of the action with a 10-line
function and a one-line call. Counted as lines added without subtracting the
lines removed, the total is 489. The arch `module-size` metric is a line total,
so the net figure is the one that binds.

**Perf and arch rules for new code.** Cyclomatic complexity at most 10 per
function, nesting at most 4, a function at most 50 lines, a file at most 300.
The analyzer counts each `??` as two branches, which is why `sources.ts` has a
`count` helper. Do not inline it.

**Coupling rule.** Both `harness check-perf` and `harness check-arch` flag a
module when it has more than 5 connections (imports plus importers) and its
imports are more than 70% of them. The same code in a layout with `fs`, `path`
and the three engine modules imported by `ts/src/evidence/cli.ts` was measured
at 12 connections and a ratio of 0.92. `check-arch` reported that as a new
`coupling` violation and `scripts/arch-verdict.mjs` exited 1. The perf allowance
for `ts/src/**/cli.ts` does not cover the arch check. So every new module here
keeps to these import counts. Do not add an import to any of them.

| Module       | Imports                                         | Importers |
| ------------ | ----------------------------------------------- | --------- |
| `types.ts`   | none                                            | 3         |
| `sources.ts` | `node:fs`, gate-result, ndjson-store, types (4) | 1         |
| `render.ts`  | `node:fs`, gate-result, types (3)               | 1         |
| `pack.ts`    | core/ci-ready (type), render, sources, types    | 1         |
| `cli.ts`     | commander, pack, ci-ready-cli, cli-common (4)   | 1         |

## Where this plan departs from the spec's module notes

The behaviour is the spec's. Three placements differ, all forced by the coupling
rule above.

- `evidence/cli.ts` parses the flags, resolves `HEAD` and hands the `ci-ready`
  scorer to the engine. It does not import `node:fs`. The spec has it write the
  files; here `writePack` in `render.ts` writes them and `exportPack` in
  `pack.ts` runs the readers. `buildPack` and `renderMarkdown` stay pure.
- `cli.ts` declares the five seams it uses as a local `Deps` interface, which
  `MainDeps` satisfies, and does not import `main-deps.ts`.
- `sources.ts` joins paths with `/` and reads the catalogue through
  `new URL(..., import.meta.url)`, so it needs neither `node:path` nor
  `node:url`. Node accepts `/` on every platform.

Two smaller points. The spec's `EvidenceRef`, `SourceState` and `ControlRow`
types are written inline in `types.ts`, because a type nothing imports is a
dead-export finding. A `Scope` type (the window, the root, the output directory,
the export time and commit) and an `Outcome` type (exit code and lines) are
added.

## File Map

- CREATE ts/src/data/evidence/controls.json
- CREATE ts/src/analysis/evidence/types.ts
- CREATE ts/src/analysis/evidence/pack.ts
- CREATE ts/src/analysis/evidence/render.ts
- CREATE ts/src/analysis/evidence/sources.ts
- CREATE ts/src/evidence/cli.ts
- MODIFY ts/src/ci-ready-cli.ts (extract `ciReadyReportFor`; the
  `scoreCiReady({...})` call in the action moves into it)
- MODIFY ts/src/commands/audit/cli.ts (one import, one `AUDIT_COMMANDS` entry)
- CREATE ts/test/evidence-pack.test.ts
- CREATE ts/test/evidence-sources.test.ts
- CREATE ts/test/evidence-render.test.ts
- CREATE ts/test/evidence-cli.test.ts
- CREATE ts/test/ci-ready-report-for.test.ts
- MODIFY ts/test/cli-command-registry.test.ts (`'evidence'` after
  `'critical-areas'`, the position `AUDIT_COMMANDS` gives it)
- MODIFY ts/test/gate-conformance.test.ts (one advisory row)
- CREATE docs/guides/audit-evidence-export.md
- MODIFY docs/guides/index.md
- MODIFY AGENTS.md ("Entry Points" command list, line 157)
- MODIFY CHANGELOG.md (`## [Unreleased]`, `### Added`)
- MODIFY docs/roadmap.md (the #855 row's `Plan` field)

No baseline file, allowance file or `harness.config.json` entry changes. The new
modules are reachable from `ts/src/cli.ts` through the audit registry, so they
need no `entryPoints` entry.

## Skeleton

1. Catalogue data and types (1 task, ~3 min)
2. Pack and the Markdown tables, criterion 1 first (1 task, ~5 min)
3. Source readers: history, then ledger and batwoman (2 tasks, ~10 min)
4. Evidence lists with the 25-item cap, then writing the files (2 tasks, ~9 min)
5. The `ci-ready` export, the command, registration (3 tasks, ~14 min)
6. Guide, index, AGENTS.md, CHANGELOG, roadmap (2 tasks, ~7 min)
7. Gates, ratchets and the line budget (1 task, ~7 min)

**Estimated total:** 12 tasks, ~55 minutes. _Skeleton approved: yes, taken
automatically (A12)._

## Tasks

Conventions for every task:

- Work only in `/Users/bs/Github/canary-855`. Use absolute paths.
- Write each file exactly as given. The code is already formatted for prettier
  (single quotes, 80 columns, trailing commas).
- When a step inserts a block above a declaration or appends one to a file,
  leave one blank line between the block and its neighbour.
- Every `npx vitest`, `npx prettier` and `npm run` command in Tasks 1 to 9 runs
  from `/Users/bs/Github/canary-855/ts`. A test command has the form
  `cd /Users/bs/Github/canary-855/ts && npx vitest run test/<file>`.
- If `prettier --check` reports a file, run `npx prettier --write` on that file
  only, then check again.
- `harness validate` and `harness check-deps` run from the repo root,
  `/Users/bs/Github/canary-855`.
- Commit only the task's files: `git -C /Users/bs/Github/canary-855 add` with
  the paths listed in the task header, then `git commit -m` with the message
  given. No co-author trailer. Never `--no-verify`. If a hook fails, fix the
  cause.
- Test files must not call `new Date()` with no argument or `Date.now()`.
  Fixtures are synthetic (`acme/widgets`, `Sam Example`).

### Task 1: Control catalogue and pack types

**Depends on:** none | **Files:** ts/src/data/evidence/controls.json,
ts/src/analysis/evidence/types.ts

This task has no test: it adds data and type declarations only. Task 2's first
test reads the catalogue, and Task 3 pins its contents.

**Step 1.** Create `ts/src/data/evidence/controls.json`:

```json
{
  "controls": [
    {
      "id": "nist-800-40r4-2.3.3",
      "framework": "NIST SP 800-40 Rev. 4",
      "reference": "2.3.3 Verify Deployment",
      "supports": "A fix has executed since it merged",
      "sources": ["batwoman"]
    },
    {
      "id": "nist-800-40r4-2.3.4",
      "framework": "NIST SP 800-40 Rev. 4",
      "reference": "2.3.4 Monitor the Deployed Patches",
      "supports": "Tests kept running after the change",
      "sources": ["history", "ci-ready"]
    },
    {
      "id": "iso-27001-2022-a.8.8",
      "framework": "ISO/IEC 27001:2022",
      "reference": "Annex A 8.8, Management of technical vulnerabilities",
      "supports": "Fixes were verified and changes were tested",
      "sources": ["batwoman", "history"]
    },
    {
      "id": "cis-v8-7",
      "framework": "CIS Controls v8",
      "reference": "Control 7 (Safeguards 7.2 and 7.7)",
      "supports": "Remediation was followed through to a verified result",
      "sources": ["batwoman"]
    },
    {
      "id": "soc2-cc7.1",
      "framework": "SOC 2",
      "reference": "CC7.1, detection and monitoring",
      "supports": "Test runs and readiness checks that detect regressions ran",
      "sources": ["history", "ci-ready"]
    },
    {
      "id": "soc2-cc8.1",
      "framework": "SOC 2",
      "reference": "CC8.1, change management",
      "supports": "Changes were tested; removed and skipped tests were recorded",
      "sources": ["history", "katana", "ci-ready"]
    }
  ]
}
```

**Step 2.** Create `ts/src/analysis/evidence/types.ts` (56 non-blank lines):

```ts
/** Shapes of the audit evidence pack (#855). The pack counts evidence and never grades it. */

export type SourceId = 'batwoman' | 'katana' | 'history' | 'ci-ready';

export interface EvidenceItem {
  source: SourceId;
  at: string;
  summary: string;
  ref: {
    kind: 'commit' | 'run' | 'ledger-entry';
    id: string;
    commit?: string;
    url?: string;
  };
}

export interface SourceReport {
  id: SourceId;
  path: string;
  state: 'read' | 'partial' | 'absent' | 'unreadable' | 'out-of-window';
  reason?: string;
  read: number;
  inWindow: number;
  undated: number;
  items: EvidenceItem[];
}

/** One export: the half-open window `[since, until)`, where it reads and writes, and when and at which commit it ran. */
export interface Scope {
  since: string;
  until: string;
  root: string;
  out?: string | undefined;
  at: string;
  commit: string | null;
  repo?: string | undefined;
  batwoman?: string | undefined;
}

/** What the command prints and exits with: stdout on 0, stderr otherwise. */
export type Outcome = { exit: 0 | 1 | 2; lines: string[] };

export interface CatalogueRow {
  id: string;
  framework: string;
  reference: string;
  supports: string;
  sources: SourceId[];
}

export interface EvidencePack {
  schema: 'canary-evidence-pack/1';
  disclaimer: string;
  generated_at: string;
  window: { since: string; until: string };
  commit: string | null;
  sources: Omit<SourceReport, 'items'>[];
  controls: (CatalogueRow & {
    status: 'evidence' | 'no-evidence';
    items: number;
  })[];
  items: (EvidenceItem & { controls: string[] })[];
}
```

**Step 3.** Run `cd /Users/bs/Github/canary-855/ts && npm run typecheck`. Expect
no errors.

**Step 4.** Run `npx prettier --check src/analysis/evidence/types.ts`.

**Step 5.** Run `harness validate`.

**Step 6.** Commit with this message:

```text
feat(evidence): add the control catalogue and pack types (#855)
```

### Task 2: Pack and Markdown tables, with the empty control first

**Depends on:** Task 1 | **Files:** ts/test/evidence-pack.test.ts,
ts/src/analysis/evidence/pack.ts, ts/src/analysis/evidence/render.ts

Covers criteria 1, 5 and 11. The first `describe` in the test file is criterion
1: it is the first test written in this plan.

**Step 1.** Create `ts/test/evidence-pack.test.ts`:

```ts
/**
 * Evidence pack assembly (#855). The first rule pinned here is the one an
 * auditor is most exposed to: a control with no evidence is still listed.
 * Fixtures are synthetic.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DISCLAIMER, buildPack } from '../src/analysis/evidence/pack.js';
import { renderMarkdown } from '../src/analysis/evidence/render.js';
import type {
  CatalogueRow,
  EvidenceItem,
  Scope,
  SourceId,
  SourceReport,
} from '../src/analysis/evidence/types.js';

const CATALOGUE = (
  JSON.parse(
    readFileSync(
      new URL('../src/data/evidence/controls.json', import.meta.url),
      'utf-8',
    ),
  ) as { controls: CatalogueRow[] }
).controls;

const SOURCE_IDS: SourceId[] = ['batwoman', 'katana', 'history', 'ci-ready'];

const SCOPE: Scope = {
  since: '2026-01-01T00:00:00.000Z',
  until: '2026-06-15T12:00:00.000Z',
  root: '/repo',
  out: '/repo/out',
  at: '2026-06-15T12:00:00.000Z',
  commit: 'a'.repeat(40),
};

function absent(id: SourceId): SourceReport {
  return {
    id,
    path: `.canary/${id}`,
    state: 'absent',
    reason: `nothing at .canary/${id}`,
    read: 0,
    inWindow: 0,
    undated: 0,
    items: [],
  };
}

function withItems(id: SourceId, items: EvidenceItem[]): SourceReport {
  return {
    id,
    path: `.canary/${id}`,
    state: 'read',
    read: items.length,
    inWindow: items.length,
    undated: 0,
    items,
  };
}

function item(source: SourceId, at: string, id: string): EvidenceItem {
  return { source, at, summary: `${source} ${id}`, ref: { kind: 'run', id } };
}

/** Every key at any depth, so a graded field cannot hide in a nested object. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
}

describe('evidence pack with every source empty (criterion 1)', () => {
  const pack = buildPack(SOURCE_IDS.map(absent), SCOPE, CATALOGUE);

  it('lists all six controls as no-evidence in the JSON', () => {
    expect(CATALOGUE).toHaveLength(6);
    expect(pack.controls.map((c) => c.id)).toEqual(CATALOGUE.map((c) => c.id));
    for (const control of pack.controls) {
      expect(control).toMatchObject({ status: 'no-evidence', items: 0 });
    }
  });

  it('prints NO EVIDENCE for all six controls in the Markdown', () => {
    const md = renderMarkdown(pack);
    for (const control of CATALOGUE) {
      const row = md.split('\n').find((l) => l.startsWith(`| ${control.id} |`));
      expect(row, control.id).toContain('NO EVIDENCE');
    }
  });

  it('names each mapped source and its state beside an empty control', () => {
    const md = renderMarkdown(pack);
    const row = md.split('\n').find((l) => l.startsWith('| soc2-cc8.1 |'));
    expect(row).toContain('history: absent (0)');
    expect(row).toContain('katana: absent (0)');
    expect(row).toContain('ci-ready: absent (0)');
  });

  it('lists every source with its state and reason', () => {
    expect(pack.sources.map((s) => s.id)).toEqual(SOURCE_IDS);
    const md = renderMarkdown(pack);
    for (const id of SOURCE_IDS) {
      expect(md).toContain(`| ${id} (.canary/${id}) | absent | 0 | 0 |`);
      expect(md).toContain(`nothing at .canary/${id}`);
    }
  });
});

describe('evidence pack with items', () => {
  const sources = [
    absent('batwoman'),
    withItems('katana', [item('katana', '2026-03-01T00:00:00.000Z', 'k1')]),
    withItems('history', [
      item('history', '2026-02-01T00:00:00.000Z', 'r1'),
      item('history', '2026-04-01T00:00:00.000Z', 'r2'),
    ]),
    absent('ci-ready'),
  ];
  const pack = buildPack(sources, SCOPE, CATALOGUE);

  it('maps each item to the controls its source supports', () => {
    const katana = pack.items.find((i) => i.source === 'katana');
    expect(katana?.controls).toEqual(['soc2-cc8.1']);
    const history = pack.items.find((i) => i.ref.id === 'r1');
    expect(history?.controls).toEqual([
      'nist-800-40r4-2.3.4',
      'iso-27001-2022-a.8.8',
      'soc2-cc7.1',
      'soc2-cc8.1',
    ]);
  });

  it('counts items per control and keeps the empty ones', () => {
    const byId = new Map(pack.controls.map((c) => [c.id, c]));
    expect(byId.get('soc2-cc8.1')).toMatchObject({
      status: 'evidence',
      items: 3,
    });
    expect(byId.get('soc2-cc7.1')).toMatchObject({
      status: 'evidence',
      items: 2,
    });
    expect(byId.get('cis-v8-7')).toMatchObject({
      status: 'no-evidence',
      items: 0,
    });
    expect(renderMarkdown(pack)).toContain('| 3 item(s) |');
  });

  it('orders items newest first, whatever order the sources came in', () => {
    const reversed = buildPack([...sources].reverse(), SCOPE, CATALOGUE);
    const ids = ['r2', 'k1', 'r1'];
    expect(pack.items.map((i) => i.ref.id)).toEqual(ids);
    expect(reversed.items.map((i) => i.ref.id)).toEqual(ids);
  });

  it('carries the disclaimer in both formats (criterion 5)', () => {
    expect(DISCLAIMER).toContain('an aid, not an attestation');
    expect(pack.disclaimer).toBe(DISCLAIMER);
    expect(renderMarkdown(pack)).toContain(`> ${DISCLAIMER}`);
  });

  it('stamps the window, export time and commit from the scope', () => {
    expect(pack).toMatchObject({
      schema: 'canary-evidence-pack/1',
      generated_at: SCOPE.at,
      window: { since: SCOPE.since, until: SCOPE.until },
      commit: SCOPE.commit,
    });
    expect(Object.keys(pack.sources[0] ?? {})).not.toContain('items');
  });

  it('has no graded field anywhere in the pack (criterion 11)', () => {
    const keys = keysOf(pack);
    expect(keys.length).toBeGreaterThan(20);
    for (const graded of ['passed', 'score', 'compliant']) {
      expect(keys).not.toContain(graded);
    }
  });
});
```

**Step 2.** Run `npx vitest run test/evidence-pack.test.ts`. Expect failure: the
modules `pack.js` and `render.js` do not exist.

**Step 3.** Create `ts/src/analysis/evidence/pack.ts`:

```ts
/** Builds the evidence pack from source reports (#855). Pure given a catalogue. */

import type {
  CatalogueRow,
  EvidencePack,
  Scope,
  SourceReport,
} from './types.js';

export const DISCLAIMER =
  'This mapping is an aid, not an attestation. Canary cannot certify ' +
  'compliance. A listed item shows that a check ran and what it recorded; ' +
  'it does not show that a control is met.';

function withoutItems(source: SourceReport): Omit<SourceReport, 'items'> {
  const { items: _items, ...rest } = source;
  return rest;
}

export function buildPack(
  sources: SourceReport[],
  scope: Scope,
  catalogue: CatalogueRow[],
): EvidencePack {
  const controlsFor = (source: SourceReport['id']): string[] =>
    catalogue.filter((c) => c.sources.includes(source)).map((c) => c.id);
  // Newest first; source and id break ties, so the same files give the same order.
  const key = (i: SourceReport['items'][number]): string =>
    `${i.at} ${i.source} ${i.ref.id}`;
  const items = sources
    .flatMap((s) => s.items)
    .sort((a, b) => key(b).localeCompare(key(a)))
    .map((item) => ({ ...item, controls: controlsFor(item.source) }));
  // Every catalogue row is kept: dropping an empty one would hide the gap (D5).
  const controls = catalogue.map((row) => {
    const count = items.filter((i) => i.controls.includes(row.id)).length;
    const status = count > 0 ? ('evidence' as const) : ('no-evidence' as const);
    return { ...row, status, items: count };
  });
  return {
    schema: 'canary-evidence-pack/1',
    disclaimer: DISCLAIMER,
    generated_at: scope.at,
    window: { since: scope.since, until: scope.until },
    commit: scope.commit,
    sources: sources.map(withoutItems),
    controls,
    items,
  };
}
```

**Step 4.** Create `ts/src/analysis/evidence/render.ts`:

```ts
/** Renders the evidence pack as Markdown for a reviewer who reads it cold (#855). Pure. */

import type { EvidencePack } from './types.js';

/** Source text is untrusted: keep it on one line and out of table syntax. */
const cell = (text: string): string =>
  text.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\|/g, '\\|');

function table(head: string[], rows: string[][]): string[] {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line), ''];
}

function sourcesTable(pack: EvidencePack): string[] {
  const rows = pack.sources.map((s) => [
    `${s.id} (${cell(s.path)})`,
    s.state,
    String(s.read),
    String(s.inWindow),
    cell(s.reason ?? ''),
  ]);
  const head = ['Source', 'State', 'Records read', 'Items in window', 'Reason'];
  return table(head, rows);
}

function controlsTable(pack: EvidencePack): string[] {
  const stateOf = (id: string): string => {
    const s = pack.sources.find((source) => source.id === id);
    return `${id}: ${s?.state ?? 'not read'} (${s?.inWindow ?? 0})`;
  };
  const rows = pack.controls.map((c) => [
    c.id,
    cell(`${c.framework}, ${c.reference}`),
    cell(c.supports),
    c.status === 'evidence' ? `${c.items} item(s)` : 'NO EVIDENCE',
    c.sources.map(stateOf).join(', '),
  ]);
  const head = ['Control', 'Reference', 'Supports', 'Evidence', 'Sources'];
  return table(head, rows);
}

export function renderMarkdown(pack: EvidencePack): string {
  const { since, until } = pack.window;
  const lines = [
    `# Audit evidence pack\n\n- Window: ${since} up to, not including, ${until}`,
    `- Generated: ${pack.generated_at}\n- Commit: ${pack.commit ?? 'not resolved'}`,
    `\n> ${pack.disclaimer}\n\n## Sources\n`,
    ...sourcesTable(pack),
    '## Controls\n',
    ...controlsTable(pack),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}
```

**Step 5.** Run `npx vitest run test/evidence-pack.test.ts`. Expect 10 tests
passed.

**Step 6.** Run these from `ts/`:

```bash
npm run typecheck
npx prettier --check src/analysis/evidence/pack.ts src/analysis/evidence/render.ts test/evidence-pack.test.ts
```

**Step 7.** Run `harness validate`.

**Step 8.** Commit with this message:

```text
feat(evidence): build the pack and its tables, keeping empty controls (#855)
```

### Task 3: History reader, windowing and the catalogue loader

**Depends on:** Task 2 | **Files:** ts/test/evidence-sources.test.ts,
ts/src/analysis/evidence/sources.ts, ts/src/analysis/evidence/pack.ts

Covers criteria 2 and 6, the catalogue pin behind criterion 4, and the shared
machinery every reader uses.

**Step 1.** Create `ts/test/evidence-sources.test.ts`:

```ts
/**
 * Evidence pack source readers (#855). A source that is missing, corrupt or
 * half readable is reported with its reason; it is never skipped and never
 * read as empty. Fixtures are synthetic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPack } from '../src/analysis/evidence/pack.js';
import {
  loadCatalogue,
  noItems,
  oneItem,
  readHistory,
} from '../src/analysis/evidence/sources.js';
import type { Scope } from '../src/analysis/evidence/types.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const HISTORY = join('test-results', 'reports', 'history-v2.jsonl');
const SHA = 'a'.repeat(40);

let root: string;
let scope: Scope;

beforeEach(() => {
  root = mkTmp();
  scope = {
    since: '2026-01-01T00:00:00.000Z',
    until: '2026-06-01T00:00:00.000Z',
    root,
    out: join(root, 'out'),
    at: '2026-06-15T12:00:00.000Z',
    commit: SHA,
  };
});

afterEach(() => rmTmp(root));

function write(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function storedRun(id: string, timestamp?: string): Record<string, unknown> {
  return {
    run_id: id,
    suite: 'api',
    commit_sha: SHA,
    total: 3,
    passed: 2,
    failed: 1,
    flaky: 0,
    schema_version: 3,
    ...(timestamp === undefined ? {} : { timestamp }),
    tests: [{ test_name: 't1', status: 'failed', error_text: 'TOKEN=hunter2' }],
  };
}

function writeRuns(runs: Record<string, unknown>[]): void {
  write(HISTORY, runs.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

describe('control catalogue', () => {
  const catalogue = loadCatalogue();
  const known = ['batwoman', 'katana', 'history', 'ci-ready'];

  it('holds the six controls of the spec, each naming known sources', () => {
    expect(catalogue.map((c) => c.id)).toEqual([
      'nist-800-40r4-2.3.3',
      'nist-800-40r4-2.3.4',
      'iso-27001-2022-a.8.8',
      'cis-v8-7',
      'soc2-cc7.1',
      'soc2-cc8.1',
    ]);
    for (const row of catalogue) {
      expect(row.sources.length, row.id).toBeGreaterThan(0);
      expect(known, row.id).toEqual(expect.arrayContaining(row.sources));
    }
  });

  it('maps every source to at least one control, so no item is unmapped', () => {
    for (const id of known) {
      const controls = catalogue.filter((c) => c.sources.some((s) => s === id));
      expect(controls.length, id).toBeGreaterThan(0);
    }
  });
});

describe('buildPack with the shipped catalogue', () => {
  it('lists the six shipped controls when no catalogue is passed', () => {
    const pack = buildPack([], scope);
    expect(pack.controls.map((c) => c.id)).toEqual(
      loadCatalogue().map((c) => c.id),
    );
    expect(pack.controls.every((c) => c.status === 'no-evidence')).toBe(true);
  });
});

describe('readHistory', () => {
  it('is absent, with the fix, when the store does not exist', () => {
    const report = readHistory(scope);
    expect(report).toMatchObject({ state: 'absent', read: 0, items: [] });
    expect(report.path).toBe(HISTORY);
    expect(report.reason).toContain('canary history record');
  });

  it('includes a run dated at since and excludes one dated at until (criterion 6)', () => {
    writeRuns([
      storedRun('before', '2025-12-31T23:59:59.999Z'),
      storedRun('at-since', '2026-01-01T00:00:00.000Z'),
      storedRun('inside', '2026-03-01T00:00:00.000Z'),
      storedRun('at-until', '2026-06-01T00:00:00.000Z'),
    ]);
    const report = readHistory(scope);
    expect(report.items.map((i) => i.ref.id)).toEqual(['at-since', 'inside']);
    expect(report).toMatchObject({ state: 'read', read: 4, inWindow: 2 });
    expect(report.reason).toBeUndefined();
  });

  it('links each run by id and commit, and carries counts but no failure text', () => {
    writeRuns([storedRun('r1', '2026-03-01T00:00:00.000Z')]);
    const [item] = readHistory(scope).items;
    expect(item?.ref).toEqual({ kind: 'run', id: 'r1', commit: SHA });
    expect(item?.summary).toContain('2 passed, 1 failed, 0 flaky of 3');
    expect(JSON.stringify(item)).not.toContain('hunter2');
  });

  it('is unreadable, naming the line, when the store is corrupt (criterion 2)', () => {
    const good = JSON.stringify(storedRun('r1', '2026-03-01T00:00:00.000Z'));
    write(HISTORY, `${good}\n{not json\n`);
    const report = readHistory(scope);
    expect(report).toMatchObject({ state: 'unreadable', read: 0, items: [] });
    expect(report.reason).toContain('line 2');
  });

  it('is unreadable, naming the errno, when the store is a directory', () => {
    mkdirSync(join(root, HISTORY), { recursive: true });
    const report = readHistory(scope);
    expect(report.state).toBe('unreadable');
    expect(report.reason).toContain('EISDIR');
  });

  it('is partial when a run has no usable date, and places it nowhere', () => {
    writeRuns([
      storedRun('dated', '2026-03-01T00:00:00.000Z'),
      storedRun('undated'),
      storedRun('garbled', 'last tuesday'),
    ]);
    const report = readHistory(scope);
    expect(report).toMatchObject({ state: 'partial', read: 3, undated: 2 });
    expect(report.items.map((i) => i.ref.id)).toEqual(['dated']);
    expect(report.reason).toContain('2 record(s) have no usable date');
  });
});

describe('source helpers the CLI builds ci-ready with', () => {
  it('builds a one-item report with a commit URL when the repository is known', () => {
    const src = {
      id: 'ci-ready' as const,
      path: '.',
      scope: { ...scope, repo: 'acme/widgets' },
    };
    const ref = { kind: 'commit' as const, id: SHA };
    const report = oneItem(src, { date: scope.at, summary: 'scored', ref });
    expect(report).toMatchObject({ state: 'read', read: 1, inWindow: 1 });
    expect(report.items[0]).toEqual({
      source: 'ci-ready',
      at: scope.at,
      summary: 'scored',
      ref: { ...ref, url: `https://github.com/acme/widgets/commit/${SHA}` },
    });
  });

  it('builds no URL without a repository, or from a malformed slug', () => {
    const ref = { kind: 'commit' as const, id: SHA };
    const raw = { date: scope.at, summary: 'scored', ref };
    const bare = oneItem({ id: 'ci-ready', path: '.', scope }, raw);
    const odd = { ...scope, repo: 'acme/widgets/../x' };
    const bad = oneItem({ id: 'ci-ready', path: '.', scope: odd }, raw);
    expect(bare.items[0]?.ref.url).toBeUndefined();
    expect(bad.items[0]?.ref.url).toBeUndefined();
  });

  it('reports a source with no items under the state and reason given', () => {
    const src = { id: 'ci-ready' as const, path: '.', scope };
    expect(noItems(src, 'out-of-window', 'scored outside')).toEqual({
      id: 'ci-ready',
      path: '.',
      state: 'out-of-window',
      reason: 'scored outside',
      read: 0,
      inWindow: 0,
      undated: 0,
      items: [],
    });
  });
});
```

**Step 2.** Run `npx vitest run test/evidence-sources.test.ts`. Expect failure:
the module `sources.js` does not exist.

**Step 3.** Create `ts/src/analysis/evidence/sources.ts`:

```ts
/** File readers for the evidence pack (#855). A bad source is reported with its reason, never skipped. */

import { readFileSync, statSync } from 'node:fs';

import { errnoCode } from '../../core/gate-result.js';
import {
  HistoryContentError,
  NdjsonHistoryStore,
} from '../../history/ndjson-store.js';
import type {
  CatalogueRow,
  EvidenceItem,
  Scope,
  SourceId,
  SourceReport,
} from './types.js';

type Src = { id: SourceId; path: string; scope: Scope };
type Dark = 'absent' | 'unreadable' | 'out-of-window';
type Ref = EvidenceItem['ref'];
type Raw = { date: unknown; summary: string; ref: Ref; repo?: unknown };
type Loaded = (Raw | string)[] | SourceReport;

const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const ZERO = { read: 0, inWindow: 0, undated: 0, items: [] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `src/data` under vitest, `dist/data` once built (ts/scripts/copy-data.mjs). */
export function loadCatalogue(): CatalogueRow[] {
  const url = new URL('../../data/evidence/controls.json', import.meta.url);
  const doc = JSON.parse(readFileSync(url, 'utf-8')) as unknown;
  return (doc as { controls: CatalogueRow[] }).controls;
}

export function noItems(src: Src, state: Dark, reason: string): SourceReport {
  return { id: src.id, path: src.path, state, reason, ...ZERO };
}

/** A commit URL is built only from a well-formed slug and SHA, never guessed (D13). */
function toItem(src: Src, raw: Raw, ms: number): EvidenceItem {
  const repo = src.scope.repo ?? raw.repo;
  const sha = raw.ref.kind === 'commit' ? raw.ref.id : (raw.ref.commit ?? '');
  const ok = typeof repo === 'string' && REPO_SLUG.test(repo) && SHA.test(sha);
  const url = `https://github.com/${String(repo)}/commit/${sha}`;
  const ref = ok ? { ...raw.ref, url } : raw.ref;
  const at = new Date(ms).toISOString();
  return { source: src.id, at, summary: raw.summary, ref };
}

export function oneItem(src: Src, raw: Raw): SourceReport {
  const items = [toItem(src, raw, Date.parse(String(raw.date)))];
  const counts = { read: 1, inWindow: 1, undated: 0, items };
  return { id: src.id, path: src.path, state: 'read', ...counts };
}

function windowed(src: Src, loaded: (Raw | string)[]): SourceReport {
  const since = Date.parse(src.scope.since);
  const until = Date.parse(src.scope.until);
  const reasons = loaded.filter((r) => typeof r === 'string');
  const raws = loaded.filter((r) => typeof r !== 'string');
  const items: EvidenceItem[] = [];
  let undated = 0;
  let unlinked = 0;
  for (const raw of raws) {
    const ms = typeof raw.date === 'string' ? Date.parse(raw.date) : NaN;
    if (Number.isNaN(ms)) undated += 1;
    else if (raw.ref.id === '') unlinked += 1;
    else if (ms >= since && ms < until) items.push(toItem(src, raw, ms));
  }
  if (undated > 0) reasons.push(`${undated} record(s) have no usable date`);
  if (unlinked > 0) reasons.push(`${unlinked} record(s) have no identifier`);
  const counts = { read: raws.length, inWindow: items.length, undated, items };
  const { id, path } = src;
  if (reasons.length === 0) return { id, path, state: 'read', ...counts };
  return { id, path, state: 'partial', reason: reasons.join('; '), ...counts };
}

/** Why a read failed ('' for ENOENT). Any other kind of error is a bug and still throws. */
function problemOf(err: unknown, path: string): string {
  if (err instanceof SyntaxError) return 'not valid JSON';
  if (err instanceof HistoryContentError) return err.reasonFor(path);
  const code = errnoCode(err);
  if (code === null) throw err;
  return code === 'ENOENT' ? '' : `could not be read (${code})`;
}

type Loader = (file: string) => Loaded;

/** Sources live under the root; only a typed --batwoman directory is read where it was typed. */
function read(src: Src, hint: string, load: Loader, typed?: string) {
  try {
    const file = typed ?? `${src.scope.root}/${src.path}`;
    // A missing path is absent for every source: readAll() alone reads it as empty.
    statSync(file);
    const loaded = load(file);
    return Array.isArray(loaded) ? windowed(src, loaded) : loaded;
  } catch (err) {
    const why = problemOf(err, src.path);
    if (why !== '') return noItems(src, 'unreadable', why);
    return noItems(src, 'absent', `nothing at ${src.path}; ${hint}`);
  }
}

type StoredRun = ReturnType<NdjsonHistoryStore['readAll']>[number];

const count = (n: number | undefined): number => n ?? 0;

function runRaw(r: StoredRun): Raw {
  const id = typeof r.run_id === 'string' ? r.run_id : '';
  // Counts only: error_text can hold secrets (D12).
  const summary = `run ${id} (${r.suite}): ${count(r.passed)} passed, ${count(r.failed)} failed, ${count(r.flaky)} flaky of ${count(r.total)}`;
  const commit = r.commit_sha ? { commit: r.commit_sha } : {};
  return { date: r.timestamp, summary, ref: { kind: 'run', id, ...commit } };
}

export function readHistory(scope: Scope): SourceReport {
  const hint = 'record runs with `canary history record`';
  // The default store of `canary history` (DEFAULT_HISTORY_FILE in history/cli.ts).
  const path = 'test-results/reports/history-v2.jsonl';
  return read({ id: 'history', path, scope }, hint, (file) =>
    new NdjsonHistoryStore(file).readAll().map(runRaw),
  );
}
```

**Step 4.** In `ts/src/analysis/evidence/pack.ts`, make the shipped catalogue
the default. Find:

```text
import type {
  CatalogueRow,
```

Replace with:

```text
import { loadCatalogue } from './sources.js';
import type {
  CatalogueRow,
```

Then find the line `catalogue: CatalogueRow[],` in the `buildPack` signature and
replace it with:

```text
  catalogue: CatalogueRow[] = loadCatalogue(),
```

**Step 5.** Run both files. Expect 22 tests passed.

```bash
npx vitest run test/evidence-sources.test.ts test/evidence-pack.test.ts
```

**Step 6.** Run these from `ts/`:

```bash
npm run typecheck
npx prettier --check src/analysis/evidence/sources.ts src/analysis/evidence/pack.ts test/evidence-sources.test.ts
```

**Step 7.** Run `harness validate` and `harness check-deps` from the repo root.
`sources.ts` is in the `analysis` layer and imports `history` and `core`.

**Step 8.** Commit with this message:

```text
feat(evidence): read run history into a windowed source report (#855)
```

### Task 4: Ledger and batwoman readers, and the typo check

**Depends on:** Task 3 | **Files:** ts/test/evidence-sources.test.ts,
ts/src/analysis/evidence/sources.ts

Covers criteria 3, 4 and 11 at the reader level.

**Step 1.** In `ts/test/evidence-sources.test.ts`, replace the `node:fs` import
line with:

```ts
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
```

Replace the import from `'../src/analysis/evidence/sources.js'` with:

```ts
import {
  loadCatalogue,
  noItems,
  oneItem,
  readBatwoman,
  readHistory,
  readLedger,
  typo,
} from '../src/analysis/evidence/sources.js';
```

Then append this to the end of the file, after one blank line:

```ts
const LEDGER = join('.canary', 'quarantine.json');
const REPORTS = join('.canary', 'batwoman');

function ledgerRow(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    test: 'adds a widget',
    file: 'tests/widgets.test.ts',
    kind: 'skipped',
    marker: 'it.skip',
    commit: 'b'.repeat(40),
    author: 'Sam Example',
    date: '2026-03-01T10:00:00Z',
    reason: 'chore: skip the widget test',
    cause: 'blocked-data',
    issue: '#12',
    expiry: '',
    ...over,
  };
}

function savedReport(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    issue: 12,
    pullRequest: 34,
    repo: 'acme/widgets',
    mergeSha: 'c'.repeat(40),
    mergeSubject: 'fix: widget totals',
    mergedAt: '2026-02-01T00:00:00.000Z',
    summary: { changed: 2, byStatus: { 'not-exercised': 2 } },
    files: [
      { file: 'src/a.ts', status: 'not-exercised', explanation: 'no run' },
      { file: 'src/b.ts', status: 'not-exercised', explanation: 'no run' },
    ],
    ...over,
  });
}

describe('readLedger', () => {
  it('is absent when there is no ledger', () => {
    const report = readLedger(scope);
    expect(report).toMatchObject({ state: 'absent', read: 0 });
    expect(report.reason).toContain(LEDGER);
  });

  it('turns each row in the window into an item with owner, reason and link', () => {
    const rows = [ledgerRow(), ledgerRow({ test: 'old', date: '2025-06-01' })];
    write(LEDGER, JSON.stringify({ schema_version: 2, entries: rows }));
    const report = readLedger(scope);
    expect(report).toMatchObject({ state: 'read', read: 2, inWindow: 1 });
    expect(report.items[0]?.ref).toEqual({
      kind: 'ledger-entry',
      id: 'tests/widgets.test.ts::adds a widget',
      commit: 'b'.repeat(40),
    });
    expect(report.items[0]?.summary).toBe(
      'skipped adds a widget in tests/widgets.test.ts by Sam Example: blocked-data',
    );
  });

  it('reads an empty v2 ledger as read with nothing recorded', () => {
    write(LEDGER, JSON.stringify({ schema_version: 2, entries: [] }));
    expect(readLedger(scope)).toMatchObject({ state: 'read', read: 0 });
  });

  it.each([
    ['not JSON', '{nope', 'not valid JSON'],
    ['a v1 ledger', JSON.stringify({ entries: [] }), 'katana v2 ledger'],
    ['no entries array', '{"schema_version":2}', 'katana v2 ledger'],
  ])('is unreadable when the file is %s', (_name, text, reason) => {
    write(LEDGER, text);
    const report = readLedger(scope);
    expect(report.state).toBe('unreadable');
    expect(report.reason).toContain(reason);
  });

  it('is partial when a row has no date or no file and test to link to', () => {
    const rows = [
      ledgerRow(),
      ledgerRow({ date: '' }),
      ledgerRow({ file: '' }),
    ];
    write(LEDGER, JSON.stringify({ schema_version: 2, entries: rows }));
    const report = readLedger(scope);
    expect(report).toMatchObject({ state: 'partial', inWindow: 1, undated: 1 });
    expect(report.reason).toContain('1 record(s) have no usable date');
    expect(report.reason).toContain('1 record(s) have no identifier');
  });
});

describe('readBatwoman', () => {
  it('is absent, with the command that saves a report, when the directory is missing or empty', () => {
    const missing = readBatwoman(scope);
    mkdirSync(join(root, REPORTS), { recursive: true });
    write(join(REPORTS, 'notes.txt'), 'not a report');
    const empty = readBatwoman(scope);
    for (const report of [missing, empty]) {
      expect(report.state).toBe('absent');
      expect(report.reason).toContain('canary batwoman --issue <n> --json');
    }
  });

  it('lists a not-exercised report as an item with its statuses (criterion 11)', () => {
    write(join(REPORTS, '12.json'), savedReport());
    const report = readBatwoman(scope);
    expect(report).toMatchObject({ state: 'read', read: 1, inWindow: 1 });
    expect(report.items[0]?.summary).toBe(
      'issue #12 (PR #34) from 12.json: not-exercised: 2',
    );
    expect(report.items[0]?.ref).toEqual({
      kind: 'commit',
      id: 'c'.repeat(40),
      url: `https://github.com/acme/widgets/commit/${'c'.repeat(40)}`,
    });
  });

  it('keeps two reports for one issue as two items, each naming its file', () => {
    write(join(REPORTS, '12-a.json'), savedReport());
    write(join(REPORTS, '12-b.json'), savedReport());
    const summaries = readBatwoman(scope).items.map((i) => i.summary);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain('12-a.json');
    expect(summaries[1]).toContain('12-b.json');
  });

  it('is partial, naming the file, when one report is malformed', () => {
    write(join(REPORTS, '12.json'), savedReport());
    write(join(REPORTS, '13.json'), '{broken');
    write(join(REPORTS, '14.json'), JSON.stringify({ issue: 14 }));
    const report = readBatwoman(scope);
    expect(report).toMatchObject({ state: 'partial', read: 1, inWindow: 1 });
    expect(report.reason).toContain('13.json: not valid JSON');
    expect(report.reason).toContain('14.json: lacks issue, mergeSha');
  });

  it('is unreadable, naming the errno, when the directory cannot be listed', () => {
    write(REPORTS, 'a file where the directory should be');
    const report = readBatwoman(scope);
    expect(report.state).toBe('unreadable');
    expect(report.reason).toContain('ENOTDIR');
  });

  it('names a report it has no permission to read and still reads the rest', () => {
    write(join(REPORTS, '12.json'), savedReport());
    write(join(REPORTS, '13.json'), savedReport({ issue: 13 }));
    chmodSync(join(root, REPORTS, '13.json'), 0o000);
    const report = readBatwoman(scope);
    expect(report).toMatchObject({ state: 'partial', read: 1 });
    expect(report.reason).toContain('13.json: could not be read (EACCES)');
  });
});

describe('typo', () => {
  it('finds nothing wrong with an existing root and no typed values', () => {
    expect(typo(scope)).toBeNull();
  });

  it('names a root that does not exist', () => {
    const gone = join(root, 'no-such-root');
    expect(typo({ ...scope, root: gone })).toBe(`${gone} does not exist`);
  });

  it('names a typed batwoman directory that does not exist', () => {
    const gone = join(root, 'batwomann');
    expect(typo({ ...scope, batwoman: gone })).toBe(`${gone} does not exist`);
  });

  it('names a repository that is not an owner/name slug', () => {
    expect(typo({ ...scope, repo: 'acme' })).toBe(
      'acme is not an owner/name slug',
    );
    expect(typo({ ...scope, repo: 'acme/widgets' })).toBeNull();
  });
});

describe('readBatwoman with a typed directory', () => {
  it('reads the directory where it was typed and labels the source with it', () => {
    const dir = join(root, 'saved');
    write(join('saved', '12.json'), savedReport());
    const report = readBatwoman({ ...scope, batwoman: dir });
    expect(report).toMatchObject({ path: dir, state: 'read', inWindow: 1 });
  });
});
```

**Step 2.** Run `npx vitest run test/evidence-sources.test.ts`. Expect failure:
`readBatwoman`, `readLedger` and `typo` are not exported.

**Step 3.** In `ts/src/analysis/evidence/sources.ts`, replace the `node:fs`
import line with:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
```

Then append this to the end of the file, after one blank line:

```ts
function ledgerRaw(entry: unknown): Raw {
  const row = isRecord(entry) ? entry : {};
  const text = (key: string, fallback = ''): string => {
    const value = row[key];
    return typeof value === 'string' && value !== '' ? value : fallback;
  };
  const [file, test, commit] = [text('file'), text('test'), text('commit')];
  const why = text('cause', text('reason', 'no reason recorded'));
  const id = file && test ? `${file}::${test}` : '';
  return {
    date: row.date,
    summary: `${text('kind', 'recorded')} ${test} in ${file} by ${text('author', 'unknown author')}: ${why}`,
    ref: { kind: 'ledger-entry', id, ...(commit ? { commit } : {}) },
  };
}

export function readLedger(scope: Scope): SourceReport {
  const src: Src = { id: 'katana', path: '.canary/quarantine.json', scope };
  return read(src, 'canary-katana writes it', (file) => {
    const doc: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    const entries = isRecord(doc) && doc.schema_version === 2 ? doc.entries : 0;
    if (Array.isArray(entries)) return entries.map(ledgerRaw);
    return noItems(src, 'unreadable', 'not a katana v2 ledger with entries');
  });
}

function statusTally(files: unknown[]): string {
  const statuses = files.map((f) => (isRecord(f) ? String(f.status) : '?'));
  const times = (s: string): number => statuses.filter((x) => x === s).length;
  const tally = [...new Set(statuses)].map((s) => `${s}: ${times(s)}`);
  return tally.join(', ') || 'no files';
}

function reportRaw(dir: string, name: string): Raw | string {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(`${dir}/${name}`, 'utf-8'));
  } catch (err) {
    return `${name}: ${problemOf(err, name) || 'gone before it was read'}`;
  }
  const r = isRecord(doc) ? doc : {};
  const { issue, mergeSha, mergedAt, files, pullRequest, repo } = r;
  const shaped = typeof issue === 'number' && typeof mergeSha === 'string';
  if (!shaped || typeof mergedAt !== 'string' || !Array.isArray(files)) {
    return `${name}: lacks issue, mergeSha, mergedAt or files`;
  }
  const summary = `issue #${issue} (PR #${String(pullRequest)}) from ${name}: ${statusTally(files)}`;
  const ref = { kind: 'commit' as const, id: mergeSha };
  return { date: mergedAt, summary, ref, repo };
}

/** D9: a path or slug the caller typed that is wrong is a usage error, never an absent source. */
export function typo(scope: Scope): string | null {
  const paths = [scope.root, scope.batwoman ?? scope.root];
  const gone = paths.find((path) => !existsSync(path));
  if (gone !== undefined) return `${gone} does not exist`;
  const slug = scope.repo === undefined || REPO_SLUG.test(scope.repo);
  return slug ? null : `${scope.repo} is not an owner/name slug`;
}

export function readBatwoman(scope: Scope): SourceReport {
  const path = scope.batwoman ?? '.canary/batwoman';
  const src: Src = { id: 'batwoman', path, scope };
  const hint = `save one with \`canary batwoman --issue <n> --json > ${path}/<n>.json\``;
  const load: Loader = (dir) => {
    const names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    if (names.length > 0) return names.sort().map((n) => reportRaw(dir, n));
    return noItems(src, 'absent', `no *.json report; ${hint}`);
  };
  return read(src, hint, load, scope.batwoman);
}
```

`sources.ts` is now 175 non-blank lines.

**Step 4.** Run `npx vitest run test/evidence-sources.test.ts`. Expect 30 tests
passed.

**Step 5.** Run these from `ts/`:

```bash
npm run typecheck
npx prettier --check src/analysis/evidence/sources.ts test/evidence-sources.test.ts
```

**Step 6.** Run `harness validate`.

**Step 7.** Commit with this message:

```text
feat(evidence): read the katana ledger and saved batwoman reports (#855)
```

### Task 5: Evidence by source, capped at 25 items

**Depends on:** Task 2 | **Files:** ts/test/evidence-render.test.ts,
ts/src/analysis/evidence/render.ts

Covers criterion 8.

**Step 1.** Create `ts/test/evidence-render.test.ts`:

```ts
/**
 * Evidence pack Markdown, the per-source evidence lists (#855). Output grows
 * with the window, so the cap is tested at a size that exceeds it.
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest';

import { buildPack } from '../src/analysis/evidence/pack.js';
import { renderMarkdown } from '../src/analysis/evidence/render.js';
import type {
  CatalogueRow,
  EvidenceItem,
  Scope,
  SourceReport,
} from '../src/analysis/evidence/types.js';

const CATALOGUE: CatalogueRow[] = [
  {
    id: 'soc2-cc7.1',
    framework: 'SOC 2',
    reference: 'CC7.1, detection and monitoring',
    supports: 'Test runs ran',
    sources: ['history'],
  },
];

const SCOPE: Scope = {
  since: '2026-01-01T00:00:00.000Z',
  until: '2026-06-15T12:00:00.000Z',
  root: '/repo',
  out: '/repo/out',
  at: '2026-06-15T12:00:00.000Z',
  commit: null,
};

const START = Date.parse('2026-02-01T00:00:00.000Z');

/** Run `n`, one minute after run `n - 1`, so a higher number is newer. */
function runItem(n: number): EvidenceItem {
  return {
    source: 'history',
    at: new Date(START + n * 60_000).toISOString(),
    summary: `run r${n} (api): 3 passed, 0 failed, 0 flaky of 3`,
    ref: { kind: 'run', id: `r${n}`, commit: 'a'.repeat(40) },
  };
}

function history(items: EvidenceItem[]): SourceReport {
  return {
    id: 'history',
    path: 'test-results/reports/history-v2.jsonl',
    state: 'read',
    read: items.length,
    inWindow: items.length,
    undated: 0,
    items,
  };
}

function render(items: EvidenceItem[]): string {
  return renderMarkdown(buildPack([history(items)], SCOPE, CATALOGUE));
}

const itemLines = (md: string): string[] =>
  md.split('\n').filter((line) => line.startsWith('- 2026-02-'));

describe('evidence by source', () => {
  it('lists 25 of 500 runs, newest first, and says 475 more are in the JSON (criterion 8)', () => {
    const items = Array.from({ length: 500 }, (_, n) => runItem(n));
    const pack = buildPack([history(items)], SCOPE, CATALOGUE);
    const lines = itemLines(renderMarkdown(pack));
    expect(pack.items).toHaveLength(500);
    expect(lines).toHaveLength(25);
    expect(lines[0]).toContain('`r499`');
    expect(lines[24]).toContain('`r475`');
    expect(renderMarkdown(pack)).toContain(
      '475 more item(s) are in evidence-pack.json.',
    );
  });

  it('lists exactly 25 items without a remainder line', () => {
    const md = render(Array.from({ length: 25 }, (_, n) => runItem(n)));
    expect(itemLines(md)).toHaveLength(25);
    expect(md).not.toContain('more item(s)');
  });

  it('says so when a source has no item in the window', () => {
    const md = render([]);
    expect(md).toContain('### history\n\nNo items in the window.');
    expect(md).not.toContain('more item(s)');
  });

  it('prints the time, summary, link kind, id and commit of an item', () => {
    const [line] = itemLines(render([runItem(1)]));
    expect(line).toBe(
      '- 2026-02-01T00:01:00.000Z: run r1 (api): 3 passed, 0 failed, 0 flaky of 3 ' +
        `(run \`r1\`, commit \`${'a'.repeat(40)}\`)`,
    );
  });

  it('adds a commit link only when the item carries a URL', () => {
    const url = `https://github.com/acme/widgets/commit/${'a'.repeat(40)}`;
    const linked = { ...runItem(1), ref: { ...runItem(1).ref, url } };
    expect(itemLines(render([linked]))[0]).toContain(`([commit](${url}))`);
    expect(render([runItem(1)])).not.toContain('[commit]');
  });

  it('keeps hostile source text on one line and out of table syntax', () => {
    const hostile = {
      ...runItem(1),
      summary: 'skipped a | b\n## Forged heading',
    };
    const md = render([hostile]);
    expect(md).toContain('skipped a \\| b ## Forged heading');
    expect(md.split('\n')).not.toContain('## Forged heading');
  });
});
```

**Step 2.** Run `npx vitest run test/evidence-render.test.ts`. Expect failure:
the Markdown has no item lines yet.

**Step 3.** In `ts/src/analysis/evidence/render.ts`, insert this directly above
the comment that starts `/** Source text is untrusted`:

```ts
/** Items listed per source (D11); the JSON carries all of them. */
const ITEM_CAP = 25;
```

Insert this function directly above `export function renderMarkdown`:

```ts
function sourceSection(pack: EvidencePack, id: string): string[] {
  const items = pack.items.filter((item) => item.source === id);
  if (items.length === 0)
    return [`### ${id}`, '', 'No items in the window.', ''];
  const shown = items.slice(0, ITEM_CAP).map((item) => {
    const { kind, id: refId, commit, url } = item.ref;
    const sha = commit === undefined ? '' : `, commit \`${cell(commit)}\``;
    const link = url === undefined ? '' : ` ([commit](${url}))`;
    return `- ${item.at}: ${cell(item.summary)} (${kind} \`${cell(refId)}\`${sha})${link}`;
  });
  const more = items.length - shown.length;
  const tail =
    more > 0 ? [`${more} more item(s) are in evidence-pack.json.`, ''] : [];
  return [`### ${id}`, '', ...shown, '', ...tail];
}
```

In `renderMarkdown`, find the end of the `lines` array:

```text
    ...controlsTable(pack),
  ];
```

Replace it with:

```text
    ...controlsTable(pack),
    '## Evidence by source\n',
    ...pack.sources.flatMap((s) => sourceSection(pack, s.id)),
  ];
```

**Step 4.** Run both files. Expect 16 tests passed.

```bash
npx vitest run test/evidence-render.test.ts test/evidence-pack.test.ts
```

**Step 5.** Run these from `ts/`:

```bash
npm run typecheck
npx prettier --check src/analysis/evidence/render.ts test/evidence-render.test.ts
```

**Step 6.** Run `harness validate`.

**Step 7.** Commit with this message:

```text
feat(evidence): list evidence per source, newest first, capped at 25 (#855)
```

### Task 6: Write the two files and the stdout summary

**Depends on:** Task 5 | **Files:** ts/test/evidence-render.test.ts,
ts/src/analysis/evidence/render.ts

Covers criteria 9 and 10 at the engine level, and the exit 1 row of the spec's
error table.

**Step 1.** In `ts/test/evidence-render.test.ts`, replace everything from the
line `import { describe, expect, it } from 'vitest';` down to the blank line
above `const CATALOGUE` with:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPack } from '../src/analysis/evidence/pack.js';
import { renderMarkdown, writePack } from '../src/analysis/evidence/render.js';
import type {
  CatalogueRow,
  EvidenceItem,
  Scope,
  SourceReport,
} from '../src/analysis/evidence/types.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';
```

Then append this to the end of the file, after one blank line:

```ts
describe('writePack', () => {
  let out: string;

  beforeEach(() => {
    out = join(mkTmp(), 'packs');
  });

  afterEach(() => rmTmp(join(out, '..')));

  const packOf = (items: EvidenceItem[]) =>
    buildPack([history(items)], SCOPE, CATALOGUE);

  const emptyPack = () => {
    const absent: SourceReport = {
      ...history([]),
      state: 'absent',
      reason: 'nothing at test-results/reports/history-v2.jsonl',
    };
    return buildPack([absent], SCOPE, CATALOGUE);
  };

  it('writes the JSON and the Markdown, and reports both paths', () => {
    const pack = packOf([runItem(1)]);
    const done = writePack(out, pack);
    const json = readFileSync(join(out, 'evidence-pack.json'), 'utf-8');
    expect(done.exit).toBe(0);
    expect(JSON.parse(json)).toEqual(pack);
    expect(json.endsWith('}\n')).toBe(true);
    expect(readFileSync(join(out, 'evidence-pack.md'), 'utf-8')).toBe(
      renderMarkdown(pack),
    );
    expect(done.lines.slice(-2)).toEqual([
      `Wrote ${out}/evidence-pack.json`,
      `Wrote ${out}/evidence-pack.md`,
    ]);
  });

  it('prints one line per control with its item count, and no warning', () => {
    const done = writePack(out, packOf([runItem(1), runItem(2)]));
    expect(done.lines[0]).toBe('soc2-cc7.1  evidence: 2');
    expect(done.lines.join('\n')).not.toContain('Abstained');
    expect(done.lines.join('\n')).not.toContain('source history');
  });

  it('names each source that is not read, with its reason', () => {
    const done = writePack(out, emptyPack());
    expect(done.lines).toContain('soc2-cc7.1  NO EVIDENCE');
    expect(done.lines).toContain(
      'source history: absent (nothing at test-results/reports/history-v2.jsonl)',
    );
  });

  it('warns with the cause and the first step when no source produced an item (criterion 9)', () => {
    const done = writePack(out, emptyPack());
    const warning = done.lines.find((line) => line.includes('Abstained'));
    expect(done.exit).toBe(0);
    expect(warning).toContain('No source produced an item in the window');
    expect(warning).toContain('(history absent)');
    expect(warning).toContain('First step: record a run with');
    expect(done.lines.join('\n')).not.toContain('evidence: ');
    expect(readFileSync(join(out, 'evidence-pack.md'), 'utf-8')).toContain(
      'NO EVIDENCE',
    );
  });

  it('replaces the previous pack in the same directory (criterion 10)', () => {
    writePack(out, packOf([runItem(1)]));
    writePack(out, packOf([runItem(2)]));
    const json = readFileSync(join(out, 'evidence-pack.json'), 'utf-8');
    const md = readFileSync(join(out, 'evidence-pack.md'), 'utf-8');
    expect(json).toContain('"r2"');
    expect(json).not.toContain('"r1"');
    expect(md).not.toContain('`r1`');
  });

  it('exits 1 naming the directory and the errno when it cannot write', () => {
    const blocker = join(out, '..', 'blocker');
    writeFileSync(blocker, 'a file where the directory should go');
    const done = writePack(join(blocker, 'packs'), packOf([runItem(1)]));
    expect(done.exit).toBe(1);
    expect(done.lines).toHaveLength(1);
    expect(done.lines[0]).toContain(join(blocker, 'packs'));
    expect(done.lines[0]).toMatch(/ENOTDIR|EEXIST/);
  });
});
```

**Step 2.** Run `npx vitest run test/evidence-render.test.ts`. Expect failure:
`writePack` is not exported.

**Step 3.** In `ts/src/analysis/evidence/render.ts`, replace the header comment
and the `import type { EvidencePack }` line (the first three lines of the file)
with:

```ts
/** Renders the evidence pack for a reviewer who reads it cold, and writes both files (#855). */

import { mkdirSync, writeFileSync } from 'node:fs';

import { errnoCode, gateOutcome } from '../../core/gate-result.js';
import type { EvidencePack, Outcome } from './types.js';
```

Then append this to the end of the file, after one blank line:

```ts
/** Stdout: every control, every source that is not `read`, and a warning when nothing was found (D8). */
function summaryLines(pack: EvidencePack): string[] {
  const lines = pack.controls.map((c) => {
    const n = c.status === 'evidence' ? `evidence: ${c.items}` : 'NO EVIDENCE';
    return `${c.id}  ${n}`;
  });
  const dark = pack.sources.filter((s) => s.state !== 'read');
  lines.push(...dark.map((s) => `source ${s.id}: ${s.state} (${s.reason})`));
  if (pack.items.length > 0) return lines;
  const { summaryLine } = gateOutcome({ checked: 0, findings: [] }, 'advisory');
  const cause = pack.sources.map((s) => `${s.id} ${s.state}`).join(', ');
  const step = 'record a run with `canary history record`, or widen --since';
  const why = `No source produced an item in the window (${cause})`;
  return [...lines, `${summaryLine} ${why}. First step: ${step}.`];
}

export function writePack(out: string, pack: EvidencePack): Outcome {
  const json = `${out}/evidence-pack.json`;
  const md = `${out}/evidence-pack.md`;
  try {
    mkdirSync(out, { recursive: true });
    writeFileSync(json, `${JSON.stringify(pack, null, 2)}\n`);
    writeFileSync(md, renderMarkdown(pack));
  } catch (err) {
    const code = errnoCode(err);
    if (code === null) throw err;
    const line = `evidence: cannot write the pack to ${out} (${code})`;
    return { exit: 1, lines: [line] };
  }
  const lines = [...summaryLines(pack), `Wrote ${json}`, `Wrote ${md}`];
  return { exit: 0, lines };
}
```

`render.ts` is now 99 non-blank lines.

**Step 4.** Run `npx vitest run test/evidence-render.test.ts`. Expect 12 tests
passed.

**Step 5.** Run these from `ts/`:

```bash
npm run typecheck
npx prettier --check src/analysis/evidence/render.ts test/evidence-render.test.ts
```

**Step 6.** Run `harness validate` and `harness check-deps`.

**Step 7.** Commit with this message:

```text
feat(evidence): write the pack files and warn when no source produced an item (#855)
```

### Task 7: Export the `ci-ready` report for a root

**Depends on:** none | **Files:** ts/test/ci-ready-report-for.test.ts,
ts/src/ci-ready-cli.ts

The existing lines of the `ci-ready` action move into an exported function. They
are not duplicated.

**Step 1.** Create `ts/test/ci-ready-report-for.test.ts`:

```ts
/**
 * `ciReadyReportFor` (#855): the readiness report for a root, callable without
 * the `ci-ready` command, so `canary evidence export` scores through the same
 * code path instead of a copy. Fixtures are synthetic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ciReadyReportFor } from '../src/ci-ready-cli.js';
import { invokeCanary, mkTmp, rmTmp } from './canary-cli-testkit.js';

let root: string;

beforeEach(() => {
  root = mkTmp();
});

afterEach(() => rmTmp(root));

function recordRun(): void {
  const dir = join(root, 'test-results', 'reports');
  const path = join(dir, 'history-v2.jsonl');
  mkdirSync(dir, { recursive: true });
  const run = {
    run_id: 'r1',
    suite: 'api',
    timestamp: '2026-03-01T00:00:00.000Z',
    total: 1,
    passed: 1,
    duration_ms: 1000,
    schema_version: 3,
    tests: [{ test_name: 't1', status: 'passed' }],
  };
  writeFileSync(path, `${JSON.stringify(run)}\n`);
}

describe('ciReadyReportFor', () => {
  it('abstains with five skipped checks for a root holding no input', () => {
    const report = ciReadyReportFor(root);
    expect(report.verdict).toBe('abstained');
    expect(report.checked).toBe(0);
    expect(report.checks).toHaveLength(5);
  });

  it('scores the checks whose input exists under the root', () => {
    recordRun();
    const report = ciReadyReportFor(root);
    expect(report.checked).toBeGreaterThan(0);
    const runtime = report.checks.find((c) => c.name === 'suite-runtime');
    expect(runtime?.verdict).toBe('pass');
  });

  it('is the report the ci-ready command prints', async () => {
    recordRun();
    const res = await invokeCanary(['ci-ready', '--root', root, '--json']);
    const printed = JSON.parse(res.stdout) as Record<string, unknown>;
    const { observed_at: _observedAt, ...rest } = printed;
    expect(rest).toEqual(JSON.parse(JSON.stringify(ciReadyReportFor(root))));
  });
});
```

**Step 2.** Run `npx vitest run test/ci-ready-report-for.test.ts`. Expect
failure: `ciReadyReportFor` is not exported.

**Step 3.** In `ts/src/ci-ready-cli.ts`, inside the `.action(...)` callback of
`buildCiReadyCommand`, find these lines:

```text
      const root = opts.root ?? deps.cwd();
      const report = scoreCiReady({
        runs: readRuns(root),
        historyPath: HISTORY_FILE,
        inventory: loadInput(root, 'test-inventory.json', parseInventory),
        criticalAreas: loadInput(
          root,
          'critical-areas.json',
          parseCriticalAreas,
        ),
        workingTree: workingTreeAt(root),
      });
```

Replace them with this one line:

```text
      const report = ciReadyReportFor(opts.root ?? deps.cwd());
```

Then insert this function directly above `export function buildCiReadyCommand`:

```ts
/** `canary evidence export` scores through this too (#855). */
export function ciReadyReportFor(root: string): CiReadyReport {
  return scoreCiReady({
    runs: readRuns(root),
    historyPath: HISTORY_FILE,
    inventory: loadInput(root, 'test-inventory.json', parseInventory),
    criticalAreas: loadInput(root, 'critical-areas.json', parseCriticalAreas),
    workingTree: workingTreeAt(root),
  });
}
```

The file goes from 133 to 132 non-blank lines.

**Step 4.** Run both files. Expect 37 tests passed. The second file proves the
command did not change.

```bash
npx vitest run test/ci-ready-report-for.test.ts test/ci-ready-cli.test.ts
```

**Step 5.** Run these from `ts/`:

```bash
npm run typecheck
npx prettier --check src/ci-ready-cli.ts test/ci-ready-report-for.test.ts
```

**Step 6.** Run `harness validate`.

**Step 7.** Commit with this message:

```text
refactor(ci-ready): export the readiness report for a root (#855)
```

### Task 8: `exportPack` and the `canary evidence export` command

**Depends on:** Tasks 4, 6, 7 | **Files:** ts/test/evidence-cli.test.ts,
ts/src/analysis/evidence/pack.ts, ts/src/evidence/cli.ts

Covers criteria 1, 2, 3, 4, 7, 9 and 10 through the command, and the usage
errors of the spec's error table. The tests build the command directly with a
fixed clock (`buildEvidenceCommand(deps, () => NOW)`), because `invokeCanary`
cannot inject one.

**Step 1.** Create `ts/test/evidence-cli.test.ts`:

```ts
/**
 * `canary evidence export` (#855), driven through the command with a fixed
 * clock and a fake `git rev-parse HEAD`. Fixtures are synthetic: an
 * `acme/widgets` repository in a temp root.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliExitError } from '../src/cli-common.js';
import { buildEvidenceCommand } from '../src/evidence/cli.js';
import type { EvidencePack } from '../src/analysis/evidence/types.js';
import { defaultMainDeps, type MainDeps } from '../src/main-deps.js';
import { mkTmp, rmTmp } from './canary-cli-testkit.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const HEAD = 'd'.repeat(40);
const HISTORY = join('test-results', 'reports', 'history-v2.jsonl');
const CONTROLS = [
  'nist-800-40r4-2.3.3',
  'nist-800-40r4-2.3.4',
  'iso-27001-2022-a.8.8',
  'cis-v8-7',
  'soc2-cc7.1',
  'soc2-cc8.1',
];

let root: string;

beforeEach(() => {
  root = mkTmp();
});

afterEach(() => rmTmp(root));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  args: string[],
  over: Partial<MainDeps> = {},
): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const deps: MainDeps = {
    ...defaultMainDeps(),
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    env: {},
    cwd: () => root,
    runSubprocess: () => ({ status: 0, stdout: `${HEAD}\n`, stderr: '' }),
    ...over,
  };
  let code = 0;
  try {
    const command = buildEvidenceCommand(deps, () => NOW);
    await command.parseAsync(['export', ...args], { from: 'user' });
  } catch (e) {
    if (e instanceof CliExitError) code = e.code;
    else if (e instanceof CommanderError) code = e.exitCode;
    else throw e;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function write(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function storedRun(id: string, timestamp: string): string {
  return `${JSON.stringify({
    run_id: id,
    suite: 'api',
    commit_sha: 'a'.repeat(40),
    timestamp,
    total: 3,
    passed: 3,
    failed: 0,
    flaky: 0,
    duration_ms: 1000,
    schema_version: 3,
    tests: [],
  })}\n`;
}

/** One record in every file-backed source, all dated inside 2026. */
function seedAllSources(): void {
  write(HISTORY, storedRun('r1', '2026-03-01T00:00:00.000Z'));
  write(
    join('.canary', 'quarantine.json'),
    JSON.stringify({
      schema_version: 2,
      entries: [
        {
          test: 'adds a widget',
          file: 'tests/widgets.test.ts',
          kind: 'skipped',
          commit: 'b'.repeat(40),
          author: 'Sam Example',
          date: '2026-03-02T00:00:00Z',
          cause: 'blocked-data',
        },
      ],
    }),
  );
  write(
    join('.canary', 'batwoman', '12.json'),
    JSON.stringify({
      issue: 12,
      pullRequest: 34,
      repo: 'acme/widgets',
      mergeSha: 'c'.repeat(40),
      mergedAt: '2026-03-03T00:00:00.000Z',
      files: [{ file: 'src/a.ts', status: 'not-exercised' }],
    }),
  );
}

function readPack(dir = join(root, '.canary', 'evidence')): EvidencePack {
  const text = readFileSync(join(dir, 'evidence-pack.json'), 'utf-8');
  return JSON.parse(text) as EvidencePack;
}

function readMarkdown(dir = join(root, '.canary', 'evidence')): string {
  return readFileSync(join(dir, 'evidence-pack.md'), 'utf-8');
}

describe('canary evidence export', () => {
  it('writes both files with all six controls when every source is empty (criterion 1)', async () => {
    const res = await run(['--since', '2026-01-01']);
    expect(res.code).toBe(0);
    const pack = readPack();
    expect(pack.controls.map((c) => c.id)).toEqual(CONTROLS);
    expect(pack.controls.every((c) => c.status === 'no-evidence')).toBe(true);
    const md = readMarkdown();
    for (const id of CONTROLS) {
      const row = md.split('\n').find((l) => l.startsWith(`| ${id} |`));
      expect(row, id).toContain('NO EVIDENCE');
      expect(res.stdout).toContain(`${id}  NO EVIDENCE`);
    }
  });

  it('links every item and maps it to a control, across all four sources (criterion 4)', async () => {
    seedAllSources();
    const res = await run(['--since', '2026-01-01']);
    expect(res.code).toBe(0);
    const pack = readPack();
    expect(pack.items.map((i) => i.source).sort()).toEqual([
      'batwoman',
      'ci-ready',
      'history',
      'katana',
    ]);
    for (const item of pack.items) {
      expect(item.ref.id, item.source).not.toBe('');
      expect(item.controls.length, item.source).toBeGreaterThan(0);
    }
    expect(pack.sources.map((s) => s.state)).toEqual([
      'read',
      'read',
      'read',
      'read',
    ]);
    expect(res.stdout).toContain('soc2-cc8.1  evidence: 3');
    expect(res.stdout).toContain('cis-v8-7  evidence: 1');
  });

  it('ends the window at the export time when --until is omitted (criterion 7)', async () => {
    seedAllSources();
    await run(['--since', '2026-01-01']);
    const pack = readPack();
    expect(pack.window).toEqual({
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-06-15T12:00:00.000Z',
    });
    expect(pack.generated_at).toBe('2026-06-15T12:00:00.000Z');
    expect(pack.commit).toBe(HEAD);
  });

  it('dates the ci-ready item at the export and links it to HEAD (D10)', async () => {
    seedAllSources();
    await run(['--since', '2026-01-01', '--repo', 'acme/widgets']);
    const item = readPack().items.find((i) => i.source === 'ci-ready');
    expect(item?.at).toBe('2026-06-15T12:00:00.000Z');
    expect(item?.ref).toEqual({
      kind: 'commit',
      id: HEAD,
      url: `https://github.com/acme/widgets/commit/${HEAD}`,
    });
    expect(item?.summary).toMatch(/^ci-ready \S+: \d of 5 checks scored/);
  });

  it('reports ci-ready out-of-window when the export is after --until', async () => {
    seedAllSources();
    await run(['--since', '2026-01-01', '--until', '2026-04-01']);
    const pack = readPack();
    const ciReady = pack.sources.find((s) => s.id === 'ci-ready');
    expect(ciReady).toMatchObject({ state: 'out-of-window', inWindow: 0 });
    expect(pack.items.some((i) => i.source === 'ci-ready')).toBe(false);
  });

  it('reports ci-ready unreadable when HEAD does not resolve', async () => {
    seedAllSources();
    await run(['--since', '2026-01-01'], {
      runSubprocess: () => ({ status: 128, stdout: '', stderr: 'fatal' }),
    });
    const pack = readPack();
    expect(pack.commit).toBeNull();
    const ciReady = pack.sources.find((s) => s.id === 'ci-ready');
    expect(ciReady).toMatchObject({ state: 'unreadable' });
  });

  it('takes the repository from GITHUB_REPOSITORY when --repo is not given', async () => {
    seedAllSources();
    await run(['--since', '2026-01-01'], {
      env: { GITHUB_REPOSITORY: 'acme/gadgets' },
    });
    const run1 = readPack().items.find((i) => i.source === 'history');
    expect(run1?.ref.url).toBe(
      `https://github.com/acme/gadgets/commit/${'a'.repeat(40)}`,
    );
  });

  it('replaces the previous pack in the same --out (criterion 10)', async () => {
    const out = join(root, 'packs');
    write(HISTORY, storedRun('first-run', '2026-03-01T00:00:00.000Z'));
    await run(['--since', '2026-01-01', '--out', out]);
    expect(readMarkdown(out)).toContain('first-run');
    write(HISTORY, storedRun('second-run', '2026-03-05T00:00:00.000Z'));
    await run(['--since', '2026-01-01', '--out', out]);
    const ids = readPack(out).items.map((i) => i.ref.id);
    expect(ids).toContain('second-run');
    expect(ids).not.toContain('first-run');
    expect(readMarkdown(out)).not.toContain('first-run');
  });

  it('prints root-relative source paths, never the absolute root', async () => {
    seedAllSources();
    const res = await run(['--since', '2026-01-01']);
    const text = JSON.stringify(readPack().sources) + readMarkdown();
    expect(text).not.toContain(root);
    expect(readPack().sources.map((s) => s.path)).toEqual([
      join('.canary', 'batwoman'),
      join('.canary', 'quarantine.json'),
      HISTORY,
      '.',
    ]);
    expect(res.stdout).toContain(
      `Wrote ${join(root, '.canary', 'evidence', 'evidence-pack.json')}`,
    );
    expect(res.stdout).toContain('evidence-pack.md');
  });

  it.each([
    ['--since is not a date', ['--since', 'last week'], 'last week'],
    ['--since is a local date-time', ['--since', '2026-01-01T10:00'], 'T10:00'],
    ['--until is not a date', ['--since', '2026-01-01', '--until', 'x'], 'x'],
    [
      '--since is not before --until',
      ['--since', '2026-03-01', '--until', '2026-03-01'],
      '2026-03-01T00:00:00.000Z',
    ],
    ['--since is after the export time', ['--since', '2027-01-01'], '2027'],
    [
      '--repo is not a slug',
      ['--since', '2026-01-01', '--repo', 'acme'],
      'acme',
    ],
  ])('exits 2 naming the value when %s', async (_name, args, named) => {
    const res = await run(args);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(named);
    expect(existsSync(join(root, '.canary', 'evidence'))).toBe(false);
  });

  it('exits 2 when --root does not exist', async () => {
    const missing = join(root, 'no-such-root');
    const res = await run(['--since', '2026-01-01', '--root', missing]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(missing);
  });
});

describe('canary evidence export: sources that are missing or broken', () => {
  it('keeps the other controls fed when the history store is corrupt (criterion 2)', async () => {
    seedAllSources();
    write(HISTORY, `${storedRun('r1', '2026-03-01T00:00:00.000Z')}{not json\n`);
    const res = await run(['--since', '2026-01-01']);
    expect(res.code).toBe(0);
    const pack = readPack();
    const history = pack.sources.find((s) => s.id === 'history');
    expect(history?.state).toBe('unreadable');
    expect(history?.reason).toContain('line 2');
    const byId = new Map(pack.controls.map((c) => [c.id, c]));
    expect(byId.get('cis-v8-7')).toMatchObject({
      status: 'evidence',
      items: 1,
    });
    expect(byId.get('soc2-cc8.1')).toMatchObject({ status: 'evidence' });
    expect(res.stdout).toContain('source history: unreadable (');
    expect(res.stdout).toContain('line 2');
  });

  it('reports each missing default path as absent, with a reason (criterion 3)', async () => {
    const res = await run(['--since', '2026-01-01']);
    const pack = readPack();
    for (const id of ['batwoman', 'katana', 'history']) {
      const source = pack.sources.find((s) => s.id === id);
      expect(source?.state, id).toBe('absent');
      expect(source?.reason, id).not.toBe('');
      expect(res.stdout).toContain(`source ${id}: absent (`);
    }
  });

  it('exits 2 when --batwoman names a missing directory (criterion 3)', async () => {
    const typo = join(root, 'batwomann');
    const res = await run(['--since', '2026-01-01', '--batwoman', typo]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(typo);
    expect(existsSync(join(root, '.canary', 'evidence'))).toBe(false);
  });

  it('reads saved reports from a --batwoman directory outside the default', async () => {
    const dir = join(root, 'saved');
    write(
      join('saved', '7.json'),
      JSON.stringify({
        issue: 7,
        pullRequest: 8,
        mergeSha: 'c'.repeat(40),
        mergedAt: '2026-03-03T00:00:00.000Z',
        files: [],
      }),
    );
    await run(['--since', '2026-01-01', '--batwoman', dir]);
    const source = readPack().sources.find((s) => s.id === 'batwoman');
    expect(source).toMatchObject({ path: dir, state: 'read', inWindow: 1 });
  });

  it('warns, names the cause and the first step, and still exits 0 when nothing produced an item (criterion 9)', async () => {
    const res = await run(['--since', '2026-01-01']);
    expect(res.code).toBe(0);
    expect(
      existsSync(join(root, '.canary', 'evidence', 'evidence-pack.md')),
    ).toBe(true);
    const warning = res.stdout.split('\n').find((l) => l.includes('Abstained'));
    expect(warning).toContain('No source produced an item in the window');
    expect(warning).toContain('history absent');
    expect(warning).toContain('First step: record a run with');
    expect(res.stdout).not.toContain('evidence: ');
  });

  it('does not warn when at least one source produced an item', async () => {
    seedAllSources();
    const res = await run(['--since', '2026-01-01']);
    expect(res.stdout).not.toContain('Abstained');
  });

  it('exits 1 naming the path and errno when --out cannot be created', async () => {
    write('blocker', 'a file where the directory should go');
    const out = join(root, 'blocker', 'packs');
    const res = await run(['--since', '2026-01-01', '--out', out]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(out);
    expect(res.stderr).toMatch(/ENOTDIR|EEXIST/);
    expect(res.stdout).not.toContain('Wrote');
  });
});
```

**Step 2.** Run `npx vitest run test/evidence-cli.test.ts`. Expect failure: the
module `src/evidence/cli.js` does not exist.

**Step 3.** In `ts/src/analysis/evidence/pack.ts`, replace everything above
`export const DISCLAIMER` (the header comment and the imports) with:

```ts
/** Builds the evidence pack (#855). `buildPack` is pure given a catalogue; `exportPack` reads the sources and writes the files. */

import type { CiReadyReport } from '../../core/ci-ready.js';
import { writePack } from './render.js';
import {
  loadCatalogue,
  noItems,
  oneItem,
  readBatwoman,
  readHistory,
  readLedger,
  typo,
} from './sources.js';
import type {
  CatalogueRow,
  EvidencePack,
  Outcome,
  Scope,
  SourceReport,
} from './types.js';
```

Then append this to the end of the file, after one blank line:

```ts
/** D10: one item, dated at the export and linked to HEAD; a score that scored nothing is no item. */
function ciReadySource(scope: Scope, score: () => CiReadyReport) {
  const src = { id: 'ci-ready' as const, path: '.', scope };
  const { at, commit } = scope;
  // Closed at `until`: the default window ends at the export time itself.
  const outside = at < scope.since || at > scope.until;
  if (outside) return noItems(src, 'out-of-window', `scored at ${at}`);
  if (commit === null) return noItems(src, 'unreadable', 'no HEAD commit');
  const report = score();
  if (report.checked === 0) return noItems(src, 'absent', 'no check scored');
  const checks = report.checks.map((c) => `${c.name} ${c.verdict}`).join(', ');
  const summary = `ci-ready ${report.verdict}: ${report.checked} of ${report.checks.length} checks scored (${checks})`;
  const ref = { kind: 'commit' as const, id: commit };
  return oneItem(src, { date: at, summary, ref });
}

export function exportPack(scope: Scope, score: () => CiReadyReport): Outcome {
  const problem = typo(scope);
  if (problem !== null) return { exit: 2, lines: [`evidence: ${problem}`] };
  const sources = [
    readBatwoman(scope),
    readLedger(scope),
    readHistory(scope),
    ciReadySource(scope, score),
  ];
  const out = scope.out ?? `${scope.root}/.canary/evidence`;
  return writePack(out, buildPack(sources, scope));
}
```

`pack.ts` is now 85 non-blank lines.

**Step 4.** Create `ts/src/evidence/cli.ts` (61 non-blank lines):

```ts
/** `canary evidence export` (#855): advisory; lists evidence and never grades it. Own folder so the filename binds the `cli` layer. */

import { Command } from 'commander';

import { exportPack } from '../analysis/evidence/pack.js';
import { ciReadyReportFor } from '../ci-ready-cli.js';
import { CliExitError, normalizeUsageExit } from '../cli-common.js';

/** The seams this command uses; `MainDeps` satisfies it. */
interface Deps {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  cwd(): string;
  runSubprocess(cmd: string, args: string[], opts: { cwd: string }): Git;
}

type Git = { status: number | null; stdout: string };

type ExportOpts = Record<string, string | undefined> & { since: string };

/** A bare date is midnight UTC; a date-time must carry its zone, so a window means the same on every machine. */
const ISO =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

function fail(deps: Deps, exit: number, lines: string[]): never {
  for (const line of lines) deps.err(line);
  throw new CliExitError(exit);
}

function instant(deps: Deps, flag: string, raw: string): string {
  const ms = ISO.test(raw) ? Date.parse(raw) : NaN;
  const bad = `evidence: ${flag} ${raw} is not an ISO 8601 date`;
  return Number.isNaN(ms) ? fail(deps, 2, [bad]) : new Date(ms).toISOString();
}

function runExport(deps: Deps, opts: ExportOpts, at: string): void {
  const { batwoman, out, root = deps.cwd() } = opts;
  const since = instant(deps, '--since', opts.since);
  const until = opts.until ? instant(deps, '--until', opts.until) : at;
  const order = `evidence: --since ${since} is not before ${until}`;
  if (since >= until) fail(deps, 2, [order]);
  const git = deps.runSubprocess('git', ['rev-parse', 'HEAD'], { cwd: root });
  const sha = git.stdout.trim();
  const commit = git.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  const repo = opts.repo || deps.env['GITHUB_REPOSITORY'] || undefined;
  const scope = { since, until, root, out, at, commit, repo, batwoman };
  const done = exportPack(scope, () => ciReadyReportFor(root));
  if (done.exit !== 0) fail(deps, done.exit, done.lines);
  for (const line of done.lines) deps.out(line);
}

export function buildEvidenceCommand(
  deps: Deps,
  now: () => Date = () => new Date(),
): Command {
  const command = new Command('evidence');
  command.description('Audit evidence: lists what ran, never grades it.');
  command
    .command('export')
    .description('Write a control-mapped evidence pack for a time window.')
    .requiredOption('--since <date>', 'Start: ISO date or zoned date-time.')
    .option('--until <date>', 'End, exclusive (default: now).')
    .option('--root <dir>', 'Repository root (default: cwd).')
    .option('--batwoman <dir>', 'Saved `canary batwoman --json` reports.')
    .option('--out <dir>', 'Output directory (default: .canary/evidence).')
    .option('--repo <owner/name>', 'Repository for commit URLs.')
    .exitOverride(normalizeUsageExit)
    .action((opts: ExportOpts) => runExport(deps, opts, now().toISOString()));
  return command;
}
```

**Step 5.** Run these three files. Expect 63 tests passed.

```bash
npx vitest run test/evidence-cli.test.ts test/evidence-pack.test.ts test/evidence-sources.test.ts
```

**Step 6.** Run these from `ts/`:

```bash
npm run typecheck
npx prettier --check src/analysis/evidence/pack.ts src/evidence/cli.ts test/evidence-cli.test.ts
```

**Step 7.** Run `harness validate` and `harness check-deps` from the repo root.
`ts/src/evidence/cli.ts` binds the `cli` layer by its filename.

**Step 8.** Commit with this message:

```text
feat(evidence): add canary evidence export (#855)
```

### Task 9: Register the command and its conformance row

**Depends on:** Task 8 | **Files:** ts/test/cli-command-registry.test.ts,
ts/test/gate-conformance.test.ts, ts/src/commands/audit/cli.ts | **Category:**
integration

**Step 1.** In `ts/test/cli-command-registry.test.ts`, in `EXPECTED_COMMANDS`,
find:

```text
  'critical-areas',
  'scaling-curve',
```

Replace with:

```text
  'critical-areas',
  'evidence',
  'scaling-curve',
```

**Step 2.** In `ts/test/gate-conformance.test.ts`, add this row to `ROWS`
directly after the `critical-areas` row, which is the last one:

```text
  {
    // #855: no source holds a record, so the pack lists six controls and no
    // evidence. It is still written, but an "evidence: N" line here would be a
    // count of nothing.
    command: 'evidence export (root holding none of its four sources)',
    layer: 'engine',
    kind: 'advisory',
    expect: 'warnLine',
    forbid: ['evidence: '],
    run: (base) =>
      invokeCanary([
        'evidence',
        'export',
        '--since',
        '2026-01-01',
        '--root',
        base,
      ]),
  },
```

**Step 3.** Run both files. Expect two failures: the command list does not
match, and `evidence` is an unknown command.

```bash
npx vitest run test/cli-command-registry.test.ts test/gate-conformance.test.ts
```

**Step 4.** In `ts/src/commands/audit/cli.ts`, add this import directly after
the `buildCriticalAreasCommand` import:

```ts
import { buildEvidenceCommand } from '../../evidence/cli.js';
```

Add this entry to `AUDIT_COMMANDS` directly after the
`buildCriticalAreasCommand` entry:

```text
  (deps) => buildEvidenceCommand(deps),
```

The registry now has 7 imports; its test caps a registry at 12.

**Step 5.** Run the same command again. Expect all tests passed, including the
row named `evidence export (root holding none of its four sources)`.

**Step 6.** Run these from `ts/`:

```bash
npm run typecheck
npx prettier --check src/commands/audit/cli.ts test/cli-command-registry.test.ts test/gate-conformance.test.ts
```

**Step 7.** Run `harness validate` and `harness check-deps`.

**Step 8.** Commit with this message:

```text
feat(evidence): mount evidence under the audit commands (#855)
```

### Task 10: Guide and guides index

**Depends on:** Task 8 | **Files:** docs/guides/audit-evidence-export.md,
docs/guides/index.md | **Category:** integration

**Step 1.** Create `docs/guides/audit-evidence-export.md` with exactly this
content. The five links under "Where the code lives" are what the docs-coverage
ratchet counts; keep them as Markdown links.

````markdown
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
  ledger recorded. A batwoman report carries its per-file statuses, including
  `not-exercised`.
- `ref`: a run id, a ledger key `file::test`, or a commit SHA, so the item can
  be found again in its source. A commit gets a GitHub URL only when the
  repository is known from `--repo`, `GITHUB_REPOSITORY`, or the `repo` field of
  a batwoman report. A URL is never guessed from a git remote.
- `controls`: the catalogue ids the item supports.

A failed run, a `not-ready` score and a report whose files were never exercised
are all items. The pack does not choose what an auditor sees.

The Markdown lists at most 25 items per source, newest first, and then says how
many more are in the JSON. The JSON holds all of them.

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
````

**Step 2.** In `docs/guides/index.md`, insert this entry directly above the
heading `### [LLM Providers Guide](./llm-providers.md)`:

```text
### [Audit Evidence Export Guide](./audit-evidence-export.md)

`canary evidence export` — writes one evidence pack for a time window from saved
batwoman reports, the katana ledger, run history and the `ci-ready` score, with
each item mapped to the controls it supports. Covers the window, the five source
states, the control catalogue and why an empty control still prints.

**Best for:** Handing an auditor or a procurement reviewer the record of what
ran, without claiming a control is met.
```

Keep one blank line between this entry and the heading below it.

**Step 3.** From the repo root, run both checks. Expect both clean.

```bash
npx prettier --check docs/guides/audit-evidence-export.md docs/guides/index.md
npx --yes markdownlint-cli@0.50.1 docs/guides/audit-evidence-export.md docs/guides/index.md
```

**Step 4.** From the repo root, run `node scripts/check_doc_links.mjs` and
`node scripts/check_doc_fences.mjs`. Expect exit 0 from both.

**Step 5.** Run `harness validate`.

**Step 6.** Commit with this message:

```text
docs(evidence): add the audit evidence export guide (#855)
```

### Task 11: AGENTS.md, CHANGELOG and the roadmap row

**Depends on:** Task 10 | **Files:** AGENTS.md, CHANGELOG.md, docs/roadmap.md |
**Category:** integration

**Step 1.** In `AGENTS.md`, under "Entry Points", find:

```text
  `inventory`, `gen-data`, `php floor`, `php audit`.
```

Replace with:

```text
  `inventory`, `gen-data`, `php floor`, `php audit`, `evidence export`.
```

**Step 2.** In `CHANGELOG.md`, directly under the line `## [Unreleased]`, add:

```text
### Added

- **`canary evidence export --since <date>` writes a control-mapped audit
  evidence pack (#855).** It reads saved `canary batwoman --json` reports, the
  katana ledger, the run-history store and the `ci-ready` score for a time
  window, and writes `evidence-pack.json` and `evidence-pack.md`. Each item is
  mapped to the NIST SP 800-40, ISO/IEC 27001, CIS and SOC 2 controls it
  supports and names the commit, run or ledger entry it came from. A control
  with no evidence prints `NO EVIDENCE`, and a source that is missing or cannot
  be read is listed with the reason. The pack is an aid, not an attestation: it
  counts evidence and never grades it. See the
  [guide](docs/guides/audit-evidence-export.md).
```

Keep one blank line between `## [Unreleased]` and `### Added`, and one between
the bullet and `## [10.0.0] - 2026-11-26`.

**Step 3.** In `docs/roadmap.md`, under the heading
`### Audit evidence export — control-mapped evidence pack`, replace the line
`- **Plan:** —` with this single physical line:

```text
- **Plan:** docs/changes/855-audit-evidence-export/plans/2026-11-27-audit-evidence-export-plan.md
```

Do not run prettier on `docs/roadmap.md` and do not run `harness roadmap sync`.
The file is listed in `.prettierignore` because each field must stay on one
line.

**Step 4.** From the repo root, run both checks. Expect both clean.

```bash
npx prettier --check AGENTS.md CHANGELOG.md
npx --yes markdownlint-cli@0.50.1 AGENTS.md CHANGELOG.md docs/roadmap.md
```

**Step 5.** Run `node scripts/check_doc_links.mjs` from the repo root. Expect
exit 0.

**Step 6.** Run `harness validate`.

**Step 7.** Commit with this message:

```text
docs(evidence): list evidence export in AGENTS.md, changelog and roadmap (#855)
```

### Task 12: Four gates, ratchets and the line budget

**Depends on:** Tasks 9, 11 | **Files:** none (measurement only)

Covers criterion 12. This task changes no file. If any step fails, stop and
report the output. Do not add an allowance, do not edit a baseline, and do not
edit `harness.config.json`.

**Step 1.** Four gates, from `ts/`:

```bash
cd /Users/bs/Github/canary-855/ts && npm run build
cd /Users/bs/Github/canary-855/ts && npm run typecheck
cd /Users/bs/Github/canary-855/ts && npm run format:check
cd /Users/bs/Github/canary-855/ts && npm test
```

Expect all four to pass. The five new test files hold 78 tests between them.

**Step 2.** The built command, which proves the catalogue ships in `dist/`:

```bash
cd /Users/bs/Github/canary-855/ts && node bin/canary.js evidence export --since 2026-01-01 --root "$(mktemp -d)"
```

Expect exit 0, six `NO EVIDENCE` lines, an `Abstained` line and two `Wrote`
lines.

**Step 3.** The line budget:

```bash
/bin/bash -c 'cd /Users/bs/Github/canary-855 && total=0 && for f in $(git diff --name-only 45b59eef -- ts/src | grep "\.ts$"); do after=$(grep -cv "^[[:space:]]*$" "$f"); before=$(git show "45b59eef:$f" 2>/dev/null | grep -cv "^[[:space:]]*$"); total=$((total + after - before)); echo "$((after - before)) $f"; done; echo "net $total"'
```

Expect seven files and `net 477`. Anything above 480 fails the task.

**Step 4.** Layers and structure, from the repo root: `harness validate` and
`harness check-deps`. Expect both to pass.

**Step 5.** The arch verdict, from the repo root:

```bash
cd /Users/bs/Github/canary-855 && out="$(mktemp -d)" && (harness check-arch --json > "$out/arch.json" || true) && node scripts/arch-verdict.mjs "$out/arch.json"
```

Expect exit 0 and no line naming a file under `ts/src/evidence/` or
`ts/src/analysis/evidence/`. A `REGRESSION` that names one of those files means
an import was added to it; compare with the coupling table above. A `REGRESSION`
that names only the `module-size` metric means the line total crossed its floor:
stop and report it, because the fix is an allowance this plan may not add.

**Step 6.** The perf count, from the repo root:

```bash
cd /Users/bs/Github/canary-855 && out="$(mktemp -d)" && (harness check-perf > "$out/perf.txt" 2>&1 || true) && head -1 "$out/perf.txt" && (grep -n -A1 "evidence/" "$out/perf.txt" || echo "no finding under evidence/")
```

Expect `Validation failed (200 issues)`, the count measured on this branch
before any change, and `no finding under evidence/`. The ceiling in
`.harness/perf-baseline.json` is 201, so one new finding of any kind uses the
last of the headroom and two fail the gate.

**Step 7.** Entropy, from the repo root:

```bash
cd /Users/bs/Github/canary-855 && out="$(mktemp -d)" && (harness cleanup --findings-json > "$out/entropy.txt" 2>&1 || true) && (grep -n "evidence/" "$out/entropy.txt" || echo "no finding under evidence/")
```

Expect `no finding under evidence/`. A dead-export or unreachable-file finding
on a new module means an export lost its importer.

**Step 8.** Docs coverage, from the repo root:

```bash
cd /Users/bs/Github/canary-855 && out="$(mktemp -d)" && (harness check-docs --json --min-coverage 0 > "$out/docs.json" || true) && node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(d.coveragePercent, d.undocumented.filter((f) => f.startsWith("ts/src/") && f.includes("evidence")));' "$out/docs.json"
```

Expect a number of 27 or more followed by `[]`. The floor in
`.harness/docs-coverage-baseline.json` is 26.73, and an empty list means all
five new source files are documented.

**Step 9.** The two strict scanners, from the repo root:

```bash
cd /Users/bs/Github/canary-855 && node agents/skills/claude-code/canary-blackhawk/scripts/cli.mjs ts/test agents/skills/test --strict
cd /Users/bs/Github/canary-855 && node agents/skills/claude-code/canary-savant/scripts/cli.mjs ts/test agents/skills/test --strict
```

Expect no finding in the five new test files.

**Step 10.** Confirm the worktree is clean with
`git -C /Users/bs/Github/canary-855 status --short`. Nothing to commit in this
task.

## Traceability

| Criterion | Tests                                                                                                                 | Task    |
| --------- | --------------------------------------------------------------------------------------------------------------------- | ------- |
| 1         | `evidence-pack.test.ts` "every source empty" (4 tests); `evidence-cli.test.ts` "writes both files with all six"       | 2, 8    |
| 2         | `evidence-sources.test.ts` "is unreadable, naming the line"; `evidence-cli.test.ts` "keeps the other controls fed"    | 3, 8    |
| 3         | `evidence-sources.test.ts` absent cases and `typo`; `evidence-cli.test.ts` "missing default path", "exits 2 when ..." | 3, 4, 8 |
| 4         | `evidence-sources.test.ts` catalogue pins, "no identifier"; `evidence-cli.test.ts` "links every item"                 | 3, 4, 8 |
| 5         | `evidence-pack.test.ts` "carries the disclaimer in both formats"                                                      | 2       |
| 6         | `evidence-sources.test.ts` "includes a run dated at since and excludes one dated at until"                            | 3       |
| 7         | `evidence-cli.test.ts` "ends the window at the export time when --until is omitted"                                   | 8       |
| 8         | `evidence-render.test.ts` "lists 25 of 500 runs"                                                                      | 5       |
| 9         | `evidence-render.test.ts` "warns with the cause"; `evidence-cli.test.ts` "warns, names the cause"; conformance row    | 6, 8, 9 |
| 10        | `evidence-render.test.ts` "replaces the previous pack"; `evidence-cli.test.ts` "replaces the previous pack"           | 6, 8    |
| 11        | `evidence-sources.test.ts` "lists a not-exercised report"; `evidence-pack.test.ts` "has no graded field"              | 2, 4    |
| 12        | Task 12 steps 1 to 9                                                                                                  | 12      |

Integration points of the spec: the command and the `ci-ready` export (Tasks 7,
8), `AUDIT_COMMANDS`, `EXPECTED_COMMANDS` and the conformance row (Task 9), the
guide and index (Task 10), AGENTS.md, CHANGELOG and the roadmap row (Task 11).
The spec names no ADR. `harness knowledge-pipeline --domain evidence` reported 0
findings, so there is no knowledge task.

## Change specification

- [ADDED] `canary evidence export` and its six flags.
- [ADDED] `ts/src/data/evidence/controls.json`, shipped to `dist/data/`.
- [ADDED] `ciReadyReportFor(root)` exported from `ts/src/ci-ready-cli.ts`.
- [MODIFIED] `canary ci-ready` builds its report through `ciReadyReportFor`. Its
  output and exit codes do not change; `ts/test/ci-ready-cli.test.ts` is the
  proof.
- [MODIFIED] `canary --help` lists `evidence` after `critical-areas`.

## Checked while planning (design input, not delivery)

Nothing below is committed. The code in this plan was assembled in a scratch
copy of `ts/` outside the repository, to make sure the snippets are exact. The
executor still runs every test first and watches it fail.

- Tasks 1 to 9 were replayed in order on a clean copy. Each test file failed
  before its implementation and passed after it, with `tsc` and
  `prettier --check` clean at every step, and the replay ended on files
  identical to the ones measured.
- 78 tests across the five new files. Five planted defects were run against them
  (the `until` bound, the item cap, a dropped empty control, a missing warning,
  the `ci-ready` bound) and each was caught.
- `harness check-deps` passed on the copy. `harness check-perf` reported the
  same count with and without the change (the copy holds `ts/` only, so its
  absolute number is not the repository's 200). `harness check-arch --json`
  against the repository's baseline reported no new violation and no regression.
- `canary-blackhawk --strict` and `canary-savant --strict` reported no finding
  in the new test files.
- The built CLI was run from `dist/` against an empty root and against a root
  seeded with all four sources.
- Not checked: the full `npm test` run, the entropy scan with the repository's
  full entry-point list, and docs coverage. Task 12 does all three.
