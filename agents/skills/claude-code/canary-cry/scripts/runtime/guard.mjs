// canary-cry runtime: the egress lockdown and the UI signals of one browser
// context (#608 P3; ADR 0046 decision 3). NO IMPORTS: copied into run dirs.
//
// Every request from a page goes through the lockdown. A host outside the
// target's `hosts` (plus its baseURL host) is aborted before it leaves the
// browser and recorded, so findings.json names it (SC13). The UI signals are
// what a `symptom` is made of: an uncaught page error, a console error, a
// response >= 500 from a target host, and a declared symptom selector left
// visible. Chromium's own "Failed to load resource" console line is skipped:
// it only echoes a network event, and the 5xx and the blocked request are
// already recorded first-hand.

const SETTLE_MS = 10_000;
const NETWORK_ECHO = 'Failed to load resource';

const hostOf = (entry) =>
  String(entry).trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

/** The same host rule as the gate: exact, or `*.d` at or under `d`. */
export function hostAllowed(hostname, hosts) {
  const host = hostOf(hostname);
  return hosts.some((entry) => {
    const pattern = hostOf(entry);
    if (!pattern.startsWith('*.')) return host === pattern;
    const base = pattern.slice(2);
    return host === base || host.endsWith(`.${base}`);
  });
}

const isWeb = (url) => url.protocol === 'http:' || url.protocol === 'https:';

/**
 * Abort and record every request to a host the target does not declare.
 * @param {object} context a Playwright BrowserContext
 * @param {{hosts: string[], blocked: Set<string>}} guard
 */
export async function lockdown(context, guard) {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!isWeb(url) || hostAllowed(url.hostname, guard.hosts)) {
      return route.fallback();
    }
    guard.blocked.add(url.hostname);
    return route.abort('blockedbyclient');
  });
}

/**
 * Collect UI signals and in-flight requests across every page of a context.
 * @param {object} context
 * @param {{hosts: string[], signal: (kind: string, detail: string) => void,
 *   inflight: {n: number}}} watch
 */
export function observe(context, watch) {
  context.on('request', () => {
    watch.inflight.n += 1;
  });
  const done = () => {
    watch.inflight.n = Math.max(0, watch.inflight.n - 1);
  };
  context.on('requestfinished', done);
  context.on('requestfailed', done);
  context.on('weberror', (e) => watch.signal('pageerror', e.error().message));
  context.on('console', (msg) => {
    if (msg.type() !== 'error' || msg.text().startsWith(NETWORK_ECHO)) return;
    watch.signal('console-error', msg.text());
  });
  context.on('response', (res) => {
    const url = new URL(res.url());
    if (res.status() < 500 || !hostAllowed(url.hostname, watch.hosts)) return;
    const method = res.request().method();
    watch.signal('http-5xx', `${method} ${url.pathname} ${res.status()}`);
  });
}

/** Wait until no request is in flight, so after-probes see every write. */
export async function settle(inflight, page, limitMs = SETTLE_MS) {
  const deadline = Date.now() + limitMs;
  while (inflight.n > 0 && Date.now() < deadline) {
    await page.waitForTimeout(50);
  }
}

/** The declared symptom selectors still visible on a page. */
export async function visibleSelectors(page, selectors) {
  const shown = [];
  for (const selector of selectors) {
    const visible = await page
      .locator(selector)
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) shown.push(selector);
  }
  return shown;
}

/** What a signed-in user can see: the text, and every form field's value. */
export const pageText = (page) =>
  page.evaluate(() => {
    const fields = [...document.querySelectorAll('input, textarea, select')];
    return [document.body?.innerText ?? '', ...fields.map((f) => f.value)];
  });

/**
 * The fields of account A whose value shows on B's page, by NAME only. A
 * value shorter than 3 characters, or one B shares, would match by accident
 * and is not compared.
 */
export function leakedFields(texts, accountA, accountB) {
  const haystack = texts.join('\n');
  return Object.entries(accountA)
    .filter(([field, value]) => {
      const text = String(value);
      if (text.length < 3 || String(accountB[field]) === text) return false;
      return haystack.includes(text);
    })
    .map(([field]) => `account.A.${field}`);
}
