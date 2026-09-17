// report -- group axe violations by component and render them (#594).
//
// Grouping key: component x rule. That is the one thing this skill does which
// nothing upstream does; a per-page axe dump already exists in a dozen tools
// and nobody reads it, because one bad button in a shared header arrives forty
// times.
//
// Two honesty rules are enforced here rather than left to the renderer, so a
// machine consumer reading the JSON gets the same treatment as a human reading
// the Markdown:
//
//   - nodes with no component marker are their OWN group with `component: null`
//     and a top-level `unattributed_nodes` count. They are never folded into a
//     named component, and never dropped.
//   - zero violations is a pass ONLY when the denominator proves axe evaluated
//     something. Otherwise the report is an abstention (D5).

import fs from 'node:fs';

import { attributeNode } from './component.mjs';
import { mapWcag, fixFor } from './wcag.mjs';

/** Group key for nodes with no marker; never a possible attribute value. */
const UNATTRIBUTED_KEY = '(unattributed)\n';

/** How many example selectors to carry per finding. */
const SAMPLE_LIMIT = 3;

/** Reduce a scanned URL to the shape a route list is written in. */
function routeOf(url) {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** A route list: a JSON array, or one route per line. */
function loadRoutes(routesPath) {
  const raw = fs.readFileSync(routesPath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Not JSON; fall through to the newline-delimited reading.
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * The one honest statement a post-processor can make about route coverage: it
 * names what it was told to expect and did not receive. It does NOT scan the
 * missing routes -- there is no scanner here (D6).
 */
function coverageFor(routesPath, documents) {
  if (!routesPath) return null;
  const expected = loadRoutes(routesPath);
  const scanned = new Set(documents.map((doc) => routeOf(doc.url)));
  const unscanned = expected.filter((route) => !scanned.has(route));
  return {
    routes_expected: expected.length,
    routes_scanned: expected.length - unscanned.length,
    routes_unscanned: unscanned,
  };
}

/** Why the report abstained, or null when it did not (D5). */
function abstentionReason({ documents, ruleEvaluations }) {
  if (documents.length === 0) {
    return 'no axe result document was read, so nothing was post-processed';
  }
  if (ruleEvaluations === 0) {
    return (
      `${documents.length} axe document(s) were read but no rule was evaluated ` +
      'in any of them (violations, passes, incomplete and inapplicable are all ' +
      'empty), so an empty violation list proves nothing about the pages'
    );
  }
  return null;
}

/** Fold every violation node into its component x rule bucket. */
function groupNodes(documents, attrs) {
  const groups = new Map();
  let violationNodes = 0;
  let unattributed = 0;

  for (const doc of documents) {
    const route = routeOf(doc.url) ?? '(no url)';
    for (const rule of doc.violations) {
      for (const node of Array.isArray(rule.nodes) ? rule.nodes : []) {
        violationNodes += 1;
        const { component, source } = attributeNode(node, attrs);
        if (!component) unattributed += 1;

        // The sentinel cannot collide with a real marker value: an HTML
        // attribute value containing a newline would not survive axe's own
        // serialisation into a one-line `html` string.
        const key = `${component ?? UNATTRIBUTED_KEY}::${rule.id}`;
        if (!groups.has(key)) {
          groups.set(key, {
            component,
            attribution: source,
            rule: rule.id,
            impact: rule.impact ?? null,
            wcag: mapWcag(rule.tags),
            occurrences: 0,
            pages: [],
            sample_targets: [],
            fix: fixFor(rule.id, rule.help, rule.helpUrl),
          });
        }
        const group = groups.get(key);
        group.occurrences += 1;
        if (!group.pages.includes(route)) group.pages.push(route);
        const target = []
          .concat(node.target ?? [])
          .flat(Infinity)
          .join(' ');
        if (target && group.sample_targets.length < SAMPLE_LIMIT) {
          if (!group.sample_targets.includes(target)) {
            group.sample_targets.push(target);
          }
        }
      }
    }
  }

  return { groups: [...groups.values()], violationNodes, unattributed };
}

const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];

function byImpactThenVolume(a, b) {
  const rank = (f) => {
    const at = IMPACT_ORDER.indexOf(f.impact);
    return at === -1 ? IMPACT_ORDER.length : at;
  };
  return rank(a) - rank(b) || b.occurrences - a.occurrences;
}

/**
 * @param {{documents: object[], ruleEvaluations: number}} ingested
 * @param {{attrs: string[], routesPath?: string, now?: string}} options
 */
export function buildReport(ingested, options) {
  const { documents, ruleEvaluations } = ingested;
  const { groups, violationNodes, unattributed } = groupNodes(
    documents,
    options.attrs,
  );
  const abstained = abstentionReason(ingested);
  const findings = groups.sort(byImpactThenVolume);

  return {
    version: 1,
    generated_at: options.now ?? new Date().toISOString(),
    summary: {
      pages: documents.length,
      rule_evaluations: ruleEvaluations,
      violation_nodes: violationNodes,
      components: new Set(
        findings.filter((f) => f.component).map((f) => f.component),
      ).size,
      unattributed_nodes: unattributed,
      findings: findings.length,
      abstained: abstained !== null,
      abstention_reason: abstained,
    },
    coverage: coverageFor(options.routesPath, documents),
    findings,
  };
}

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
