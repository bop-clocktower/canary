// <canary-register> -- skipped and removed tests as visible debt, oldest first
// (#1151 phase 3). No author is shown (the contract refuses one).
//
// canary.site/1 cannot yet tell an empty ledger from an unread one (register
// is a required array), so an empty register is announced as ambiguous
// rather than rendered as "no debt" -- see #1199.

import { CanaryPanel, el } from '../panel.js';
import { ageDays } from '../model.js';

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
      ` · ${r.kind} · ${r.reason} · ${ageDays(r.recorded_at, now)} day(s) old${extra ? ` · ${extra}` : ''}`,
    ),
  );
}

export class Register extends CanaryPanel {
  get heading() {
    return 'Skipped and removed tests';
  }

  build(doc) {
    if (doc.register.length === 0)
      return {
        nodes: [],
        abstentions: [
          'The register lists no skipped or removed tests. An empty register can also mean no ledger was read; this feed does not say which.',
        ],
      };
    const rows = [...doc.register].sort(
      (a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at),
    );
    return {
      nodes: [el('ul', {}, ...rows.map((r) => row(r, this.now())))],
      abstentions: [],
    };
  }
}
