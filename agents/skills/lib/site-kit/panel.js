// panel -- the base every site-kit custom element extends (#1151 phase 3).
//
// One rule lives here so no panel can skip it: an abstention is visible text
// INSIDE a polite live region (criterion 11). The region is created once and
// kept across renders -- a region inserted together with its text is often
// not announced. Styles are one constructed stylesheet shared by every panel,
// not a <style> element, so a host's strict CSP cannot block them, and they
// read only tokens.css custom properties (no literal colors).

const CSS = `
:host {
  display: block;
  font: 0.95rem/1.4 var(--canary-font);
  color: var(--canary-text);
  background: var(--canary-surface);
  border: 1px solid var(--canary-border);
  border-radius: var(--canary-radius);
  padding: var(--canary-space-2);
}
h2 { font-size: 1rem; margin: 0 0 var(--canary-space-2); }
h3 { font-size: 0.95rem; margin: var(--canary-space-2) 0 var(--canary-space-1); }
ul, ol { list-style: none; margin: 0; padding: 0; }
li { padding: var(--canary-space-1) 0; border-top: 1px solid var(--canary-border); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: var(--canary-space-1); border-top: 1px solid var(--canary-border); }
code { font-family: var(--canary-mono); }
.muted { color: var(--canary-muted); }
.abstain { color: var(--canary-abstain); font-style: italic; margin: 0; }
[data-state='passing'], [data-state='healthy'] { color: var(--canary-ok); }
[data-state='failing'], [data-state='critical'] { color: var(--canary-fail); }
[data-state='cancelled'], [data-state='degraded'] { color: var(--canary-warn); }
[data-state='dark'], [data-state='never-reported'], [data-state='not-assessed'] { color: var(--canary-dark); }
`;

let sheet = null;
function styles() {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
  }
  return sheet;
}

/** el('li', {'data-state': 'dark'}, 'text', child): null children are skipped. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

/**
 * Subclasses provide `get heading()` and `build(doc)`, which returns
 * `{nodes, abstentions}`: the content, and every reason the panel could not
 * show something. Abstentions are never optional copy.
 */
export class CanaryPanel extends HTMLElement {
  #doc = null;
  #problem = null;
  #live;
  /** Milliseconds since the epoch; tests pin it. */
  now = () => Date.now();

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [styles()];
    this.#live = el('p', {
      role: 'status',
      'aria-live': 'polite',
      class: 'abstain',
    });
  }

  set feed(doc) {
    this.#doc = doc;
    this.#problem = null;
    this.render();
  }

  get feed() {
    return this.#doc;
  }

  /** The feed could not be used at all (load failed, wrong contract). */
  refuse(problem) {
    this.#doc = null;
    this.#problem = problem;
    this.render();
  }

  connectedCallback() {
    this.render();
  }

  render() {
    const { nodes, abstentions } = this.#doc
      ? this.build(this.#doc)
      : { nodes: [], abstentions: [this.#problem ?? 'No feed loaded yet.'] };
    this.shadowRoot.replaceChildren(
      el('h2', {}, this.heading),
      ...nodes,
      this.#live,
    );
    this.#live.textContent = abstentions.join(' ');
  }
}
