// canary-cry runtime: one scenario's browser session (#608 P3). Copied into
// run dirs beside the other runtime modules.
//
// The session is the API the abuse patterns (abuse.mjs) are written against,
// so a pattern says WHAT it does to a flow and never how a step, a sign-in or
// a failure is handled (what it does to the network, the history and the
// session keys is tamper.mjs):
//
// - `pre` runs steps BEFORE the abuse point. A failure there means the flows
//   file no longer matches the app, so it throws FlowBroken and the verdict
//   is `abstain: flow-broken@<step>`, never a finding (SC14).
// - `post` runs steps after it. A failure there is something the abuse did
//   to the app, recorded as a `step-failed` UI signal, and the rest of the
//   flow is skipped.
// - Probes run in separate OBSERVER contexts signed in on their own, so a
//   pattern that clears the session (token-expiry) or signs a second user in
//   (shared-machine) never blinds its own before/after comparison.
//
// Account values live only in this process's memory. Every string the
// session records passes through `redact`, and a cross-account leak is
// recorded by field name (`account.A.email`), never by value (SC10, SC25).

import { StepFailure, lookupFor, resolve, runStep } from './steps.mjs';
import {
  leakedFields,
  lockdown,
  observe,
  pageText,
  settle,
  visibleSelectors,
} from './guard.mjs';
import { expire, hold, leave, slow } from './tamper.mjs';

/** A failure before the abuse point. */
class FlowBroken extends Error {
  constructor(at) {
    super(`flow broken at ${at}`);
    this.brokenAt = at;
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Each declared account's JSON object; an unset one resolves to nothing. */
function readAccounts(list, env) {
  const out = {};
  for (const { account, env: name } of list) {
    try {
      out[account] = JSON.parse(env[name] ?? 'null') ?? {};
    } catch {
      out[account] = {};
    }
  }
  return out;
}

/** Every account value long enough to be worth redacting, longest first. */
function secretsOf(accounts) {
  const values = Object.values(accounts).flatMap((a) => Object.values(a));
  return [...new Set(values.map(String))]
    .filter((v) => v.length >= 3)
    .sort((a, b) => b.length - a.length);
}

async function newContext(s) {
  const context = await s.browser.newContext({ baseURL: s.scenario.baseURL });
  s.contexts.push(context);
  await lockdown(context, { hosts: s.hosts, blocked: s.blocked });
  return context;
}

/**
 * Run steps[from, to); `phase` decides what a failure means, and `before`
 * (token-expiry i3) runs ahead of every step.
 */
async function runRange(s, page, steps, range) {
  const lookup = range.lookup ?? s.lookup();
  for (const step of steps.slice(range.from, range.to)) {
    try {
      if (range.before) await range.before();
      await runStep(page, step, lookup, {});
      if (s.account === 'B') await scanLeak(s, page);
    } catch (exc) {
      if (!(exc instanceof StepFailure)) throw exc;
      const at = range.label ? `${range.label}/${exc.stepId}` : exc.stepId;
      if (range.phase === 'pre') throw new FlowBroken(at);
      s.signal('step-failed', `step ${at} failed after the abuse point`);
      return false;
    }
  }
  return true;
}

/** Sign `account` in on `page` with the target's signIn flow (written for A). */
async function signIn(s, page, account, phase) {
  const auth = s.scenario.auth;
  if (auth === null || s.scenario.flow === auth.signIn.id) return true;
  const lookup = lookupFor(s.source, { A: account });
  const range = { from: 0, to: undefined, phase, lookup };
  return runRange(s, page, auth.signIn.steps, {
    ...range,
    label: auth.signIn.id,
  });
}

async function scanLeak(s, page) {
  const texts = await pageText(page).catch(() => []);
  const { A = {}, B = {} } = s.accounts;
  for (const field of leakedFields(texts, A, B)) {
    if (s.signals.some((x) => x.field === field)) continue;
    s.signals.push({ kind: 'cross-account-leak', field });
  }
}

/** Close the page's whole context, as closing the browser would (i3). */
async function close(s, page) {
  s.pages.splice(s.pages.indexOf(page), 1);
  await page.context().close();
}

/** Back after sign-out: what the next user at the machine sits down to. */
async function peek(s, page) {
  await page.goBack().catch(() => null);
  await scanLeak(s, page);
}

function methods(s) {
  const steps = s.scenario.steps;
  return {
    pre: (page, from, to) =>
      runRange(s, page, steps, { from, to, phase: 'pre' }),
    post: (page, from, { before } = {}) =>
      runRange(s, page, steps, { from, phase: 'post', before }),
    fire: (page, opts = {}) => fire(s, page, opts),
    hold: (page, mode) =>
      hold(s.hosts, page, steps[s.anchor].awaitResponse, mode),
    slow: (page, ms) => slow(s.hosts, page, ms),
    leave,
    close: (page) => close(s, page),
    peek: (page) => peek(s, page),
    expire: (page) => expire(page, s.scenario.auth.sessionKeys),
    tab: (page) => page.context().newPage(),
    pause: sleep,
    page: () => abusePage(s),
    signOut: (page) => signOut(s, page),
    switchTo: (account, page) => switchTo(s, account, page),
  };
}

/** The anchor step, `times` at once. A retry that cannot fire is quiet. */
async function fire(s, page, { times = 1, wait = true, quiet = false }) {
  const step = s.scenario.steps[s.anchor];
  try {
    await runStep(page, step, s.lookup(), { times, wait });
  } catch (exc) {
    if (!(exc instanceof StepFailure)) throw exc;
    if (!quiet) throw new FlowBroken(exc.stepId);
  }
}

async function abusePage(s) {
  const context = await newContext(s);
  observe(context, { hosts: s.hosts, signal: s.signal, inflight: s.inflight });
  const page = await context.newPage();
  s.pages.push(page);
  await signIn(s, page, 'A', 'pre');
  return page;
}

async function signOut(s, page) {
  const out = s.scenario.auth.signOut;
  const range = { from: 0, to: undefined, phase: 'pre', label: out.id };
  return runRange(s, page, out.steps, range);
}

async function switchTo(s, account, page) {
  s.account = account;
  const ok = await signIn(s, page, account, 'post');
  if (ok) await scanLeak(s, page);
  return ok;
}

/** Observer contexts for probes: A, plus B for shared-machine. */
async function observers(s) {
  const keys = s.scenario.pattern === 'shared-machine' ? ['A', 'B'] : ['A'];
  const out = [];
  for (const key of keys) {
    const context = await newContext(s);
    await signIn(s, await context.newPage(), key, 'pre');
    const lookup = lookupFor(s.source, { A: key });
    out.push({
      key,
      request: context.request,
      resolve: (t) => resolve(t, lookup),
    });
  }
  return out;
}

/**
 * @param {object} browser the Playwright Browser fixture
 * @param {object} scenario the inline scenario a generated spec carries
 * @param {Record<string, string | undefined>} env
 */
export function createSession(browser, scenario, env) {
  const accounts = readAccounts(scenario.accounts, env);
  const secrets = secretsOf(accounts);
  const redact = (text) =>
    secrets.reduce((t, v) => t.split(v).join('[redacted]'), String(text));
  const s = {
    browser,
    scenario,
    accounts,
    redact,
    source: {
      accounts,
      fixtures: scenario.fixtures,
      seed: scenario.seed,
      id: scenario.id,
    },
    hosts: [...scenario.hosts, new URL(scenario.baseURL).hostname],
    anchor: scenario.steps.findIndex((step) => step.id === scenario.step),
    account: 'A',
    contexts: [],
    pages: [],
    blocked: new Set(),
    signals: [],
    inflight: { n: 0 },
  };
  s.signal = (kind, detail) => s.signals.push({ kind, detail: redact(detail) });
  s.lookup = () => lookupFor(s.source, s.account === 'B' ? { A: 'B' } : {});
  s.act = methods(s);
  s.observers = () => observers(s);
  s.symptoms = async (page) => {
    for (const sel of await visibleSelectors(page, scenario.symptoms)) {
      s.signal('selector', sel);
    }
  };
  s.settle = async () => {
    for (const page of s.pages) await settle(s.inflight, page);
  };
  s.close = () => Promise.all(s.contexts.map((c) => c.close().catch(() => {})));
  return s;
}
