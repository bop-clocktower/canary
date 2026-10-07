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
  font: 0.95rem/1.45 var(--canary-font);
  color: var(--canary-text);
}
h2 {
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--canary-muted);
  margin: 0 0 var(--canary-space-2);
}
h3 { font-size: 0.95rem; margin: 0 0 var(--canary-space-1); }
.card, [part='body'].card {
  background: var(--canary-surface);
  border: 1px solid var(--canary-border);
  border-radius: var(--canary-radius);
  box-shadow: var(--canary-shadow);
  padding: var(--canary-space-2) 16px;
}
[part='body']:empty { display: none; }
ul, ol { list-style: none; margin: 0; padding: 0; }
.rows > li { padding: 10px 0; border-top: 1px solid var(--canary-border); }
.rows > li:first-child { border-top: 0; }
.cards {
  display: grid;
  gap: var(--canary-space-2);
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
}
.cards > li { border-left: 4px solid var(--state, var(--canary-border)); }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th {
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--canary-muted);
  background: var(--canary-page);
}
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--canary-border); }
th:not(:first-child), td:not(:first-child) { text-align: right; }
tbody tr:last-child td { border-bottom: 0; }
code { font-family: var(--canary-mono); font-size: 0.85em; color: var(--canary-muted); }
.muted { color: var(--canary-muted); }
.num { font-variant-numeric: tabular-nums; }
.row { display: flex; align-items: center; justify-content: space-between; gap: var(--canary-space-2); }
.summary { margin: 0 0 var(--canary-space-2); font-weight: 600; color: var(--state, var(--canary-muted)); }
.pill {
  display: inline-block;
  padding: 1px 10px;
  border: 1px solid var(--state, var(--canary-border));
  border-radius: 999px;
  background: var(--state-tint, var(--canary-page));
  color: var(--state, var(--canary-muted));
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
section + section { margin-top: 20px; }
.trend > li {
  display: grid;
  grid-template-columns: 5.6rem minmax(3rem, 1fr) 3.9rem auto;
  align-items: center;
  gap: 10px;
  padding: 3px 0;
}
.trend > li > :last-child { text-align: right; }
.trend > li > strong { text-align: right; }
.rows strong { display: block; }
.tiles > li { border-left: 4px solid var(--state, var(--canary-border)); }
.tiles strong { display: block; font-size: 2rem; line-height: 1.2; font-variant-numeric: tabular-nums; }
.tiles p { margin: var(--canary-space-1) 0 0; }
.cards .row { flex-wrap: wrap; align-items: baseline; margin-bottom: var(--canary-space-1); }
.name { font-weight: 700; }
.name .muted { font-weight: 400; }
.stats {
  display: grid;
  gap: var(--canary-space-2);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
}
.stats > li { background: var(--state-tint, var(--canary-surface)); border-color: var(--state, var(--canary-border)); }
.stats .label {
  display: block;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--canary-muted);
}
.stats strong { display: block; font-size: 2rem; line-height: 1.3; font-variant-numeric: tabular-nums; }
.big { font-size: 2rem; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
.strip { display: flex; gap: 3px; margin-top: var(--canary-space-2); }
.strip > span { width: 12px; height: 12px; border-radius: 2px; background: var(--state, var(--canary-track)); }
.bar { display: block; height: 8px; border-radius: 4px; background: var(--canary-track); overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--state, var(--canary-accent)); }
.abstain {
  color: var(--canary-abstain);
  margin: var(--canary-space-2) 0 0;
  padding: 10px 14px;
  background: var(--canary-surface);
  border: 1px solid var(--canary-border);
  border-left: 3px solid var(--canary-accent);
  border-radius: var(--canary-radius);
}
/* Collapsed, never display:none: a hidden live region may not announce. */
.abstain:empty { margin: 0; padding: 0; border: 0; }
p.abstain:not([role]) { margin: var(--canary-space-1) 0 0; padding: 0; border: 0; background: none; font-style: italic; }
[data-state='passing'], [data-state='healthy'], [data-state='passed'] { --state: var(--canary-ok); --state-tint: var(--canary-ok-tint); }
[data-state='failing'], [data-state='critical'], [data-state='failed'] { --state: var(--canary-fail); --state-tint: var(--canary-fail-tint); }
[data-state='cancelled'], [data-state='degraded'], [data-state='incomplete'] { --state: var(--canary-warn); --state-tint: var(--canary-warn-tint); }
[data-state='dark'], [data-state='undated'], [data-state='future'], [data-state='never-reported'], [data-state='not-assessed'] { --state: var(--canary-dark); --state-tint: var(--canary-dark-tint); }
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
 * The page's feed, once canary-site.js has loaded it (or why it could not).
 * A panel connected AFTER the load -- a client-rendered route, an async
 * script -- adopts it instead of waiting forever on "No feed loaded yet."
 */
export const pageFeed = { doc: null, problem: null };

/**
 * Subclasses provide `get heading()` and `build(doc)`, which returns
 * `{nodes, abstentions}`: the content, and every reason the panel could not
 * show something. Abstentions are never optional copy.
 */
export class CanaryPanel extends HTMLElement {
  #doc = null;
  #problem = null;
  #heading;
  #body;
  #live;
  /** 'card' wraps the body in one surface; a panel of cards sets ''. */
  get bodyClass() {
    return 'card';
  }
  /** Milliseconds since the epoch; tests pin it. */
  now = () => Date.now();

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [styles()];
    this.#heading = el('h2');
    this.#body = el('div', { part: 'body', class: this.bodyClass });
    this.#live = el('p', {
      role: 'status',
      'aria-live': 'polite',
      class: 'abstain',
    });
    // Attached once: a render replaces only the body, so the live region is
    // never removed and re-inserted (which can cost the announcement).
    root.append(this.#heading, this.#body, this.#live);
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
    if (this.#doc === null && this.#problem === null) {
      this.#doc = pageFeed.doc;
      this.#problem = pageFeed.problem;
    }
    this.render();
  }

  /** build(), contained: a panel that throws refuses only itself. */
  #content() {
    if (!this.#doc)
      return {
        nodes: [],
        abstentions: [this.#problem ?? 'No feed loaded yet.'],
      };
    try {
      return this.build(this.#doc);
    } catch (exc) {
      return {
        nodes: [],
        abstentions: [`This panel could not render the feed: ${exc.message}`],
      };
    }
  }

  render() {
    const { nodes, abstentions } = this.#content();
    this.#heading.textContent = this.heading;
    this.#body.replaceChildren(...nodes);
    this.#live.textContent = abstentions.join(' ');
  }
}
