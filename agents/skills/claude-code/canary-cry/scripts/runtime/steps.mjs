// canary-cry runtime: template values and flow steps (#608 P3). NO IMPORTS:
// codegen copies runtime/ into every run dir, where it must stand alone.
//
// Template values resolve at run time only. `{{account.<K>.<field>}}` comes
// from the JSON object in the env var targets.json names for account K -- read
// inside the browser run, never written to any artifact. `{{fixture.<name>}}`
// comes from the flows file. `{{unique.<kind>}}` is derived from the seed and
// the scenario id, so a re-run of one spec types the same data (the repro)
// while two scenarios never collide.

const TEMPLATE_RE = /\{\{([^}]*)\}\}/g;
const STEP_TIMEOUT_MS = 10_000;

/** A step that failed, by id; the session decides what that means. */
export class StepFailure extends Error {
  constructor(stepId, cause) {
    super(`step ${stepId} failed: ${cause?.message ?? cause}`);
    this.stepId = stepId;
  }
}

/** FNV-1a, 32 bit: deterministic, dependency-free, plenty for test data. */
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** `{{unique.email}}` is a mail address on the reserved .invalid TLD. */
export function uniqueValue(seed, scenarioId, kind) {
  const h = fnv(`${seed}|${scenarioId}|${kind}`);
  return kind === 'email' ? `cry.${h}@cry.invalid` : `cry-${kind}-${h}`;
}

/**
 * The template lookup for one scenario. `alias` maps account keys, so the
 * sign-in flow written for A signs B in when `{A: 'B'}`.
 * @param {{accounts: Record<string, object>, fixtures: object, seed: number,
 *   id: string}} source
 */
export function lookupFor(source, alias = {}) {
  return (ref) => {
    const [kind, a, b] = ref.split('.');
    if (kind === 'fixture' && Object.hasOwn(source.fixtures, a)) {
      return String(source.fixtures[a]);
    }
    if (kind === 'unique') return uniqueValue(source.seed, source.id, a);
    const account = source.accounts[alias[a] ?? a];
    if (kind === 'account' && account && Object.hasOwn(account, b)) {
      return String(account[b]);
    }
    throw new Error(`unresolved template {{${ref}}}`);
  };
}

export const resolve = (text, lookup) =>
  text.replace(TEMPLATE_RE, (_, ref) => lookup(ref));

/** `POST /api/orders` -> a predicate over a Playwright Request. */
export function requestMatcher(spec) {
  const [method, target] = spec.split(' ');
  const withQuery = target.includes('?');
  return (request) => {
    const url = new URL(request.url());
    const seen = withQuery ? url.pathname + url.search : url.pathname;
    return request.method() === method && seen === target;
  };
}

const responseMatcher = (spec) => {
  const matches = requestMatcher(spec);
  return (response) => matches(response.request());
};

/** Dispatch the step's action once. */
async function act(page, step, lookup) {
  const opts = { timeout: STEP_TIMEOUT_MS };
  const value = step.value === undefined ? '' : resolve(step.value, lookup);
  const at = () => page.locator(resolve(step.selector, lookup)).first();
  switch (step.action) {
    case 'goto':
      return page.goto(resolve(step.url, lookup), opts);
    case 'fill':
      return at().fill(value, opts);
    case 'select':
      return at().selectOption(value, opts);
    case 'press':
      return page.keyboard.press(step.key);
    case 'waitFor':
      return at().waitFor({ state: 'visible', ...opts });
    default:
      return at().click(opts);
  }
}

/**
 * Fire a click `times` times in one synchronous burst inside the page: an
 * impatient user is faster than any round trip, so the app's own guard (a
 * disabled button, an in-flight flag) is what stops the second submit, not
 * Playwright's actionability wait.
 */
async function burst(page, step, lookup, times) {
  const target = page.locator(resolve(step.selector, lookup)).first();
  await target.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await target.evaluate((el, n) => {
    for (let i = 0; i < n; i += 1) el.click();
  }, times);
}

async function dispatch(page, step, lookup, times) {
  if (step.action === 'click') return burst(page, step, lookup, times);
  for (let i = 0; i < times; i += 1) await act(page, step, lookup);
  return undefined;
}

/**
 * Run one step `times` times (1 for an ordinary step), waiting on its
 * `awaitResponse` unless `wait` is false (a held response would deadlock).
 * Throws StepFailure naming the step.
 */
export async function runStep(page, step, lookup, { times = 1, wait = true }) {
  try {
    const waiting =
      wait && step.awaitResponse
        ? page.waitForResponse(responseMatcher(step.awaitResponse), {
            timeout: STEP_TIMEOUT_MS,
          })
        : null;
    // Handled here so a dispatch failure does not leave it unhandled.
    waiting?.catch(() => {});
    await dispatch(page, step, lookup, times);
    if (waiting) await waiting;
  } catch (exc) {
    throw new StepFailure(step.id, exc);
  }
}
