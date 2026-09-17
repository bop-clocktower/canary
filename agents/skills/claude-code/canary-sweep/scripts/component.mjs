// component -- attribute a failing axe node to a UI component (#594 D1/D2).
//
// This is the whole point of the skill, so it is also the place where a
// shortcut would do the most damage. An axe node carries only the failing
// element's outer HTML, a CSS selector path, and a failure summary. There is no
// component model in that data, so attribution can only read what the author
// explicitly marked.
//
// What is deliberately NOT done: synthesising a key from the tag name plus the
// class list, or from a selector segment. That would produce a key for every
// node and make the report look complete, while merging two different buttons
// that share a utility class and splitting one component whose classes vary by
// state. A key derived from a proxy is a guess wearing an attribution's
// clothes. An unattributed node is returned as unattributed, and the caller
// counts it -- that count is how a reader knows how much of the report to
// trust.

/** Attribute priority, highest first. Overridable with --component-attr. */
export const DEFAULT_ATTRS = [
  'data-component',
  'data-testid',
  'data-test',
  'data-qa',
];

/** Escape a literal for embedding in a RegExp source. */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read `attr="value"` (or single-quoted) off a fragment of HTML.
 *
 * @returns {string|null} the value, or null when the attribute is absent
 */
function attrValue(html, attr) {
  const match = new RegExp(`${escapeRe(attr)}\\s*=\\s*["']([^"']+)["']`).exec(
    html ?? '',
  );
  return match ? match[1] : null;
}

/**
 * axe's `target` is an array of selectors, and for content inside an iframe it
 * is an array OF arrays. Flattening keeps the iframe case from silently
 * stringifying to `[object Object]`-ish garbage that matches nothing.
 */
function flattenTarget(target) {
  if (!Array.isArray(target)) return [];
  return target.flat(Infinity).filter((part) => typeof part === 'string');
}

/**
 * Attribute one node.
 *
 * Order: the failing element's own HTML first, then any attribute selector in
 * the target path (D2 -- an ancestor's marker is reachable only when axe
 * happened to serialise it as a selector segment; no DOM is reconstructed).
 *
 * @param {{html?: string, target?: unknown}} node
 * @param {string[]} attrs attribute priority list
 * @returns {{component: string|null, source: string|null}}
 */
export function attributeNode(node, attrs) {
  for (const attr of attrs) {
    const own = attrValue(node?.html, attr);
    if (own) return { component: own, source: attr };
  }

  const path = flattenTarget(node?.target).join(' ');
  for (const attr of attrs) {
    const fromPath = attrValue(path, attr);
    if (fromPath)
      return { component: fromPath, source: `${attr} (target path)` };
  }

  return { component: null, source: null };
}
