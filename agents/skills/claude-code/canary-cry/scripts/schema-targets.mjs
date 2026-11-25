// canary-cry targets.json schema (#608, spec "Inputs"). Shape only: the
// environment allowlist and the prodHosts refusal are the live gate's rules
// (#608 P2, exit 4 per ADR 0046), never a schema error (exit 2). Accounts are
// env-var NAMES; no value is read here.

import {
  ID_RE,
  at,
  declared,
  eachItem,
  needObject,
  needText,
  unknownKeys,
} from './schema-core.mjs';

const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const ACCOUNT_RE = /^[A-Za-z0-9_]+$/;
const SESSION_KEY_RE = /^(cookie|localStorage|sessionStorage):\S+$/;
const TARGET_KEYS = ['baseURL', 'environment', 'hosts', 'accounts', 'auth'];

function checkBaseUrl(value, path, errors) {
  let url = null;
  try {
    url = new URL(value);
  } catch {
    // Unparseable: reported below with the same message as a bad scheme.
  }
  if (url === null || !['http:', 'https:'].includes(url.protocol)) {
    errors.push(`${path}: must be an http(s) URL`);
  }
}

function checkAccounts(accounts, path, errors) {
  if (!needObject(accounts, path, errors)) return;
  for (const key of declared(accounts)) {
    const p = at(path, key);
    if (!ACCOUNT_RE.test(key))
      errors.push(`${p}: key must match ${ACCOUNT_RE}`);
    if (!needObject(accounts[key], p, errors)) continue;
    // Only `env` is legal: a `password` here would be a committed secret.
    unknownKeys(accounts[key], ['env'], p, errors);
    const { env } = accounts[key];
    if (typeof env !== 'string' || !ENV_RE.test(env)) {
      errors.push(`${at(p, 'env')}: must name an environment variable`);
    }
  }
}

function checkAuth(auth, path, errors, flowIds) {
  if (!needObject(auth, path, errors)) return;
  unknownKeys(auth, ['signIn', 'signOut', 'sessionKeys'], path, errors);
  for (const key of ['signIn', 'signOut']) {
    const p = at(path, key);
    const known = flowIds === null || flowIds.has(auth[key]);
    if (needText(auth[key], p, errors) && !known) {
      errors.push(`${p}: names no flow in flows.json ('${auth[key]}')`);
    }
  }
  const keys = at(path, 'sessionKeys');
  eachItem(auth.sessionKeys, keys, errors, true, (key, p) => {
    if (typeof key !== 'string' || !SESSION_KEY_RE.test(key)) {
      errors.push(
        `${p}: must be cookie:, localStorage: or sessionStorage:<key>`,
      );
    }
  });
}

function checkTarget(name, target, path, errors, flowIds) {
  if (!ID_RE.test(name)) errors.push(`${path}: name must match ${ID_RE}`);
  if (!needObject(target, path, errors)) return;
  unknownKeys(target, TARGET_KEYS, path, errors);
  checkBaseUrl(target.baseURL, at(path, 'baseURL'), errors);
  // Any non-empty string passes HERE: which environments may run is the live
  // gate's rule (exit 4), so a schema check must not pre-empt it as exit 2.
  needText(target.environment, at(path, 'environment'), errors);
  eachItem(target.hosts, at(path, 'hosts'), errors, true, (h, p) =>
    needText(h, p, errors),
  );
  if (target.accounts !== undefined) {
    checkAccounts(target.accounts, at(path, 'accounts'), errors);
  }
  if (target.auth !== undefined) {
    checkAuth(target.auth, at(path, 'auth'), errors, flowIds);
  }
}

/**
 * Every problem in a parsed targets.json. With `flowIds` (a Set of flow ids),
 * auth.signIn and auth.signOut must each name a declared flow.
 * @param {unknown} doc
 * @param {Set<string> | null} [flowIds]
 * @returns {string[]}
 */
export function validateTargets(doc, flowIds = null) {
  const errors = [];
  if (!needObject(doc, '$', errors)) return errors;
  unknownKeys(doc, ['version', 'prodHosts', 'targets'], '$', errors);
  if (doc.version !== 1) errors.push('$.version: must be 1');
  if (Array.isArray(doc.prodHosts)) {
    doc.prodHosts.forEach((h, i) => needText(h, at('$.prodHosts', i), errors));
  } else {
    errors.push('$.prodHosts: must be an array (it may be empty)');
  }
  if (!needObject(doc.targets, '$.targets', errors)) return errors;
  const names = declared(doc.targets);
  if (!names.length) errors.push('$.targets: must declare at least one target');
  for (const name of names) {
    checkTarget(
      name,
      doc.targets[name],
      at('$.targets', name),
      errors,
      flowIds,
    );
  }
  return errors;
}
