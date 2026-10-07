// page -- the index.html canary-barda writes (#1151 phase 3b).
//
// No inline script, no inline style and no handler attribute: the page loads
// kit/canary-site.js and kit/*.css from its own origin, so it runs under a
// `script-src 'self'` CSP. The kit finds the feed through the meta tag.

/** Must match the tags lib/site-kit/canary-site.js registers (tested). */
export const PANEL_TAGS = [
  'canary-summary',
  'canary-pipeline-health',
  'canary-pass-rate',
  'canary-failures-by-area',
  'canary-flaky',
  'canary-pillars',
  'canary-register',
];

const escape = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Light-DOM text, shown only if the kit never runs (opened from file://, or
// kit/ not deployed). Panels render into a slot-less shadow root, so once a
// panel upgrades this is hidden -- no inline script needed to say why.
const FALLBACK =
  '<p>This panel did not load: kit/canary-site.js could not run. ' +
  'Serve this directory over http(s); a file:// page cannot load it.</p>';

export function page({ title }) {
  const t = escape(title);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="canary-feed" content="site.json">
    <title>${t}</title>
    <link rel="stylesheet" href="kit/tokens.css">
    <link rel="stylesheet" href="kit/page.css">
    <script type="module" src="kit/canary-site.js"></script>
  </head>
  <body>
    <header class="brand">
      <div class="brand-inner">
        <img src="kit/mark.svg" alt="" width="32" height="32">
        <span>canary</span>
      </div>
    </header>
    <main>
      <div class="page-head">
        <h1>${t}</h1>
        <p>Test health across every declared suite, from the canary.site/1 feed.</p>
      </div>
${PANEL_TAGS.map((tag) => `      <${tag}>${FALLBACK}</${tag}>`).join('\n')}
    </main>
  </body>
</html>
`;
}
