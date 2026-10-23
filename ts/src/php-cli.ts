/**
 * `canary php floor` and `canary php audit` (#1465): the two PHP security gates.
 *
 * Both are gates in the #508 sense: findings exit 1, and a zero denominator --
 * no runnable PHP, no lockfile, no composer -- exits 3 with the reason and
 * the first fix step, never a pass.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';
import pc from 'picocolors';

import { CliExitError, jsonIndent2 } from './cli-common.js';
import {
  auditResult,
  composerAuditArgs,
  lockedPackageCount,
  type AuditFinding,
} from './core/composer-audit.js';
import { errnoCode, gateOutcome, type GateResult } from './core/gate-result.js';
import {
  evaluateRuntimes,
  PHP2SHELL,
  type FloorFinding,
  type RuntimeReport,
} from './core/php-floor.js';
import { CROSS, WARN, type MainDeps } from './main-deps.js';

// One round trip reports the version and the CVE-2026-109619 stopgap's state.
const PROBE_SCRIPT =
  'echo json_encode([PHP_VERSION, ' +
  "ini_get('session.upload_progress.enabled')]);";

/** Run *php* once, or explain in a skip why its version is unknown. */
function probeRuntime(php: string, deps: MainDeps): RuntimeReport | string {
  const run = deps.runSubprocess(php, ['-r', PROBE_SCRIPT]);
  if (run.status === null) return `'${php}' is not runnable`;
  try {
    const [version, ini] = JSON.parse(run.stdout) as unknown[];
    if (typeof version === 'string') {
      return typeof ini === 'string'
        ? { version, uploadProgress: ini }
        : { version };
    }
  } catch {
    // Fall through: an unparseable probe is reported like a failed one.
  }
  return `'${php}' probe failed (exit ${run.status})`;
}

/** Emit *result* as JSON or text, then exit by the gate contract. */
function report<F>(
  result: GateResult<F>,
  opts: {
    json?: boolean | undefined;
    noun: string;
    extra?: Record<string, unknown>;
  },
  render: (f: F) => string,
  remedy: string,
  deps: MainDeps,
): void {
  const outcome = gateOutcome(result, 'gate', { noun: opts.noun });
  if (opts.json) {
    const { abstained } = outcome;
    deps.out(jsonIndent2({ ...opts.extra, ...result, abstained }));
  } else {
    for (const f of result.findings)
      deps.out(`  ${pc.red(CROSS)} ${render(f)}`);
    deps.out(outcome.summaryLine);
    if (outcome.abstained) deps.out(pc.yellow(`${WARN} ${remedy}`));
  }
  if (outcome.exitCode !== 0) throw new CliExitError(outcome.exitCode);
}

interface FloorOpts {
  phpVersion?: string[];
  php: string;
  json?: boolean;
}

function floorAction(opts: FloorOpts, deps: MainDeps): void {
  let runtimes: RuntimeReport[] = (opts.phpVersion ?? []).map((version) => ({
    version,
  }));
  let probeSkip: string | null = null;
  if (runtimes.length === 0) {
    const probed = probeRuntime(opts.php, deps);
    if (typeof probed === 'string') probeSkip = probed;
    else runtimes = [probed];
  }
  const result = evaluateRuntimes(runtimes);
  if (probeSkip !== null) {
    result.skipped = [{ name: opts.php, reason: probeSkip }];
  }
  const { id, cves } = PHP2SHELL;
  report(
    result,
    {
      json: opts.json,
      noun: 'runtime check(s)',
      extra: { advisory: id, cves },
    },
    (f: FloorFinding) => `${f.version}: ${f.detail}`,
    'Pass --php <binary> to probe a runtime, or --php-version <x.y.z> for ' +
      'each one reported by the hosts (php -r "echo PHP_VERSION;").',
    deps,
  );
}

/** Locked package count in *dir*, or why the lockfile cannot supply one. */
function lockCount(dir: string): number | string {
  try {
    return lockedPackageCount(
      readFileSync(resolve(dir, 'composer.lock'), 'utf-8'),
    );
  } catch (e) {
    // Only "the filesystem said no" becomes a skip; anything else is a bug.
    const code = errnoCode(e);
    if (code === 'ENOENT') return lockedPackageCount(null);
    if (code !== null) return `composer.lock is unreadable (${code})`;
    throw e; // canary:allow-untested a non-errno error is a bug; nothing injects one
  }
}

interface AuditOpts {
  dir?: string;
  composer: string;
  json?: boolean;
}

function auditAction(opts: AuditOpts, deps: MainDeps): void {
  const dir = resolve(opts.dir ?? deps.cwd());
  const count = lockCount(dir);
  const result: GateResult<AuditFinding> =
    typeof count === 'string'
      ? { checked: 0, findings: [], skipped: [{ name: dir, reason: count }] }
      : auditResult(
          count,
          deps.runSubprocess(opts.composer, composerAuditArgs(dir)),
        );
  report(
    result,
    { json: opts.json, noun: 'package check(s)' },
    (f) => `${f.package}${f.id ? ` ${f.id}` : ''}: ${f.detail}`,
    'Fix the skipped step above; an audit that covered no locked package ' +
      'cannot vouch for the dependencies.',
    deps,
  );
}

export function buildPhpCommand(deps: MainDeps): Command {
  const php = new Command('php').description(
    'PHP security gates: runtime patch floor and composer audit.',
  );
  php
    .command('floor')
    .description(
      `Fail when a PHP runtime is below the ${PHP2SHELL.id} patched floor ` +
        `(${PHP2SHELL.cves.join(', ')}). Unjudgeable versions exit 3.`,
    )
    .option('--php-version <versions...>', 'versions to judge; skips probing')
    .option('--php <binary>', 'PHP binary to probe', 'php')
    .option('--json', 'Print the gate result as JSON.')
    .action((opts: FloorOpts) => floorAction(opts, deps));
  php
    .command('audit')
    .description(
      'Fail on advisories or abandoned packages in composer.lock. A missing ' +
        'lockfile or composer exits 3.',
    )
    .option('--dir <path>', 'project directory (default: cwd)')
    .option('--composer <binary>', 'composer binary', 'composer')
    .option('--json', 'Print the gate result as JSON.')
    .action((opts: AuditOpts) => auditAction(opts, deps));
  return php;
}
