// canary-cry live gate -- PURE (#608 P2; ADR 0046 decisions 2 and 5). Which
// targets may ever be driven, and whether the credentials a run needs are
// present. Nothing here opens a socket: a refusal is decided before anything
// could reach the target.
//
// A refusal is exit 4 (ADR 0046). There is no override flag, on purpose: a
// skill that needs production is a new decision, not a flag on this one.
//
// The prodHosts rule errs toward refusing. A wrong refusal costs a config
// edit; a wrong pass costs real data. So `*.example.com` also covers the apex
// `example.com`, and a wildcard `hosts` entry is refused when it COULD reach
// a prod host, not only when it equals one.

export const ALLOWED_ENVIRONMENTS = Object.freeze([
  'local',
  'dev',
  'staging',
  'preview',
]);

const declaredNames = (obj) => Object.keys(obj).filter((k) => k !== '//');

/** Lowercase, without a port or a trailing dot: the host a request reaches. */
function hostOf(entry) {
  return String(entry)
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/** `{base, wild}`: `*.a.b` is everything at or under `a.b`. */
function pattern(entry) {
  const host = hostOf(entry);
  return host.startsWith('*.')
    ? { base: host.slice(2), wild: true }
    : { base: host, wild: false };
}

const atOrUnder = (host, base) => host === base || host.endsWith(`.${base}`);

/** Whether any single host could match both patterns. */
function overlaps(a, b) {
  const p = pattern(a);
  const q = pattern(b);
  if (p.wild && q.wild)
    return atOrUnder(p.base, q.base) || atOrUnder(q.base, p.base);
  if (q.wild) return atOrUnder(p.base, q.base);
  if (p.wild) return atOrUnder(q.base, p.base);
  return p.base === q.base;
}

const prodMatch = (host, prodHosts) =>
  prodHosts.find((prod) => overlaps(host, prod)) ?? null;

/** Every host the target would reach, labelled for the refusal message. */
function reachedHosts(spec) {
  const base = [
    { label: 'baseURL host', host: new URL(spec.baseURL).hostname },
  ];
  const hosts = spec.hosts.map((host, i) => ({ label: `hosts[${i}]`, host }));
  return [...base, ...hosts];
}

function refusalFor(name, spec, prodHosts) {
  if (!ALLOWED_ENVIRONMENTS.includes(spec.environment)) {
    return (
      `target '${name}' declares environment '${spec.environment}'; ` +
      `allowed: ${ALLOWED_ENVIRONMENTS.join(', ')}`
    );
  }
  for (const { label, host } of reachedHosts(spec)) {
    const prod = prodMatch(host, prodHosts);
    if (prod !== null) {
      return `target '${name}' ${label} '${host}' matches prodHosts '${prod}'`;
    }
  }
  return null;
}

/**
 * Gate a validated targets.json document for `run --live <name>`.
 * @returns {{refusal: string | null, target: {name: string, spec: object} | null}}
 */
export function gateTarget(targetsDoc, name) {
  const names = declaredNames(targetsDoc.targets);
  if (!names.includes(name)) {
    const refusal = `no target named '${name}' in targets.json (declared: ${names.join(', ')})`;
    return { refusal, target: null };
  }
  const spec = targetsDoc.targets[name];
  const refusal = refusalFor(name, spec, targetsDoc.prodHosts);
  return refusal === null
    ? { refusal: null, target: { name, spec } }
    : { refusal, target: null };
}

function holdsObject(raw) {
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * The whole live gate, in its load-bearing order: the target refusal first,
 * so a refused target is told no before any credential is read; then the
 * account env vars.
 * @returns {{refusal: string | null, errors: string[],
 *   target: {name: string, spec: object} | null}}
 */
export function gateLive(targetsDoc, name, env) {
  const gate = gateTarget(targetsDoc, name);
  if (gate.refusal !== null) return { ...gate, errors: [] };
  const errors = accountEnvErrors(gate.target.spec, env);
  return errors.length
    ? { refusal: null, errors, target: null }
    : { refusal: null, errors, target: gate.target };
}

/**
 * Problems with the target's account env vars, by NAME only. A value is
 * parsed to check its shape and then dropped: it never reaches a message,
 * and nothing here returns it.
 * @param {object} spec a target spec
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function accountEnvErrors(spec, env) {
  const accounts = spec.accounts ?? {};
  const errors = [];
  for (const key of declaredNames(accounts)) {
    const name = accounts[key].env;
    const raw = env[name];
    if (raw === undefined) {
      errors.push(`account ${key}: environment variable ${name} is not set`);
    } else if (!holdsObject(raw)) {
      errors.push(
        `account ${key}: environment variable ${name} does not hold a JSON object`,
      );
    }
  }
  return errors;
}
