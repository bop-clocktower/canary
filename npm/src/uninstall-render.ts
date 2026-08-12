/**
 * Rendering half of `canary uninstall`. Groups artifacts by disposition and
 * always states the denominator: a scope with nothing in it says so rather
 * than printing an empty list that reads as "all clean".
 */
import type { Artifact, Scope } from './uninstall-types.js';

function human(bytes: number | undefined): string {
  if (bytes === undefined || bytes === 0) return '';
  const units = ['B', 'K', 'M', 'G'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}

export function render(
  artifacts: Artifact[],
  opts: { scope: Scope; apply: boolean; failed?: Artifact[] },
): string {
  const lines: string[] = [];
  const mode = opts.apply ? '(apply)' : '(dry run)';
  lines.push(`canary uninstall --${opts.scope} ${mode}`, '');

  // `disposition` records what the scan decided, not what the removal achieved.
  // A failed rmSync leaves the artifact `removable`, so rendering straight from
  // the disposition would report it as removed — a clean-looking summary over
  // work that did not happen.
  const failedSet = new Set(opts.failed ?? []);
  const removable = artifacts.filter(
    (a) => a.disposition === 'removable' && !failedSet.has(a),
  );
  const failed = artifacts.filter((a) => failedSet.has(a));
  const blocked = artifacts.filter((a) => a.disposition === 'blocked');
  const manual = artifacts.filter((a) => a.disposition === 'manual');

  const section = (title: string, rows: Artifact[]): void => {
    if (rows.length === 0) return;
    lines.push(`  ${title} (${rows.length})`);
    for (const a of rows) {
      const size = human(a.sizeBytes);
      const tail = a.reason ? `  — ${a.reason}` : '';
      lines.push(
        `    ${a.label}${size ? `  ${size}` : ''}${a.path ? `\n      ${a.path}` : ''}${tail}`,
      );
    }
    lines.push('');
  };

  section(opts.apply ? 'Removed' : 'Removable', removable);
  section('FAILED to remove', failed);
  section('Skipped', blocked);
  section('You must do these yourself', manual);

  // A zero denominator is an abstention, not a pass: say so explicitly rather
  // than printing an empty list that reads as "all clean".
  if (artifacts.length === 0) {
    lines.push('  Nothing found for this scope — nothing to remove.', '');
    return lines.join('\n');
  }
  if (removable.length === 0) {
    lines.push('  Nothing removable for this scope.');
  }

  const summary =
    `  ${removable.length} ${opts.apply ? 'removed' : 'removable'}, ` +
    (failed.length > 0 ? `${failed.length} FAILED, ` : '') +
    `${blocked.length} skipped, ${manual.length} manual.`;
  lines.push(
    opts.apply
      ? summary
      : `${summary} Nothing was removed — re-run with --apply.`,
  );
  return lines.join('\n');
}
