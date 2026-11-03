#!/usr/bin/env node
// Regenerate docs/SECURITY_LEDGER.md and trim the security timeline.
//
// The harness CLI appends a snapshot to .harness/security/timeline.json on
// every security scan. Left alone, the file grows without bound. This script:
//
//   1. Trims timeline.json to the most recent TIMELINE_MAX_SNAPSHOTS snapshots
//      (lifecycles are kept in full — bounded by the number of distinct
//      findings, not by scan frequency).
//   2. Renders a short human-readable summary at docs/SECURITY_LEDGER.md.
//
// Both outputs are deterministic given the same input. Run with no arguments;
// CI invokes the script and fails the PR if `git diff --exit-code` is dirty
// afterwards (the freshness guard).
//
// The supply-chain line comes from .harness/security/supply-chain.json, never
// from a snapshot's `supplyChain` field: harness does not populate that field,
// so it reads 0 with or without a vulnerable package pinned (#1436). The sidecar
// is written by scripts/supply_chain_audit.mjs and committed with the ledger. No
// audit runs here, or the guard would depend on the network and the day's
// advisories. A missing or unusable sidecar reads "not measured", never 0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMELINE = resolve(REPO_ROOT, '.harness', 'security', 'timeline.json');
const LEDGER = resolve(REPO_ROOT, 'docs', 'SECURITY_LEDGER.md');
const SUPPLY_CHAIN = resolve(
  REPO_ROOT,
  '.harness',
  'security',
  'supply-chain.json',
);
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];
const SNAPSHOT_WINDOW = 10;
const TIMELINE_MAX_SNAPSHOTS = 30;

// Match Python's json.dumps(data, indent=2): 2-space indent AND ensure_ascii
// (escape every non-ASCII code unit as \uXXXX, surrogate pairs included) so the
// on-disk bytes are identical to the previous Python writer.
const NON_ASCII = new RegExp('[\\u0080-\\uffff]', 'g');
function pyJsonDumpsIndent2(data) {
  const s = JSON.stringify(data, null, 2);
  return s.replace(
    NON_ASCII,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

function loadTimeline() {
  if (!existsSync(TIMELINE)) return { snapshots: [], findingLifecycles: [] };
  return JSON.parse(readFileSync(TIMELINE, 'utf-8'));
}

function loadSupplyChain() {
  if (!existsSync(SUPPLY_CHAIN)) return null;
  try {
    return JSON.parse(readFileSync(SUPPLY_CHAIN, 'utf-8'));
  } catch {
    return null;
  }
}

function hasCounts(entry) {
  const v = entry?.vulnerabilities;
  return (
    entry?.status === 'measured' &&
    [...SEVERITIES, 'total'].every((k) => Number.isInteger(v?.[k]))
  );
}

function notMeasured(lockfiles, why) {
  const failedPaths = lockfiles
    .filter((e) => !hasCounts(e))
    .map((e) => `\`${e?.path ?? '?'}\``);
  if (!failedPaths.length) return `not measured (${why})`;
  return (
    `not measured (${failedPaths.length} of ${lockfiles.length} lockfile ` +
    `audits failed: ${failedPaths.join(', ')})`
  );
}

// One failed lockfile makes the whole line "not measured": a partial sum would
// read as the repo's count. The sidecar keeps the per-lockfile numbers.
function fmtSupplyChain(audit) {
  const lockfiles = audit?.lockfiles;
  if (!Array.isArray(lockfiles)) return notMeasured([], 'no audit recorded');
  if (!lockfiles.length) {
    return notMeasured([], audit.reason ?? 'no tracked lockfiles');
  }
  if (!lockfiles.every(hasCounts)) return notMeasured(lockfiles);
  return fmtMeasured(audit, lockfiles);
}

function fmtMeasured(audit, lockfiles) {
  const sum = (k) =>
    lockfiles.reduce((acc, e) => acc + e.vulnerabilities[k], 0);
  const noun = lockfiles.length === 1 ? 'lockfile' : 'lockfiles';
  return (
    `${sum('total')} (` +
    SEVERITIES.map((k) => `${k}: ${sum(k)}`).join(', ') +
    `) across ${lockfiles.length} ${noun}, ` +
    `audited ${String(audit.capturedAt ?? '?').slice(0, 10)} ` +
    `at \`${String(audit.commit ?? '').slice(0, 12)}\``
  );
}

function fmtSnapshotRow(s) {
  const sev = s.bySeverity ?? {};
  return (
    `| ${(s.capturedAt ?? '?').slice(0, 19)} ` +
    `| \`${(s.commitHash || '').slice(0, 7)}\` ` +
    `| ${s.securityScore ?? '?'} ` +
    `| ${s.totalFindings ?? 0} ` +
    `| ${sev.error ?? 0}/${sev.warning ?? 0}/${sev.info ?? 0} |`
  );
}

function render(data, audit) {
  const snapshots = data.snapshots ?? [];
  const lifecycles = data.findingLifecycles ?? [];

  const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const window = snapshots.length ? snapshots.slice(-SNAPSHOT_WINDOW) : [];
  const openFindings = lifecycles.filter((f) => !f.resolvedAt);
  const resolvedCount = lifecycles.filter((f) => f.resolvedAt).length;

  const lines = [];
  lines.push('# Security Ledger');
  lines.push('');
  // Machine-generated ledger: snapshot rows can exceed 80 cols by design.
  // Disable the line-length rule so CI/pre-commit markdownlint stays green
  // without an (protect-config-guarded) .markdownlintignore entry.
  lines.push('<!-- markdownlint-disable-file MD013 -->');
  lines.push('');
  lines.push('Auto-generated summary of `.harness/security/timeline.json`');
  lines.push('and `.harness/security/supply-chain.json`.');
  lines.push('Do not edit by hand — run `node scripts/security_ledger.mjs`');
  lines.push('to refresh.');
  lines.push('');

  lines.push('## Latest Snapshot');
  lines.push('');
  const supplyLine = `- **Supply chain:** ${fmtSupplyChain(audit)}`;
  if (latest === null) {
    lines.push('_No scans recorded yet._');
    lines.push('');
    lines.push(supplyLine);
  } else {
    const sev = latest.bySeverity ?? {};
    lines.push(`- **Captured:** ${latest.capturedAt ?? '?'}`);
    lines.push(`- **Commit:** \`${(latest.commitHash || '').slice(0, 12)}\``);
    lines.push(`- **Score:** ${latest.securityScore ?? '?'}`);
    lines.push(
      `- **Findings:** ${latest.totalFindings ?? 0} ` +
        `(error: ${sev.error ?? 0}, ` +
        `warning: ${sev.warning ?? 0}, ` +
        `info: ${sev.info ?? 0})`,
    );
    lines.push(supplyLine);
    lines.push(`- **Suppressions:** ${latest.suppressionCount ?? 0}`);
  }
  lines.push('');

  lines.push(`## Recent Snapshots (last ${SNAPSHOT_WINDOW})`);
  lines.push('');
  if (!window.length) {
    lines.push('_No snapshots._');
  } else {
    lines.push('| Captured | Commit | Score | Findings | Err/Warn/Info |');
    lines.push('| --- | --- | ---: | ---: | --- |');
    for (const s of window) lines.push(fmtSnapshotRow(s));
  }
  lines.push('');

  lines.push('## Open Findings');
  lines.push('');
  if (!openFindings.length) {
    lines.push('_None._');
  } else {
    for (const f of openFindings) {
      lines.push(
        `- **${f.ruleId ?? '?'}** ` +
          `(${f.severity ?? '?'}, ${f.category ?? '?'}) — ` +
          `\`${f.file ?? '?'}\` ` +
          `first seen ${(f.firstSeenAt ?? '?').slice(0, 19)}`,
      );
    }
  }
  lines.push('');

  lines.push('## Stats');
  lines.push('');
  lines.push(`- Total snapshots recorded: ${snapshots.length}`);
  lines.push(`- Findings resolved (lifetime): ${resolvedCount}`);
  lines.push(`- Findings open: ${openFindings.length}`);
  lines.push('');

  return lines.join('\n');
}

function trimTimeline(data) {
  const snapshots = data.snapshots ?? [];
  if (snapshots.length > TIMELINE_MAX_SNAPSHOTS) {
    data.snapshots = snapshots.slice(-TIMELINE_MAX_SNAPSHOTS);
  }
  return data;
}

function main() {
  let data = loadTimeline();
  data = trimTimeline(data);
  if (existsSync(TIMELINE)) {
    writeFileSync(TIMELINE, pyJsonDumpsIndent2(data) + '\n');
  }
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, render(data, loadSupplyChain()));
  return 0;
}

process.exit(main());
