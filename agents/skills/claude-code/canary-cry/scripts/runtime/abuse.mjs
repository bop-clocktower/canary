// canary-cry runtime: the six abuse patterns at intensities 1 to 3 (#608 P3,
// P4; spec "Abuse-pattern catalog"). NO IMPORTS: each pattern is written
// against the session API (session.mjs), so it says what it does to a flow
// and nothing about how steps, sign-ins or failures are handled.
//
// `a` is the session's action set; `anchor` is the index of the step the
// scenario attacks; `n` is the intensity. Each intensity is the catalog's
// words (patterns.mjs) made concrete. A scenario at any other intensity is
// refused here, loudly, rather than run as some other intensity under its
// name.
//
// Whether an intensity can complete the flow is the catalog's `mayRefuse`
// flag, never decided here: abandon-midflow i3 is the one runner that leaves
// the flow unfinished, and patterns.mjs marks exactly that intensity.

/** The highest intensity the runners inject; the tests pin it to the catalog's. */
export const INTENSITY_CEILING = 3;

const RETRY_AFTER_MS = 1_500;

/** i1 2x @ no throttle, i2 3x @ 400 ms, i3 5x @ 3 s. */
const BURSTS = [
  { times: 2, latencyMs: 0 },
  { times: 3, latencyMs: 400 },
  { times: 5, latencyMs: 3_000 },
];

/** The write step fired `times` at once, its requests under the latency. */
async function multiSubmit(a, anchor, n) {
  const { times, latencyMs } = BURSTS[n - 1];
  const page = await a.page();
  await a.pre(page, 0, anchor);
  if (latencyMs > 0) await a.slow(page, latencyMs);
  await a.fire(page, { times });
  await a.post(page, anchor + 1);
}

const LEAVE = ['back', 'reload', 'close'];

/**
 * Abandon after write k. i1 (back) and i2 (reload) re-enter and complete the
 * flow; i3 closes the context, as a user closing the browser would, and
 * never comes back -- what it measures is what the abandoned writes left.
 */
async function abandonMidflow(a, anchor, n) {
  const how = LEAVE[n - 1];
  const page = await a.page();
  await a.pre(page, 0, anchor + 1);
  if (how === 'close') return a.close(page);
  await a.leave(page, how);
  return a.post(page, 0);
}

const ANSWER = ['hold', 'fail', 'drop'];

/**
 * The request reaches the server; the client is then answered late (i1,
 * past the UI timeout), with a fake 500 (i2), or not at all (i3, dropped).
 * The impatient user retries either way.
 */
async function staleOptimistic(a, anchor, n) {
  const page = await a.page();
  await a.pre(page, 0, anchor);
  const held = await a.hold(page, ANSWER[n - 1]);
  await a.fire(page, { wait: false });
  await held.reached;
  await a.pause(RETRY_AFTER_MS);
  await a.fire(page, { wait: false, quiet: true });
  held.release();
  await a.post(page, anchor + 1);
}

const TABS = [2, 3, 3];

/**
 * Several pages of one context, each advanced to the write, fire it
 * together. Only the first tab then completes the flow: the race is the
 * abuse, and one completion is what the invariants' delta describes.
 */
async function duplicateTab(a, anchor, n) {
  const first = await a.page();
  const pages = [first];
  for (let i = 1; i < TABS[n - 1]; i += 1) pages.push(await a.tab(first));
  for (const page of pages) await a.pre(page, 0, anchor);
  await Promise.all(pages.map((page) => a.fire(page)));
  await a.post(first, anchor + 1);
}

/**
 * The session keys vanish: before the write (i1), right after the first
 * write (i2, so later writes go out unauthenticated), or before every step
 * from the write on (i3).
 */
async function tokenExpiry(a, anchor, n) {
  const page = await a.page();
  await a.pre(page, 0, anchor);
  if (n === 3) return a.post(page, anchor, { before: () => a.expire(page) });
  if (n === 2) await a.fire(page);
  await a.expire(page);
  return a.post(page, n === 2 ? anchor + 1 : anchor);
}

/**
 * A completes the flow; B then signs in on the same context (cache,
 * storage, autofill) and runs it. A signs out (i1), signs out and presses
 * back so the next user sits down to A's last page (i2), or never signs out
 * (i3). Every page B sees is scanned for A's values.
 */
async function sharedMachine(a, _anchor, n) {
  const page = await a.page();
  await a.pre(page, 0, undefined);
  if (n < 3) await a.signOut(page);
  if (n === 2) await a.peek(page);
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

const isRound = (n) => Number.isInteger(n) && n >= 1 && n <= INTENSITY_CEILING;

/**
 * Run the scenario's pattern. An unknown pattern or an intensity outside
 * 1..ceiling throws: the scenario then abstains as a runtime error, never
 * runs something else under its name.
 */
export function inject(session) {
  const { pattern, intensity } = session.scenario;
  const run = Object.hasOwn(PATTERNS, pattern) ? PATTERNS[pattern] : null;
  if (run === null) throw new Error(`pattern ${pattern} is not implemented`);
  if (!isRound(intensity)) {
    throw new Error(`${pattern} at intensity ${intensity} is not implemented`);
  }
  return run(session.act, session.anchor, intensity);
}
