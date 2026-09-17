// canary-misfit -- the degradation profile: vocabulary, validation, and the
// seeded injection decision (#592).
//
// This module is the SHARED vocabulary referenced by #858 (load scenario
// composer). The four named network envelopes below and the four fault kinds
// are the definition both layers read: at the Playwright `route` layer an
// envelope becomes a per-request delay, at the k6/protocol layer it becomes a
// network profile. Same names, same four numbers, one definition -- which is
// the whole point of specifying them here rather than twice.
//
// Nothing in this file imports Playwright. The decision is a pure function of
// (seed, fault id, request identity), so it is testable without a browser and
// reproducible across processes -- see `decide`.

/** The only fault kinds v1 understands. */
export const FAULT_KINDS = ['latency', 'error', 'abort', 'network'];

/**
 * Named network envelopes. Four numbers each, deliberately: latency, jitter,
 * loss and bandwidth are what both a route-layer delay and a protocol-layer
 * shaper can express. Adding a fifth field here is a cross-layer change.
 */
export const NETWORK_ENVELOPES = Object.freeze({
  'slow-3g': {
    latency_ms: 400,
    jitter_ms: 200,
    loss_rate: 0.02,
    bandwidth_kbps: 400,
  },
  'fast-3g': {
    latency_ms: 150,
    jitter_ms: 75,
    loss_rate: 0.01,
    bandwidth_kbps: 1600,
  },
  'regional-edge': {
    latency_ms: 80,
    jitter_ms: 40,
    loss_rate: 0.0,
    bandwidth_kbps: 8000,
  },
  satellite: {
    latency_ms: 650,
    jitter_ms: 250,
    loss_rate: 0.03,
    bandwidth_kbps: 1000,
  },
});

/** Resolve a named envelope, or null when the name is not in the vocabulary. */
export function networkEnvelope(name) {
  return Object.prototype.hasOwnProperty.call(NETWORK_ENVELOPES, name)
    ? NETWORK_ENVELOPES[name]
    : null;
}

// --- validation -------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rateErrors(fault, where) {
  const { rate } = fault;
  if (rate === undefined) return [];
  if (typeof rate !== 'number' || Number.isNaN(rate) || rate < 0 || rate > 1) {
    return [
      `${where}: rate must be a number in 0..1, got ${JSON.stringify(rate)}`,
    ];
  }
  return [];
}

/** Per-kind required shape. Each returns the errors it found. */
const KIND_RULES = {
  latency: (fault, where) =>
    typeof fault.delay_ms === 'number' && fault.delay_ms >= 0
      ? []
      : [`${where}: latency requires a non-negative delay_ms`],
  error: (fault, where) =>
    Number.isInteger(fault.status) && fault.status >= 400 && fault.status <= 599
      ? []
      : [`${where}: error requires an integer status in 400..599`],
  abort: () => [],
  network: (fault, where) =>
    networkEnvelope(fault.profile)
      ? []
      : [
          `${where}: unknown network profile ${JSON.stringify(fault.profile)} ` +
            `(known: ${Object.keys(NETWORK_ENVELOPES).join(', ')})`,
        ],
};

function faultErrors(fault, index, seenIds) {
  const where = `faults[${index}]`;
  if (!isPlainObject(fault)) return [`${where}: must be an object`];

  const errors = [];
  if (typeof fault.id !== 'string' || fault.id === '') {
    errors.push(`${where}: id must be a non-empty string`);
  } else if (seenIds.has(fault.id)) {
    // Duplicate ids are not cosmetic: the id keys the seeded decision, so two
    // faults sharing one would make identical decisions and the report could
    // not say which fault fired.
    errors.push(`${where}: duplicate fault id ${JSON.stringify(fault.id)}`);
  } else {
    seenIds.add(fault.id);
  }

  if (!FAULT_KINDS.includes(fault.kind)) {
    errors.push(
      `${where}: unknown kind ${JSON.stringify(fault.kind)} ` +
        `(known: ${FAULT_KINDS.join(', ')})`,
    );
  } else {
    errors.push(...KIND_RULES[fault.kind](fault, where));
  }
  errors.push(...rateErrors(fault, where));
  return errors;
}

/**
 * Validate a parsed profile.
 *
 * @returns {{profile: object|null, errors: string[]}}
 */
export function validateProfile(raw) {
  if (!isPlainObject(raw))
    return { profile: null, errors: ['profile must be a JSON object'] };

  const errors = [];
  if (raw.schema_version !== 1) {
    errors.push(
      `schema_version must be 1, got ${JSON.stringify(raw.schema_version)}`,
    );
  }
  if (!Number.isSafeInteger(raw.seed)) {
    // A determinism feature whose seed is a float or absent is a determinism
    // claim nobody can act on.
    errors.push(`seed must be an integer, got ${JSON.stringify(raw.seed)}`);
  }
  if (
    raw.budget_ms !== undefined &&
    !(typeof raw.budget_ms === 'number' && raw.budget_ms > 0)
  ) {
    errors.push(
      `budget_ms must be a positive number, got ${JSON.stringify(raw.budget_ms)}`,
    );
  }
  if (!Array.isArray(raw.faults) || raw.faults.length === 0) {
    errors.push('faults must be a non-empty array');
    return { profile: null, errors };
  }

  const seenIds = new Set();
  raw.faults.forEach((fault, index) =>
    errors.push(...faultErrors(fault, index, seenIds)),
  );

  return { profile: errors.length ? null : normalizeProfile(raw), errors };
}

/** A positive integer burst count, defaulting to one response. */
function burstOf(fault) {
  if (Number.isInteger(fault.burst) && fault.burst > 0) return fault.burst;
  return 1;
}

function envelopeOf(fault) {
  if (fault.kind !== 'network') return null;
  return networkEnvelope(fault.profile);
}

/** One fault with every documented default filled in. */
function normalizeFault(fault) {
  const match = typeof fault.match === 'string' ? fault.match : '**';
  const rate = fault.rate === undefined ? 1 : fault.rate;
  return {
    id: fault.id,
    kind: fault.kind,
    match,
    rate,
    delay_ms: fault.delay_ms === undefined ? null : fault.delay_ms,
    status: fault.status === undefined ? null : fault.status,
    burst: burstOf(fault),
    reason: fault.reason === undefined ? 'failed' : fault.reason,
    profile: fault.profile === undefined ? null : fault.profile,
    envelope: envelopeOf(fault),
  };
}

/** Fill the documented defaults so every consumer reads one shape. */
function normalizeProfile(raw) {
  return {
    schema_version: 1,
    name: typeof raw.name === 'string' ? raw.name : 'unnamed',
    seed: raw.seed,
    budget_ms: raw.budget_ms === undefined ? null : raw.budget_ms,
    faults: raw.faults.map(normalizeFault),
  };
}

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
    const roll = draw(fnv1a(decisionKey(profile.seed, fault.id, request)));
    if (roll >= fault.rate) continue;
    return { fault, action: actionFor(fault) };
  }
  return null;
}

/** What the injector should actually do for a fired fault. */
function actionFor(fault) {
  if (fault.kind === 'latency')
    return { type: 'delay', delay_ms: fault.delay_ms };
  if (fault.kind === 'error') {
    return { type: 'fulfill', status: fault.status, burst: fault.burst };
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
