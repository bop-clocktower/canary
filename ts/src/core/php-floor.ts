/**
 * PHP runtime security floor (#1465) -- pure logic behind `canary php floor`.
 *
 * A CI matrix pinned to a floating `'8.3'` proves the suite passed on *some*
 * patched PHP. It says nothing about the PHP production runs, which is where
 * an unauthenticated RCE lands. This gate compares the versions a runtime
 * actually reports against the patched floor of its branch.
 *
 * Doctrine (#508): a version the table cannot judge is SKIPPED, never passed.
 * The sharpest case is a distro build below the floor: Debian/Ubuntu keep the
 * upstream number in `PHP_VERSION` and backport the fix under their own
 * suffix, so `8.3.6-1ubuntu...` can be fully patched. Failing it would be a
 * false alarm, passing it a false green; only the vendor's advisory can
 * answer. The other unprovable case is an upstream pre-release of the floor
 * version itself.
 */

import type { GateResult, SkipEntry } from './gate-result.js';

/** One security release: the patched version per branch. */
export interface PhpAdvisory {
  id: string;
  cves: string[];
  published: string;
  /** Branch (`major.minor`) -> first patched upstream release. */
  fixed: Record<string, string>;
  /** Supported-by-vendors branches that got no upstream release. */
  upstreamUnfixed: string[];
  /** Branches below this have no fix from anyone. */
  noFixBelow: string;
}

/** PHP2Shell, 2026-10-21 (CISA alert of the same date). */
export const PHP2SHELL: PhpAdvisory = {
  id: 'PHP2Shell',
  cves: ['CVE-2026-109618', 'CVE-2026-109619'],
  published: '2026-10-21',
  fixed: { '8.2': '8.2.35', '8.3': '8.3.36', '8.4': '8.4.27', '8.5': '8.5.12' },
  upstreamUnfixed: ['7.4', '8.0', '8.1'],
  noFixBelow: '7.4',
};

/** A runtime to judge: its reported version, plus ini state when probed. */
export interface RuntimeReport {
  version: string;
  /** `ini_get('session.upload_progress.enabled')`, when known. */
  uploadProgress?: string;
}

export interface FloorFinding {
  version: string;
  /** The patched version of this branch, or null when no upstream fix exists. */
  floor: string | null;
  detail: string;
}

// Upstream suffixes are pre-releases (8.5.0RC1, 8.4.0beta2, 8.3.0-dev); any
// other suffix is a vendor build.
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(.*)$/;
const UPSTREAM_SUFFIX_RE = /^(?:-?dev|(?:alpha|beta|RC)\d*)?$/i;

type Triple = [number, number, number];

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function triple(v: string): Triple {
  const [maj, min, patch] = v.split('.').map(Number);
  return [maj!, min!, patch!];
}

function cveList(a: PhpAdvisory): string {
  return a.cves.join(', ');
}

/** Advice on the CVE-2026-109619 stopgap, when the ini value is known. */
function stopgapNote(r: RuntimeReport): string {
  if (r.uploadProgress === undefined) return '';
  const on = /^(?:1|on|yes|true)$/i.test(r.uploadProgress.trim());
  return on
    ? '; session.upload_progress.enabled=1 -- set it to 0 as a stopgap for ' +
        'CVE-2026-109619 until patched'
    : '; upload-progress stopgap is on, but CVE-2026-109618 is still open';
}

type Verdict = { finding: FloorFinding } | { skip: string } | { ok: true };

const VENDOR_SKIP = 'vendor build: check the vendor advisory for a backport';

interface Parsed {
  ver: Triple;
  branch: string;
  /** Distro/vendor suffix (`-1ubuntu2.14`), as opposed to an upstream one. */
  vendor: boolean;
  /** Upstream RC/beta/alpha/-dev: a build from BEFORE that release. */
  prerelease: boolean;
}

function parse(version: string): Parsed | null {
  const m = VERSION_RE.exec(version.trim());
  if (!m) return null;
  const ver: Triple = [Number(m[1]), Number(m[2]), Number(m[3])];
  const vendor = !UPSTREAM_SUFFIX_RE.test(m[4]!);
  return {
    ver,
    branch: `${ver[0]}.${ver[1]}`,
    vendor,
    prerelease: !vendor && m[4] !== '',
  };
}

/**
 * A branch with an upstream fix. A vendor number at or above the floor is
 * built on a patched release, so it passes; only a vendor number BELOW the
 * floor is unprovable either way. A pre-release of the floor version itself
 * (8.3.36RC1, 8.3.36-dev) may predate the security merge, so it is skipped.
 */
function judgeFixed(p: Parsed, floor: string): 'ok' | 'below' | string {
  const cmp = compare(p.ver, triple(floor));
  if (cmp > 0 || (cmp === 0 && !p.prerelease)) return 'ok';
  if (cmp === 0)
    return 'pre-release of the patched version: may predate the fix';
  return p.vendor ? VENDOR_SKIP : 'below';
}

function judge(r: RuntimeReport, a: PhpAdvisory): Verdict {
  const p = parse(r.version);
  if (p === null) return { skip: 'not a PHP version string' };
  const finding = (floor: string | null, detail: string): Verdict => ({
    finding: { version: r.version, floor, detail: detail + stopgapNote(r) },
  });
  if (compare(p.ver, triple(`${a.noFixBelow}.0`)) < 0) {
    return finding(null, `branch ${p.branch} has no fix for ${cveList(a)}`);
  }
  const floor = a.fixed[p.branch];
  if (floor !== undefined) {
    const v = judgeFixed(p, floor);
    if (v === 'ok') return { ok: true };
    if (v !== 'below') return { skip: v };
    return finding(floor, `below ${floor}, vulnerable to ${cveList(a)}`);
  }
  if (p.vendor) return { skip: VENDOR_SKIP };
  if (a.upstreamUnfixed.includes(p.branch)) {
    return finding(
      null,
      `branch ${p.branch} has no upstream fix for ${cveList(a)}; upgrade, ` +
        'or run a vendor/LTS build that carries the backport',
    );
  }
  return { skip: `branch ${p.branch} not covered` };
}

/** Judge each runtime against *advisory*; unjudgeable ones are skipped. */
export function evaluateRuntimes(
  runtimes: RuntimeReport[],
  advisory: PhpAdvisory = PHP2SHELL,
): GateResult<FloorFinding> {
  const findings: FloorFinding[] = [];
  const skipped: SkipEntry[] = [];
  let checked = 0;
  for (const r of runtimes) {
    const v = judge(r, advisory);
    if ('skip' in v) {
      skipped.push({ name: r.version, reason: v.skip });
      continue;
    }
    checked++;
    if ('finding' in v) findings.push(v.finding);
  }
  return { checked, findings, skipped };
}
