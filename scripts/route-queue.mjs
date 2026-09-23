#!/usr/bin/env node
// The routed-queue contract for issue-fleet (#1071).
//
//   node scripts/route-queue.mjs ensure-labels           # dry run (default)
//   node scripts/route-queue.mjs ensure-labels --apply   # create missing labels
//   node scripts/route-queue.mjs report                  # denominator report
//   node scripts/route-queue.mjs report --json           # machine-readable
//
// `ensure-labels` only ever ADDS; nothing here deletes or renames a label.
//
// `report` answers the question the issue asks — "N routed, M unroutable, and
// here is which" — over the OPEN ISSUES THEMSELVES. It deliberately never
// passes `--label` to `gh issue list`: that filter lags writes and
// under-reports (observed twice during the run that filed #1071, where a
// freshly-applied `fleet:claimed` was absent from a list query but present on
// a direct `gh issue view`). A denominator built on it under-counts silently
// and still looks green, which is the exact shape this feature exists to
// close. `ts/test/route-labels.test.ts` asserts the absence of that flag from
// the recorded argv, not merely that the number came out right.
//
// Exit codes (repo gate convention, #508):
//   0 = verified — examined >= 1 open issue and reported it
//   2 = usage or gh error
//   3 = ABSTENTION — examined zero open issues, or the tracker was unreadable
import { spawnSync } from 'node:child_process';

import {
  ROUTE_LABELS,
  UNROUTABLE,
  partitionByRoute,
} from './lib/route-labels.mjs';

function fail(code, msg) {
  process.stderr.write(`route-queue: ${msg}\n`);
  process.exit(code);
}

// ROUTE_QUEUE_GH_STUB lets tests record gh argv without reaching GitHub,
// mirroring BACKFILL_GH_STUB in backfill-type-labels.mjs.
function gh(args) {
  const stub = process.env.ROUTE_QUEUE_GH_STUB;
  const [cmd, argv] = stub ? [process.execPath, [stub, ...args]] : ['gh', args];
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) {
    // Exit 2, never 3: a tracker that could not be READ is an error, and
    // reporting it as an empty tracker would turn "could not look" into
    // "nothing to see".
    fail(2, `gh ${args.join(' ')} failed: ${r.stderr || r.error}`);
  }
  return r.stdout;
}

/** Every open issue with its labels — no `--label` filter, by design. */
function openIssues() {
  return JSON.parse(
    gh([
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      '1000',
      '--json',
      'number,title,labels',
    ]),
  );
}

function existingRouteLabels() {
  const all = JSON.parse(
    gh(['label', 'list', '--limit', '200', '--json', 'name']),
  );
  return new Set(all.map((l) => l.name));
}

function ensureLabels(opts) {
  const present = existingRouteLabels();
  const missing = ROUTE_LABELS.filter((l) => !present.has(l));

  if (missing.length === 0) {
    console.log(
      `vocabulary complete: all ${ROUTE_LABELS.length} route:* labels exist.`,
    );
    return;
  }

  if (!opts.apply) {
    console.log(
      `dry run: ${missing.length} of ${ROUTE_LABELS.length} route:* labels missing:\n  ` +
        missing.join('\n  ') +
        `\nre-run with --apply to create them.`,
    );
    return;
  }

  for (const label of missing) {
    const description =
      label === UNROUTABLE
        ? 'issue-fleet triaged this issue and found no legal destination fleet'
        : `issue-fleet routed this issue to ${label.slice('route:'.length)}-fleet`;
    gh([
      'label',
      'create',
      label,
      '--description',
      description,
      '--color',
      'BFD4F2',
    ]);
  }
  console.log(`created ${missing.length} label(s): ${missing.join(', ')}`);
}

function report(opts) {
  const issues = openIssues();
  const p = partitionByRoute(issues);

  if (p.examined === 0) {
    // Zero examined is an abstention, not a clean board. "0 routed" printed
    // with exit 0 is indistinguishable from a tracker nobody could read.
    fail(3, 'ABSTENTION: examined zero open issues; this is not a pass.');
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(p, null, 2) + '\n');
    return;
  }

  const list = (rows) =>
    rows.length === 0 ? 'none' : rows.map((r) => `#${r.number}`).join(', ');

  console.log(
    `examined ${p.examined} open issue(s): ` +
      `${p.routed.length} routed, ${p.unroutable.length} unroutable, ` +
      `${p.untriaged.length} untriaged, ${p.conflicted.length} conflicted.`,
  );
  console.log(`  routed:     ${list(p.routed)}`);
  console.log(`  unroutable: ${list(p.unroutable)}`);
  console.log(`  untriaged:  ${list(p.untriaged)}`);
  console.log(`  conflicted: ${list(p.conflicted)}`);
}

const [subcommand, ...rest] = process.argv.slice(2);
const opts = { apply: rest.includes('--apply'), json: rest.includes('--json') };

for (const a of rest) {
  if (a !== '--apply' && a !== '--json') fail(2, `unknown argument ${a}`);
}

if (subcommand === 'ensure-labels') ensureLabels(opts);
else if (subcommand === 'report') report(opts);
else fail(2, `unknown subcommand ${subcommand ?? '(none)'}`);
