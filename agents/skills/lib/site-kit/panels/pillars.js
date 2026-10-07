// <canary-pillars> -- every assessment side by side, never a composite (#1151
// phase 3, D6, ADR 0036, criterion 20). A not-assessed pillar shows its
// reason as text and announces it; an absent value is "—", never 0.

import { CanaryPanel, el } from '../panel.js';
import { ABSENT, formatMeasure, scopeLabel } from '../model.js';

const evidence = (e) =>
  `evidence: ${e.tier ?? ABSENT}${e.denominator === null ? '' : ` over ${e.denominator}`}`;

const order = (a, b) =>
  scopeLabel(a.scope).localeCompare(scopeLabel(b.scope)) ||
  a.source.localeCompare(b.source) ||
  a.metric.localeCompare(b.metric);

function card(a) {
  const detail =
    a.status === 'not-assessed'
      ? el('p', { class: 'abstain' }, a.reason)
      : el(
          'p',
          {},
          el('strong', {}, formatMeasure(a.value, a.unit)),
          el('span', { class: 'muted' }, evidence(a.evidence)),
        );
  return el(
    'li',
    { 'data-state': a.status, class: 'card' },
    el('h3', {}, a.metric),
    el(
      'p',
      { class: 'muted' },
      `${a.source} · ${scopeLabel(a.scope)} · ${a.status}`,
    ),
    detail,
  );
}

export class Pillars extends CanaryPanel {
  get bodyClass() {
    return '';
  }

  get heading() {
    return 'Pillars';
  }

  build(doc) {
    if (doc.assessments.length === 0)
      return { nodes: [], abstentions: ['No assessments in the feed.'] };
    const sorted = [...doc.assessments].sort(order);
    const abstentions = sorted
      .filter((a) => a.status === 'not-assessed')
      .map((a) => `${a.metric}: not assessed (${a.reason}).`);
    return {
      nodes: [el('ul', { class: 'cards tiles' }, ...sorted.map(card))],
      abstentions,
    };
  }
}
