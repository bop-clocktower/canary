#!/usr/bin/env node
// Backfill a type label onto open harness-managed issues that have none (#880).
//
//   node scripts/backfill-type-labels.mjs            # dry run (the default)
//   node scripts/backfill-type-labels.mjs --json     # machine-readable plan
//   node scripts/backfill-type-labels.mjs --apply    # add the labels
//
// Only ever ADDS a label; nothing here can remove one. The filing-path fix is
// upstream (Intense-Visions/harness-engineering#2146) — until it lands, new
// roadmap-synced issues will need this again.
//
// Exit codes (repo gate convention, #508):
//   0 = examined >= 1 harness-managed issue
//   2 = usage or gh error
//   3 = ZERO DENOMINATOR — examined no harness-managed issue; never a pass
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { MANAGED_LABEL, planBackfill } from './lib/type-label-infer.mjs';

function fail(code, msg) {
  process.stderr.write(`backfill-type-labels: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { apply: false, json: false, issuesJson: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--issues-json') opts.issuesJson = argv[++i];
    else fail(2, `unknown argument ${a}`);
  }
  if (opts.issuesJson === undefined) fail(2, '--issues-json needs a path');
  return opts;
}

// BACKFILL_GH_STUB lets tests record gh argv without reaching GitHub.
function gh(args) {
  const stub = process.env.BACKFILL_GH_STUB;
  const [cmd, argv] = stub ? [process.execPath, [stub, ...args]] : ['gh', args];
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) {
    fail(2, `gh ${args.join(' ')} failed: ${r.stderr || r.error}`);
  }
  return r.stdout;
}

function loadIssues(opts) {
  if (opts.issuesJson) return JSON.parse(readFileSync(opts.issuesJson, 'utf8'));
  return JSON.parse(
    gh([
      'issue',
      'list',
      '--state',
      'open',
      '--label',
      MANAGED_LABEL,
      '--limit',
      '1000',
      '--json',
      'number,title,body,labels',
    ]),
  );
}

const opts = parseArgs(process.argv.slice(2));
const { examined, plan } = planBackfill(loadIssues(opts));

if (examined === 0) {
  fail(3, `ZERO DENOMINATOR: examined no open ${MANAGED_LABEL} issues.`);
}

if (opts.json) {
  process.stdout.write(JSON.stringify({ examined, plan }, null, 2) + '\n');
} else {
  const mode = opts.apply ? 'apply' : 'dry run';
  console.log(
    `${mode}: examined ${examined} open ${MANAGED_LABEL} issues; ` +
      `${plan.length} lack a type label.`,
  );
  for (const p of plan) {
    console.log(`  #${p.number}  +${p.label}  (${p.reason})  ${p.title}`);
  }
}

if (opts.apply) {
  for (const p of plan) {
    gh(['issue', 'edit', String(p.number), '--add-label', p.label]);
  }
}
