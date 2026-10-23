/**
 * `composer audit` as a gate (#1465) -- pure logic behind `canary php audit`.
 *
 * `composer audit` reports what it found and never how much it looked at, so
 * its silence on a missing or empty lockfile reads exactly like a clean one.
 * The denominator here is the lockfile's own package count, read by canary
 * before composer runs. Anything that stops the audit from covering those
 * packages zeroes it (#508): an unrun audit is an abstention, not a pass.
 */

import type { GateResult, SkipEntry } from './gate-result.js';

/** `spawnSync`-shaped result; `status: null` means the binary did not run. */
export interface AuditRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface AuditFinding {
  package: string;
  kind: 'advisory' | 'abandoned';
  /** CVE when assigned, else the advisory id; null for an abandoned package. */
  id: string | null;
  detail: string;
}

/** The arguments canary passes to `composer` for *dir*. */
export function composerAuditArgs(dir: string): string[] {
  return [
    'audit',
    '--locked',
    '--format=json',
    '--no-interaction',
    '--working-dir',
    dir,
  ];
}

/** Locked package count, or the reason the lockfile cannot supply one. */
export function lockedPackageCount(lockText: string | null): number | string {
  if (lockText === null) {
    return 'no composer.lock: run `composer update --lock` and commit it';
  }
  let lock: unknown;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return 'composer.lock is not valid JSON (unresolved merge conflict?)';
  }
  const list = (key: string): unknown[] => {
    const v = (lock as Record<string, unknown> | null)?.[key];
    return Array.isArray(v) ? v : [];
  };
  const count = list('packages').length + list('packages-dev').length;
  return count > 0 ? count : 'composer.lock locks 0 packages';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

// Composer writes an empty map as `[]`, so both shapes mean "none".
function entries(v: unknown): Array<[string, unknown]> {
  return isRecord(v) ? Object.entries(v) : [];
}

// A filtered advisory list keeps PHP's array keys, which json_encode writes as
// an object (`{"0": {...}, "2": {...}}`). Reading only arrays would turn that
// into zero findings: a silent false clean.
function listValues(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return isRecord(v) ? Object.values(v) : [];
}

function advisoryFindings(report: Record<string, unknown>): AuditFinding[] {
  return entries(report['advisories']).flatMap(([pkg, list]) =>
    listValues(list)
      .filter(isRecord)
      .map((a) => ({
        package: pkg,
        kind: 'advisory' as const,
        id: str(a['cve']) ?? str(a['advisoryId']),
        detail: [str(a['title']), str(a['affectedVersions'])]
          .filter((s) => s !== null)
          .join(' -- affected: '),
      })),
  );
}

function abandonedFindings(report: Record<string, unknown>): AuditFinding[] {
  return entries(report['abandoned']).map(([pkg, replacement]) => ({
    package: pkg,
    kind: 'abandoned' as const,
    id: null,
    detail: str(replacement)
      ? `abandoned; replaced by ${str(replacement)}`
      : 'abandoned; no replacement named',
  }));
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0] ?? '';
}

/** Parse an audit run into a gate result over *count* locked packages. */
export function auditResult(
  count: number,
  run: AuditRun,
): GateResult<AuditFinding> {
  const abstain = (reason: string): GateResult<AuditFinding> => ({
    checked: 0,
    findings: [],
    skipped: [{ name: 'composer audit', reason } satisfies SkipEntry],
  });
  // spawnSync reports both a missing binary and a signal death as null.
  if (run.status === null) {
    return abstain(
      'composer did not run to completion (missing, or killed by a signal): ' +
        'install it or pass --composer',
    );
  }
  let report: unknown;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    report = null;
  }
  if (!isRecord(report)) {
    const why = firstLine(run.stderr) || `exit ${run.status}, no JSON report`;
    return abstain(`composer audit failed: ${why}`);
  }
  if (!('advisories' in report)) {
    return abstain('composer audit output has no advisories key');
  }
  const advisories = advisoryFindings(report);
  const abandoned = abandonedFindings(report);
  // Composer's exit bitmask (1 vulnerable, 2 abandoned) is the cross-check on
  // this parser: a bit set with nothing parsed means the shape drifted, and
  // reading it as clean would be the false green this gate exists to refuse.
  if (run.status & 1 && advisories.length === 0) {
    return abstain('composer reported advisories (exit bit 1) but none parsed');
  }
  if (run.status & 2 && abandoned.length === 0) {
    return abstain(
      'composer reported abandoned packages (exit bit 2) but none parsed',
    );
  }
  return { checked: count, findings: [...advisories, ...abandoned] };
}
