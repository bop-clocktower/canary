// wcag -- map an axe rule's tags to WCAG success criteria, and hand back a fix
// snippet (#594 D3/D4).
//
// Both halves refuse to invent. A rule carrying no WCAG tag is reported as
// carrying none, rather than mapped to the criterion it looks closest to; a
// rule with no curated snippet gets axe's own help text and URL, rather than a
// snippet generated from the failing HTML. A generated snippet that is subtly
// wrong is worse than no snippet, because it gets pasted.

/** `wcag143` -> `1.4.3`; `wcag1410` -> `1.4.10`. */
const CRITERION_RE = /^wcag(\d)(\d)(\d+)$/;

/** `wcag2aa`, `wcag21aa`, `wcag22a` -> the conformance level. */
const LEVEL_RE = /^wcag2[12]?(a{1,3})$/;

/**
 * @param {string[]} tags axe rule tags
 * @returns {{criteria: string[], level: (string|null), labelled: boolean}}
 */
export function mapWcag(tags) {
  const criteria = [];
  let level = null;

  for (const tag of tags ?? []) {
    const criterion = CRITERION_RE.exec(tag);
    if (criterion) {
      criteria.push(`${criterion[1]}.${criterion[2]}.${criterion[3]}`);
      continue;
    }
    const lvl = LEVEL_RE.exec(tag);
    // Highest level named wins: a rule tagged both wcag2a and wcag21aa is an
    // AA rule for a reader deciding what to fix first.
    if (lvl && (level === null || lvl[1].length > level.length)) {
      level = lvl[1];
    }
  }

  return {
    criteria,
    level: level ? level.toUpperCase() : null,
    labelled: criteria.length > 0,
  };
}

/**
 * Curated fixes for the rules that dominate real axe output. Flat data, so the
 * module's complexity stays at 1 however long the table grows.
 */
export const SNIPPETS = {
  'image-alt':
    'Give the image a text alternative: `<img src="..." alt="What the image conveys">`. Decorative? `alt=""` plus `role="presentation"`.',
  'input-image-alt':
    'An `<input type="image">` needs `alt` describing the ACTION, not the picture: `<input type="image" src="go.png" alt="Search">`.',
  'button-name':
    'Give the button an accessible name: visible text, or `aria-label="Close"` when it is icon-only.',
  'link-name':
    'Give the link text that makes sense out of context. Replace "click here"; for an icon link use `aria-label`.',
  label:
    'Associate a label with the control: `<label for="email">Email</label><input id="email">`, or wrap the input in the label.',
  'select-name':
    'Give the `<select>` a programmatic label via `<label for>` or `aria-label`.',
  'color-contrast':
    'Raise the contrast to at least 4.5:1 for body text (3:1 for text 18.66px bold or 24px+). Change the token, not the one component.',
  'html-has-lang':
    'Set the document language: `<html lang="en">`. Use the actual language of the content.',
  'document-title':
    'Give the page a unique, descriptive `<title>`; put the page-specific part first.',
  'frame-title':
    'Give every `<iframe>` a `title` describing its content: `<iframe title="Checkout payment form">`.',
  'aria-required-attr':
    'Add the ARIA attributes the role requires (for example `role="checkbox"` needs `aria-checked`). Better: use the native element instead.',
  'aria-hidden-focus':
    '`aria-hidden="true"` must not contain focusable content. Remove the element from the tab order with `tabindex="-1"`, or stop hiding it.',
  'heading-order':
    'Do not skip heading levels. Use CSS for size; the level expresses structure, not appearance.',
  'landmark-one-main':
    'Give the page exactly one `<main>` landmark wrapping the primary content.',
  region:
    'Put all content inside a landmark (`<header>`, `<nav>`, `<main>`, `<footer>`), so screen-reader users can jump between regions.',
  list: '`<ul>`/`<ol>` may only contain `<li>` (plus script/template). Move wrappers inside the `<li>`.',
  'meta-viewport':
    'Remove `user-scalable=no` and any `maximum-scale` below 5 from the viewport meta tag; zoom must stay available.',
  tabindex:
    'Avoid `tabindex` greater than 0 — it overrides document order for the whole page. Use 0, or fix the DOM order.',
  'th-has-data-cells':
    'Every `<th>` must head real data cells, and data cells should reference headers via `scope` or `headers`.',
  'duplicate-id-active':
    'Make the id unique. A duplicated id on an active element breaks label and ARIA references silently.',
};

/**
 * @param {string} rule axe rule id
 * @param {string} help axe's own one-line help
 * @param {string} helpUrl axe's rule documentation URL
 * @returns {string}
 */
export function fixFor(rule, help, helpUrl) {
  // `Object.hasOwn`, not a truthy index: a rule literally named `constructor`
  // would otherwise resolve to a function off the prototype and be rendered
  // into the report as a fix.
  if (Object.hasOwn(SNIPPETS, rule)) return SNIPPETS[rule];
  return (
    `No canary snippet for \`${rule}\` — axe says: ${help ?? 'no help text'}. ` +
    `See ${helpUrl ?? 'the axe rule documentation'}.`
  );
}
