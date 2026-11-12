#!/usr/bin/env node
// Audit every tracked lockfile and write .harness/security/supply-chain.json.
//
// The harness CLI records `supplyChain.total: 0` in every snapshot because it
// never passes the collector a result (#1436; upstream: harness-engineering
// #2082). This is the measurement it does not make. It stays apart from
// scripts/security_ledger.mjs on purpose: the freshness guard reruns the renderer
// with no network and fails on any diff, so the renderer only reads this file.
// harness writes timeline.json, so results go here and never there.
//
// Exit 0 for any audit outcome. A vulnerability count informs, and a registry
// outage is "not measured": neither may turn the required `security` check red.
// Only a crash of this script fails the step.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = resolve(REPO_ROOT, '.harness', 'security', 'supply-chain.json');
const SCHEMA_VERSION = 1;
const AUDIT_TIMEOUT_MS = 180_000;
const AUDIT_MAX_BUFFER = 256 * 1024 * 1024;
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info', 'total'];
// npm reads config from the lockfile's own .npmrc and from npm_config_* env
// vars, and either can quietly shrink the audit to a false 0 (#1567):
// offline=true skips the advisory lookup, omit=dev drops devDependencies, and
// workspace detection audits the workspace root's tree instead of this one.
// The flags on the command line outrank both.
const AUDIT_ARGS = [
  'audit',
  '--package-lock-only',
  '--json',
  '--no-offline',
  '--include=dev',
  '--no-workspaces',
];

const NPM_LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);
// Named so a tracked one reads "not measured" instead of silently shrinking
// the denominator. They would need an auditor this script does not have.
const OTHER_LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'composer.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'Gemfile.lock',
]);

function git(...args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8' });
}

/** Tracked lockfiles, sorted so the sidecar's order is stable. */
function trackedLockfiles() {
  const r = git('ls-files', '-z');
  if (r.status !== 0) return null;
  return r.stdout
    .split('\0')
    .filter(
      (p) => NPM_LOCKFILES.has(basename(p)) || OTHER_LOCKFILES.has(basename(p)),
    )
    .sort();
}

function failed(path, reason) {
  return { path, status: 'failed', reason };
}

/**
 * Turn one `npm audit --json` run into a sidecar entry. npm exits 1 both when it
 * found vulnerabilities and when the registry failed, so the exit code says
 * nothing: only a report with numeric counts over a non-empty dependency tree
 * counts as measured. Reasons are fixed strings because the sidecar is public
 * and npm's own message can carry a registry URL.
 */
function classifyReport(path, stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return failed(path, 'npm audit did not print a JSON report');
  }
  const vulns = report?.metadata?.vulnerabilities;
  if (!vulns || !SEVERITIES.every((k) => Number.isInteger(vulns[k]))) {
    return failed(path, 'npm audit returned no vulnerability counts');
  }
  const dependencies = report.metadata.dependencies?.total;
  if (!Number.isInteger(dependencies) || dependencies === 0) {
    return failed(path, 'npm audit covered zero dependencies');
  }
  const vulnerabilities = {};
  for (const k of SEVERITIES) vulnerabilities[k] = vulns[k];
  return { path, status: 'measured', dependencies, vulnerabilities };
}

function auditLockfile(path) {
  if (!NPM_LOCKFILES.has(basename(path))) {
    return failed(path, 'no auditor for this lockfile type');
  }
  const cwd = resolve(REPO_ROOT, dirname(path));
  // Without a package.json beside it, npm walks up to the nearest one and
  // reports that project's tree under this lockfile's path (#1567).
  if (!existsSync(join(cwd, 'package.json'))) {
    return failed(path, 'no package.json beside this lockfile');
  }
  const r = spawnSync('npm', AUDIT_ARGS, {
    cwd,
    encoding: 'utf-8',
    timeout: AUDIT_TIMEOUT_MS,
    maxBuffer: AUDIT_MAX_BUFFER,
  });
  if (r.error) return failed(path, 'npm audit could not be run');
  return classifyReport(path, r.stdout);
}

function buildSidecar() {
  const paths = trackedLockfiles();
  // stdout is null when git itself could not be spawned.
  const head = process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD').stdout ?? '';
  const sidecar = {
    schemaVersion: SCHEMA_VERSION,
    commit: head.trim(),
    capturedAt: new Date().toISOString(),
    lockfiles: (paths ?? []).map(auditLockfile),
  };
  if (paths === null) sidecar.reason = 'git ls-files failed';
  return sidecar;
}

function report(sidecar) {
  const entries = sidecar.lockfiles;
  for (const e of entries) {
    const outcome =
      e.status === 'measured' ? `${e.vulnerabilities.total} found` : e.reason;
    console.log(`${e.path}: ${outcome}`);
  }
  const unmeasured = entries.filter((e) => e.status !== 'measured');
  if (entries.length === 0 || unmeasured.length > 0) {
    const why =
      entries.length === 0
        ? (sidecar.reason ?? 'no tracked lockfiles')
        : `${unmeasured.length} of ${entries.length} lockfiles failed`;
    console.log(`::warning title=Supply chain not measured::${why}`);
  }
}

function main() {
  const sidecar = buildSidecar();
  report(sidecar);
  mkdirSync(dirname(SIDECAR), { recursive: true });
  writeFileSync(SIDECAR, `${JSON.stringify(sidecar, null, 2)}\n`);
  return 0;
}

process.exit(main());
