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
// clothes. Nor is a DESCENDANT's marker borrowed: `node.html` is outer HTML,
// so only the failing element's own opening tag is read. An unattributed node
// is returned as unattributed, and the caller counts it -- that count is how a
// reader knows how much of the report to trust.

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
 * Match a root element's OPENING TAG and capture only its attribute text.
 *
 * The alternation consumes whole quoted values before it will accept a bare
 * `>`, so an attribute value containing `>` does not terminate the tag early.
 * `html.indexOf('>')` would, which is why it is not used.
 */
const OPENING_TAG = /^<[a-zA-Z][^\s>]*((?:"[^"]*"|'[^']*'|[^>"'])*)>/;

/**
 * The attribute text of the failing element's OWN opening tag.
 *
 * axe's `node.html` is the element's OUTER HTML, so it carries the element's
 * children too. Searching the whole string would let a shared descendant's
 * marker -- an icon `<span data-testid="icon-chevron">` inside an unmarked
 * button -- stand in as the failing element's identity. Two structurally
 * different buttons wrapping that same icon would then merge into one finding
 * with one fix line, and a reader remediating one site would believe the other
 * was covered. Worse, the node would stop incrementing `unattributed_nodes`,
 * so the very counter that says how much of the report to trust would be
 * deflated by exactly the nodes whose attribution is least trustworthy.
 *
 * @returns {string} the opening tag's attributes, or '' when none can be read
 */
function openingTagAttrs(html) {
  const match = OPENING_TAG.exec((html ?? '').trimStart());
  return match ? match[1] : '';
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
 * Order: the failing element's own OPENING TAG first -- never its descendants,
 * which `node.html` also contains -- then any attribute selector in the target
 * path (D2 -- an ancestor's marker is reachable only when axe happened to
 * serialise it as a selector segment; no DOM is reconstructed). The target
 * path is a selector string rather than HTML, so it is searched whole.
 *
 * @param {{html?: string, target?: unknown}} node
 * @param {string[]} attrs attribute priority list
 * @returns {{component: string|null, source: string|null}}
 */
export function attributeNode(node, attrs) {
  for (const attr of attrs) {
    const own = attrValue(openingTagAttrs(node?.html), attr);
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
