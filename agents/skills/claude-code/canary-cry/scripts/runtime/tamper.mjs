// canary-cry runtime: what an abuse pattern does to the network, the page's
// history and the session keys (#608 P3, P4). Copied into run dirs beside
// the other runtime modules; session.mjs exposes these to the patterns
// (abuse.mjs) as actions, so a pattern never touches Playwright's routing
// itself.
//
// Every route here intercepts only requests to the target's own hosts, and
// falls back to the context's egress lockdown (guard.mjs) for the rest.

import { INJECTED_HEADER, hostAllowed } from './guard.mjs';
import { requestMatcher } from './steps.mjs';

const HOLD_LIMIT_MS = 15_000;
const REACH_LIMIT_MS = 10_000;
const API_TYPES = new Set(['fetch', 'xhr']);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const ours = (hosts, req) => hostAllowed(new URL(req.url()).hostname, hosts);

/**
 * How the client is answered once the server has the request (#608 P4):
 * `hold` the real response until released (i1), a `fail`ed fake 500 (i2), or
 * `drop` it (i3). The fake 500 carries INJECTED_HEADER so guard.mjs never
 * records canary-cry's own answer as the app's 5xx.
 */
async function answer(route, response, mode, released) {
  if (mode === 'drop') return route.abort('failed');
  if (mode === 'fail') {
    return route.fulfill({
      status: 500,
      headers: { [INJECTED_HEADER]: 'fake-500' },
      contentType: 'application/json',
      body: '{"error":"canary-cry: fake 500"}',
    });
  }
  await Promise.race([released, sleep(HOLD_LIMIT_MS)]);
  return route.fulfill({ response });
}

/**
 * `route.fetch()` stores the real response's Set-Cookie in the context at
 * once, before the client has seen anything -- a fake 500 or a drop would
 * then still hand the browser, say, a cleared cart cookie it never received,
 * and the retry would be one no real client could send. The jar is put back
 * as it was; a delivered response (`hold`) sets its cookies on fulfill.
 */
async function fetchUnseen(route, context) {
  const jar = await context.cookies();
  const response = await route.fetch();
  await context.clearCookies();
  if (jar.length) await context.addCookies(jar);
  return response;
}

/**
 * The first request matching `spec` (`POST /api/orders`) reaches the server;
 * `mode` decides what the client sees. `reached` resolves once the server
 * has it (or after a bound), `release` lets a held response through.
 */
export async function hold(hosts, page, spec, mode) {
  const matches = requestMatcher(spec);
  let release;
  let reached;
  const released = new Promise((done) => (release = done));
  const reachedServer = new Promise((done) => (reached = done));
  let held = false;
  await page.route('**/*', async (route) => {
    const req = route.request();
    if (held || !ours(hosts, req) || !matches(req)) return route.fallback();
    held = true;
    const response = await fetchUnseen(route, page.context());
    reached();
    return answer(route, response, mode, released);
  });
  const reach = Promise.race([reachedServer, sleep(REACH_LIMIT_MS)]);
  return { reached: reach, release: () => release() };
}

/** Every fetch / XHR to a target host on `page` waits `ms` first (i2, i3). */
export function slow(hosts, page, ms) {
  return page.route('**/*', async (route) => {
    const req = route.request();
    if (ours(hosts, req) && API_TYPES.has(req.resourceType())) await sleep(ms);
    return route.fallback();
  });
}

/** Abandon the flow: `back` or `reload`. Navigation errors are the abuse's. */
export function leave(page, how) {
  const go = how === 'reload' ? page.reload() : page.goBack();
  return go.catch(() => null);
}

/** Clear the target's session keys on `page`, as an expired token would. */
export async function expire(page, sessionKeys) {
  for (const key of sessionKeys) {
    // `cookie:session`, `localStorage:token`, `sessionStorage:token`.
    const colon = key.indexOf(':');
    const store = key.slice(0, colon);
    const name = key.slice(colon + 1);
    if (store === 'cookie') await page.context().clearCookies({ name });
    else {
      await page.evaluate(([st, k]) => window[st].removeItem(k), [store, name]);
    }
  }
}
