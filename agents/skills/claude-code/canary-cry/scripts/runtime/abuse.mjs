// canary-cry runtime: the six abuse patterns at intensity 1 (#608 P3; spec
// "Abuse-pattern catalog"). NO IMPORTS: each pattern is written against the
// session API (session.mjs), so it says what it does to a flow and nothing
// about how steps, sign-ins or failures are handled.
//
// `a` is the session's action set; `anchor` is the index of the step the
// scenario attacks. Intensities 2 and 3 arrive with rounds (#608 P4): a
// scenario at any other intensity is refused here, loudly, rather than run
// as intensity 1 under the wrong name.

const RETRY_AFTER_MS = 1_500;

/** i1 "2x @ no throttle": the write step twice in one burst. */
async function multiSubmit(a, anchor) {
  const page = await a.page();
  await a.pre(page, 0, anchor);
  await a.fire(page, { times: 2 });
  await a.post(page, anchor + 1);
}

/** i1 "back": abandon after write k, re-enter, complete the flow. */
async function abandonMidflow(a, anchor) {
  const page = await a.page();
  await a.pre(page, 0, anchor + 1);
  await page.goBack().catch(() => null);
  await a.post(page, 0);
}

/**
 * i1 "delay past UI timeout": the request reaches the server, its response
 * is held, and the impatient user retries before it arrives.
 */
async function staleOptimistic(a, anchor) {
  const page = await a.page();
  await a.pre(page, 0, anchor);
  const held = await a.hold(page);
  await a.fire(page, { wait: false });
  await held.reached;
  await a.pause(RETRY_AFTER_MS);
  await a.fire(page, { wait: false, quiet: true });
  held.release();
  await a.post(page, anchor + 1);
}

/**
 * i1 "2 tabs racing": two pages of one context, each advanced to the write,
 * fire it together. Only the first tab then completes the flow: the race is
 * the abuse, and one completion is what the invariants' delta describes.
 */
async function duplicateTab(a, anchor) {
  const first = await a.page();
  const second = await a.tab(first);
  await a.pre(first, 0, anchor);
  await a.pre(second, 0, anchor);
  await Promise.all([a.fire(first), a.fire(second)]);
  await a.post(first, anchor + 1);
}

/** i1 "before the write": the session keys vanish, the flow continues. */
async function tokenExpiry(a, anchor) {
  const page = await a.page();
  await a.pre(page, 0, anchor);
  await a.expire(page);
  await a.post(page, anchor);
}

/**
 * i1 "sign-out": A completes the flow and signs out; B signs in on the same
 * context (cache, storage, autofill) and runs it. Every page B sees is
 * scanned for A's values.
 */
async function sharedMachine(a) {
  const page = await a.page();
  await a.pre(page, 0, undefined);
  await a.signOut(page);
  if (await a.switchTo('B', page)) await a.post(page, 0);
}

export const PATTERNS = Object.freeze({
  'multi-submit': multiSubmit,
  'abandon-midflow': abandonMidflow,
  'stale-optimistic': staleOptimistic,
  'duplicate-tab': duplicateTab,
  'token-expiry': tokenExpiry,
  'shared-machine': sharedMachine,
});

/**
 * Run the scenario's pattern. An unknown pattern or an intensity this phase
 * cannot inject throws: the scenario then abstains as a runtime error, never
 * runs something smaller under its name.
 */
export function inject(session) {
  const { pattern, intensity } = session.scenario;
  const run = Object.hasOwn(PATTERNS, pattern) ? PATTERNS[pattern] : null;
  if (run === null) throw new Error(`pattern ${pattern} is not implemented`);
  if (intensity !== 1) {
    throw new Error(`${pattern} at intensity ${intensity} is not implemented`);
  }
  return run(session.act, session.anchor);
}
