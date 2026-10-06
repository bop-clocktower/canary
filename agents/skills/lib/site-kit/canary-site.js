// canary-site -- registers the six QA site panels and loads the feed (#1151
// phase 3). The kit's one entry point.
//
// A page opts in with <meta name="canary-feed" content="site.json">; every
// canary-* panel on it then gets the parsed feed. A failed fetch, or a feed
// of another contract or major (D3), is refused on every panel with the
// reason: a panel never renders "all clear" over a feed it could not read.
// The kit does not re-validate the feed; canary-barda refuses an invalid one
// before it is ever published.

import { PipelineHealth } from './panels/pipeline-health.js';
import { PassRate } from './panels/pass-rate.js';
import { FailuresByArea } from './panels/failures-by-area.js';
import { Flaky } from './panels/flaky.js';
import { Pillars } from './panels/pillars.js';
import { Register } from './panels/register.js';
import { pageFeed } from './panel.js';

const CONTRACT = 'canary.site/1';
const PANELS = {
  'canary-pipeline-health': PipelineHealth,
  'canary-pass-rate': PassRate,
  'canary-failures-by-area': FailuresByArea,
  'canary-flaky': Flaky,
  'canary-pillars': Pillars,
  'canary-register': Register,
};

export function define(registry = customElements) {
  for (const [tag, cls] of Object.entries(PANELS))
    if (!registry.get(tag)) registry.define(tag, cls);
}

async function read(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const doc = await res.json();
  if (doc?.contract !== CONTRACT)
    throw new Error(
      `${url} is ${JSON.stringify(doc?.contract ?? null)}, not ${CONTRACT}`,
    );
  return doc;
}

/**
 * Loads the page's declared feed into every panel; resolves either way.
 * @param {ParentNode} [root]
 * @param {(url: string) => Promise<{ok: boolean, status: number, json(): Promise<any>}>} [fetchImpl]
 */
export async function loadFeed(root = document, fetchImpl = globalThis.fetch) {
  const url = root
    .querySelector('meta[name="canary-feed"]')
    ?.getAttribute('content');
  if (!url) return;
  try {
    pageFeed.doc = await read(url, fetchImpl);
    pageFeed.problem = null;
  } catch (exc) {
    pageFeed.doc = null;
    pageFeed.problem = `The feed could not be loaded: ${exc.message}`;
  }
  // Each panel contains its own render errors (panel.js), so one panel that
  // cannot render a field never blanks the others.
  for (const p of root.querySelectorAll(Object.keys(PANELS).join(',')))
    if (pageFeed.doc) p.feed = pageFeed.doc;
    else p.refuse(pageFeed.problem);
}

define();
loadFeed();
