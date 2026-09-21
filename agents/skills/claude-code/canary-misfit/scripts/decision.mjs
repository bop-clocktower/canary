// canary-misfit -- the seeded injection decision: matching, the reproduction
// key, and the burst window (#592).
//
// Split out of `profiles.mjs`, which owns the profile VOCABULARY (the fault
// kinds, the named network envelopes) and the validation/normalization that
// produces the one shape every consumer reads. This module owns the other
// half: given an already-normalized profile and a request identity, what --
// if anything -- happens to that request.
//
// The seam is a real one, not a line-count cut: nothing here imports
// `profiles.mjs`. The decision reads normalized fault fields and never
// re-validates, so the model can gain a field without touching the decision
// and the decision can change without touching the schema.
//
// Nothing in this file imports Playwright, and nothing in it reads a clock,
// an RNG, or an iteration order. Every decision is a pure function of
// (seed, fault id, request identity) -- see `decisionKey` and `burstIndex`.

// --- matching ---------------------------------------------------------------

/**
 * Minimal glob: `**` spans separators, `*` does not, `?` is one character.
 * Deliberately not a dependency -- skills stay installable-free.
 */
export function matchesGlob(pattern, url) {
  const regex = pattern.split('').reduce((acc, ch, i, all) => {
    if (ch === '*' && all[i - 1] === '*') return acc; // consumed by the pair
    if (ch === '*') return acc + (all[i + 1] === '*' ? '.*' : '[^/]*');
    if (ch === '?') return acc + '.';
    return acc + ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }, '');
  return new RegExp(`^${regex}$`).test(url);
}

// --- the seeded decision ----------------------------------------------------

/** FNV-1a over UTF-16 code units. Stable across processes and node versions. */
function fnv1a(text) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: one draw is all we need, so the generator is inlined. */
function draw(state) {
  let a = state | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * The reproduction key. Keyed by request IDENTITY (method, url, ordinal within
 * that method+url for the flow), never by arrival order: a parallel suite has
 * no stable arrival order, so an order-keyed decision would be unreproducible
 * exactly in the runs people care about reproducing.
 */
export function decisionKey(seed, faultId, request) {
  return `${seed}|${faultId}|${request.method} ${request.url}#${request.ordinal ?? 0}`;
}

/** Does one request's own roll come up for this fault? */
function rolls(seed, fault, request) {
  return draw(fnv1a(decisionKey(seed, fault.id, request))) < fault.rate;
}

/**
 * Where this request sits inside a burst, or null if the fault does not fire
 * for it at all.
 *
 * `burst: N` means N CONSECUTIVE responses in total -- the request whose own
 * roll came up, plus the N-1 requests of the same identity that follow it.
 * That is the reading the docs already state ("`burst` for consecutive", and a
 * worked `"burst": 3` example in the proposal): N is the size of the burst,
 * not a count of extras after the first. `burst` defaults to 1, so an
 * undeclared burst is exactly the single-response behaviour.
 *
 * It is resolved by looking BACKWARDS over the ordinal window rather than by
 * counting forwards in mutable state, and that is the whole design: a counter
 * would make the decision depend on arrival order, which is precisely what
 * `decisionKey` exists to avoid. Every roll here is still a pure function of
 * (seed, fault id, request identity), so the same seed reproduces the same
 * burst whatever order the requests arrive in, and across processes.
 *
 * `burst` is documented for `error`; the window is kind-agnostic because a
 * default of 1 makes it a no-op everywhere it was not asked for.
 *
 * @returns {number|null} 0-based position in the burst, or null
 */
function burstIndex(seed, fault, request) {
  const ordinal = request.ordinal ?? 0;
  const window = Math.min(fault.burst, ordinal + 1);
  for (let back = 0; back < window; back += 1) {
    if (rolls(seed, fault, { ...request, ordinal: ordinal - back }))
      return back;
  }
  return null;
}

/**
 * Decide what, if anything, to do to one request under one profile.
 *
 * Faults are evaluated in declaration order and the FIRST one that matches and
 * fires wins, so an author reads the profile top to bottom.
 *
 * @returns {{fault: object, action: object}|null} null = let the request through
 */
export function decide(profile, request) {
  for (const fault of profile.faults) {
    if (!matchesGlob(fault.match, request.url)) continue;
    const index = burstIndex(profile.seed, fault, request);
    if (index === null) continue;
    return { fault, action: actionFor(fault, index) };
  }
  return null;
}

/** What the injector should actually do for a fired fault. */
function actionFor(fault, burstPosition = 0) {
  if (fault.kind === 'latency')
    return { type: 'delay', delay_ms: fault.delay_ms };
  if (fault.kind === 'error') {
    return {
      type: 'fulfill',
      status: fault.status,
      burst: fault.burst,
      burst_index: burstPosition,
    };
  }
  if (fault.kind === 'abort') return { type: 'abort', reason: fault.reason };
  // network: an envelope becomes a delay at this layer. The jitter allowance is
  // added in full rather than sampled -- a sampled jitter would be one more
  // source of run-to-run variance in the one feature whose promise is that
  // there is none. Loss and bandwidth are carried in the envelope for #858's
  // protocol-layer consumer, which can shape what a route handler cannot.
  const { latency_ms, jitter_ms } = fault.envelope;
  return {
    type: 'delay',
    delay_ms: latency_ms + jitter_ms,
    envelope: fault.envelope,
  };
}
