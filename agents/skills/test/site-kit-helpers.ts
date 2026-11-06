// DOM mount helpers for site-kit panel tests. The data builders live in
// site-feed-builders.ts so node-only tests (canary-barda) can use them under
// tsconfig.json, which carries no DOM lib (#1201).
export * from './site-feed-builders.js';
import { NOW } from './site-feed-builders.js';

let tags = 0;
type Mounted = HTMLElement & { now: () => number; feed: unknown };

/**
 * Defines `cls` under a fresh tag (one constructor cannot back two tags, so it
 * is subclassed), mounts it with a pinned clock, and sets `feed` unless it is
 * undefined. Returns the panel's shadow root.
 */
export function mount(
  cls: CustomElementConstructor,
  feed?: unknown,
  now = NOW,
): ShadowRoot {
  const tag = `test-panel-${++tags}`;
  customElements.define(tag, class extends cls {});
  const node = document.createElement(tag) as Mounted;
  node.now = () => now;
  document.body.append(node);
  if (feed !== undefined) node.feed = feed;
  return node.shadowRoot!;
}

/** The panel's live region text: where every abstention must land. */
export const live = (root: ShadowRoot) =>
  root.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? '';
