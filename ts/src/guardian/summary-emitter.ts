/**
 * Build the Phase 1 impact summary Markdown.
 *
 * Faithful TypeScript port of `agent/guardian/summary_emitter.py`. This is the
 * content posted as a PR comment on the SUT repo after a merge to main. Pure
 * function: takes gaps and metadata, returns a Markdown string.
 *
 * Note: the emoji below are load-bearing output data (they appear verbatim in
 * the emitted Markdown), so they are retained here despite the usual
 * no-emoji-in-source convention.
 */

import { ChangeType } from './diff-extractor.js';
import { ImpactGap, Severity } from './impact-mapper.js';

const SEVERITY_EMOJI: Record<Severity, string> = {
  [Severity.CRITICAL]: '🔴',
  [Severity.HIGH]: '🟠',
  [Severity.MEDIUM]: '🟡',
  [Severity.LOW]: '🟢',
};

/** Python: `build_summary`. */
export function buildSummary(
  gaps: ImpactGap[],
  commitSha: string,
  suite: string,
  healthSnapshot = '',
): string {
  const shortSha = commitSha.slice(0, 8);

  if (gaps.length === 0) {
    return (
      `## Canary Guardian — Test Impact Summary\n\n` +
      `**Commit:** ${shortSha}  \n` +
      `**Suite:** ${suite}\n\n` +
      `✅ No test impact detected — all existing endpoints and coverage are unchanged.\n`
    );
  }

  const added = gaps.filter((g) => g.change_type === ChangeType.ADDED);
  const removed = gaps.filter((g) => g.change_type === ChangeType.REMOVED);
  const changed = gaps.filter((g) => g.change_type === ChangeType.CHANGED);

  const lines: string[] = [
    '## Canary Guardian — Test Impact Summary\n',
    `**Commit:** ${shortSha}  \n**Suite:** ${suite}\n`,
  ];

  if (added.length) {
    lines.push('### New endpoints (not yet covered)');
    for (const g of added) {
      const sev = SEVERITY_EMOJI[g.severity];
      const cov = g.affected_tests.length
        ? `${g.affected_tests.length} existing test(s)`
        : '**no existing tests**';
      lines.push(`- ${sev} \`${g.method.toUpperCase()} ${g.path}\` — ${cov}`);
    }
    lines.push('');
  }

  if (removed.length) {
    lines.push('### Removed endpoints');
    for (const g of removed) {
      const sev = SEVERITY_EMOJI[g.severity];
      lines.push(`- ${sev} \`${g.method.toUpperCase()} ${g.path}\``);
      for (const t of g.affected_tests.slice(0, 5)) {
        lines.push(`  - Affected test: _${t}_`);
      }
      if (g.affected_tests.length > 5) {
        lines.push(`  - … and ${g.affected_tests.length - 5} more`);
      }
    }
    lines.push('');
  }

  if (changed.length) {
    lines.push('### Changed endpoints');
    for (const g of changed) {
      const sev = SEVERITY_EMOJI[g.severity];
      lines.push(`- ${sev} \`${g.method.toUpperCase()} ${g.path}\``);
      for (const t of g.affected_tests.slice(0, 5)) {
        lines.push(`  - Affected test: _${t}_`);
      }
    }
    lines.push('');
  }

  if (healthSnapshot) {
    lines.push('### Current health (affected areas)');
    lines.push(healthSnapshot);
    lines.push('');
  }

  lines.push('### Recommended actions');
  gaps.slice(0, 10).forEach((g, index) => {
    const i = index + 1;
    let action: string;
    if (g.change_type === ChangeType.ADDED) {
      action = `Write test for \`${g.method.toUpperCase()} ${g.path}\` (no coverage)`;
    } else if (g.change_type === ChangeType.REMOVED) {
      action = `Remove/update tests for \`${g.method.toUpperCase()} ${g.path}\` (will break)`;
    } else {
      action = `Review tests for \`${g.method.toUpperCase()} ${g.path}\` (silent contract drift risk)`;
    }
    lines.push(`${i}. ${action}`);
  });

  return `${lines.join('\n')}\n`;
}
