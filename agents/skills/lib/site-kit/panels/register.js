// <canary-register> -- skipped and removed tests as visible debt, oldest first
// (#1151 phase 3). No author is shown (the contract refuses one).
//
// An empty register is "no debt" only when the ledger was read: canary-starling
// marks an unread one with a not-assessed `canary.katana` assessment, and the
// panel says "not assessed" with its reason instead (#1199).

import { CanaryPanel, el } from '../panel.js';
import { ageDays, registerUnread } from '../model.js';

/** The row's age as text; a date the reader's clock cannot age says why. */
function age(r, now) {
  const days = ageDays(r.recorded_at, now);
  if (!Number.isFinite(days)) return 'no real date';
  if (days < 0) return 'recorded in the future (clock skew)';
  return `${days} day(s) old`;
}

const unageable = (r, now) => !(ageDays(r.recorded_at, now) >= 0);

/** Oldest first; a row with no real date sorts last. */
const sortKey = (r) => {
  const t = Date.parse(r.recorded_at);
  return Number.isFinite(t) ? t : Infinity;
};

function row(r, now) {
  const extra = [r.cause, r.issue].filter(Boolean).join(' · ');
  return el(
    'li',
    {},
    el('strong', {}, r.title),
    ' ',
    el('code', {}, r.file),
    el(
      'span',
      { class: 'muted' },
      ` · ${r.kind} · ${r.reason} · ${age(r, now)}${extra ? ` · ${extra}` : ''}`,
    ),
  );
}

export class Register extends CanaryPanel {
  get heading() {
    return 'Skipped and removed tests';
  }

  build(doc) {
    if (doc.register.length === 0) {
      const unread = registerUnread(doc);
      return {
        nodes: [],
        abstentions: [
          unread ? `Not assessed — ${unread}` : 'No skipped or removed tests.',
        ],
      };
    }
    const now = this.now();
    const rows = [...doc.register].sort((a, b) => sortKey(a) - sortKey(b));
    const skewed = rows.filter((r) => unageable(r, now)).length;
    return {
      nodes: [el('ul', { class: 'rows' }, ...rows.map((r) => row(r, now)))],
      abstentions: skewed
        ? [
            `${skewed} row(s) have a date this page cannot age (clock skew or no real date).`,
          ]
        : [],
    };
  }
}
