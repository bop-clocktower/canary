#!/usr/bin/env node
// canary-savant -- order-dependence and isolation detector (Tier-1 static scan).
//
// Phase 1 ships the always-on static "suspect" tier: an AST-lite scan that
// flags the shared-state smells that predict order-dependent tests -- module-
// level mutables written by tests, setup without teardown, mutated process
// singletons, order-coupled names -- with no test execution. The opt-in
// dynamic confirmer (--confirm) lands in a later phase.
//
//   <paths>    files or directories to scan (default: the current directory).
//   --json     emit machine-readable findings instead of human text.
//   --strict   exit 1 when there are findings (default is advisory: exit 0).
//
// Tier-0 in the real sense -- no LLM, no network, no secrets, no dependency on
// any other skill.
//
// Invoked via `canary skills run canary-savant -- [paths] [--json] [--strict]`.

import fs from 'node:fs';
import { scanPaths, toJson } from './scanner.mjs';
import { confirm } from './runner.mjs';

export const SCHEMA_VERSION = 1;

function summary(result) {
  const bySeverity = {};
  for (const f of result.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }
  return {
    files_scanned: result.filesScanned,
    findings: result.findings.length,
    by_severity: bySeverity,
  };
}

function renderText(result) {
  const count = result.findings.length;
  const files = result.filesScanned;
  const fp = files === 1 ? '' : 's';
  if (!count) {
    return `No order-dependence suspects (${files} file${fp} scanned).`;
  }
  const sp = count === 1 ? '' : 's';
  const lines = [
    `${count} order-dependence suspect${sp} in ${files} file${fp}:`,
    '',
  ];
  for (const f of result.findings) {
    lines.push(`  ${f.file}:${f.line}  [${f.severity}] ${f.ruleId}`);
    lines.push(`      ${f.snippet}`);
    lines.push(`      why: ${f.why}`);
  }
  lines.push('');
  lines.push(
    'Advisory by default. Re-run with --strict to fail the step on findings.',
  );
  return lines.join('\n');
}

function parseArgs(argv) {
  const paths = [];
  const opts = { json: false, strict: false, confirm: false, seed: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--confirm') opts.confirm = true;
    else if (arg === '--seed') {
      opts.seed = Number(argv[i + 1]);
      i += 1;
    } else paths.push(arg);
  }
  return { paths: paths.length ? paths : ['.'], opts };
}

export function renderConfirm(dyn) {
  if (dyn.status === 'no_plugin' || dyn.status === 'baseline_red') {
    return `\nTier 2 (dynamic): skipped - ${dyn.message}`;
  }
  const lines = [`\nTier 2 (dynamic): seed ${dyn.seed}`];
  if (!dyn.victims.length) {
    lines.push('  No order-dependence confirmed under this seed.');
  } else {
    for (const v of dyn.victims) {
      lines.push(`  order-dependent: ${v.victim}`);
    }
    lines.push(`  reproduce: ${dyn.reproduce}`);
  }
  if (dyn.nondeterministic.length) {
    lines.push(
      `  (${dyn.nondeterministic.length} nondeterministic flake(s) - not order, handed off)`,
    );
  }
  return lines.join('\n');
}

export function main(argv = []) {
  const { paths, opts } = parseArgs(argv);

  for (const entry of paths) {
    if (!fs.existsSync(entry)) {
      console.error(`canary-savant: path not found: ${entry}`);
      return 1;
    }
  }

  const result = scanPaths(paths);

  let dyn;
  if (opts.confirm) {
    const seed = Number.isFinite(opts.seed)
      ? opts.seed
      : Math.floor(Math.random() * 1e6);
    dyn = confirm(paths, { seed });
  }

  if (opts.json) {
    const payload = {
      schema_version: SCHEMA_VERSION,
      findings: result.findings.map(toJson),
      summary: summary(result),
    };
    if (dyn) {
      payload.dynamic = {
        status: dyn.status,
        seed: dyn.seed,
        victims: dyn.victims,
        nondeterministic: dyn.nondeterministic,
        reproduce: dyn.reproduce,
        ...(dyn.message ? { message: dyn.message } : {}),
      };
    }
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderText(result) + (dyn ? renderConfirm(dyn) : ''));
  }

  const hasViolation =
    result.findings.length > 0 || (dyn?.victims.length ?? 0) > 0;
  return opts.strict && hasViolation ? 1 : 0;
}

// Direct execution (the skill runner execs this file via its shebang).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
