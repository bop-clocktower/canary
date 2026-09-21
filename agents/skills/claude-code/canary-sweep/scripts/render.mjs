// render -- turn a canary-sweep report into Markdown and JSON (#594).
//
// Split out of report.mjs, which crossed the 300-line perf threshold once the
// grouping loop was flattened. The division is the one canary-test-reporter
// already uses: report.mjs decides WHAT the findings are, this decides how they
// read. Both honesty rules are decided upstream in report.mjs, so a machine
// consumer reading the JSON and a human reading the Markdown cannot disagree.

/** The abstention banner, worded so `gateOutcome`'s convention is honoured. */
export function abstentionLine(report) {
  return `canary-sweep ABSTAINED -- ${report.summary.abstention_reason}.`;
}

function renderWcag(wcag) {
  if (!wcag.labelled) return 'no WCAG criterion (best-practice rule)';
  const level = wcag.level ? ` (level ${wcag.level})` : '';
  return `WCAG ${wcag.criteria.join(', ')}${level}`;
}

function renderFinding(finding) {
  const name = finding.component
    ? `${finding.component} — \`${finding.rule}\``
    : `Unattributed — \`${finding.rule}\``;
  const attribution = finding.component
    ? `attributed via \`${finding.attribution}\``
    : 'no component marker on the failing element';
  const lines = [
    `### ${name}`,
    '',
    `**${finding.occurrences} occurrence(s)** across ${finding.pages.length} page(s) · ` +
      `impact: ${finding.impact ?? 'unknown'} · ${renderWcag(finding.wcag)}`,
    '',
    `Pages: ${finding.pages.join(', ')}`,
    '',
    `Attribution: ${attribution}`,
    '',
  ];
  if (finding.sample_targets.length) {
    lines.push(
      `Example selector(s): ${finding.sample_targets.map((t) => `\`${t}\``).join(', ')}`,
      '',
    );
  }
  lines.push(`Fix: ${finding.fix}`, '');
  return lines.join('\n');
}

function renderCoverage(coverage) {
  if (!coverage) return [];
  const lines = [
    '## Route coverage',
    '',
    `${coverage.routes_scanned} of ${coverage.routes_expected} listed route(s) had an axe result.`,
    '',
  ];
  if (coverage.routes_unscanned.length) {
    lines.push(
      `**${coverage.routes_unscanned.length} unscanned route(s)** — listed, but no axe ` +
        'document was supplied for them. This skill does not scan; it can only report the gap:',
      '',
      ...coverage.routes_unscanned.map((route) => `- ${route}`),
      '',
    );
  }
  return lines;
}

export function renderMarkdown(report) {
  const { summary } = report;
  const lines = ['# Accessibility sweep', ''];

  if (summary.abstained) {
    lines.push(
      `> **${abstentionLine(report)}**`,
      '',
      `Denominator: ${summary.pages} page(s), ${summary.rule_evaluations} rule evaluation(s).`,
      '',
      'This run verified NOTHING about accessibility. It is not a clean result.',
      '',
    );
    return lines.join('\n');
  }

  lines.push(
    `**${summary.findings} finding(s)** from ${summary.violation_nodes} violation node(s) · ` +
      `${summary.components} component(s) · ${summary.unattributed_nodes} unattributed node(s) · ` +
      `${summary.pages} page(s) · ${summary.rule_evaluations} rule evaluation(s)`,
    '',
  );

  if (summary.violation_nodes === 0) {
    lines.push(
      `0 violations across ${summary.pages} page(s) and ${summary.rule_evaluations} rule evaluation(s).`,
      '',
      'The denominator is stated because a zero without one is indistinguishable from a scan that never ran.',
      '',
    );
  } else {
    lines.push(
      `Deduped by component: ${summary.violation_nodes} node(s) collapsed into ${summary.findings} finding(s).`,
      '',
    );
    if (summary.unattributed_nodes > 0) {
      lines.push(
        `**${summary.unattributed_nodes} node(s) could not be attributed to a component** and are ` +
          'grouped under "Unattributed" below — they are counted, never folded into a named ' +
          'component. Add a `data-component` marker to attribute them.',
        '',
      );
    }
    lines.push('## Findings', '', ...report.findings.map(renderFinding));
  }

  lines.push(...renderCoverage(report.coverage));
  return lines.join('\n');
}

export function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
