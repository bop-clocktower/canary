// canary-cry input schemas (#608, spec "Inputs"): .canary/cry/flows.json and
// .canary/cry/targets.json. Every error is `<json path>: <problem>`, so a bad
// file fails at the desk (exit 2) and says where, instead of half-running a
// sweep. Hand-rolled on purpose: a skill imports nothing installed.
//
// Unknown keys are errors: `"write": true` typed for `"writes": true` would
// otherwise drop a step out of every write-keyed pattern without a word. A
// `"//"` key is the family's comment convention (canary-shadow's example) and
// is allowed in any object.
//
// No secret is read here. Accounts are env-var NAMES. Reading their values,
// the environment allowlist and the prodHosts refusal belong to the live gate
// (#608 P2, exit 4 per ADR 0046), never to schema validation (exit 2).

import {
  at,
  eachItem,
  isText,
  needId,
  needObject,
  needText,
  readJsonFile,
  unknownKeys,
} from './schema-core.mjs';
import { validateTargets } from './schema-targets.mjs';

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const AWAIT_RE = new RegExp(`^(${HTTP_METHODS.join('|')}) /\\S*$`);
const TEMPLATE_RE = /\{\{([^}]*)\}\}/g;
const TEMPLATE_KINDS = [
  /^account\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/,
  /^fixture\.[A-Za-z0-9_-]+$/,
  /^unique\.[a-z][a-z0-9-]*$/,
];

/** The fields each step action needs. */
const ACTION_FIELDS = Object.freeze({
  goto: ['url'],
  fill: ['selector', 'value'],
  click: ['selector'],
  select: ['selector', 'value'],
  press: ['key'],
  waitFor: ['selector'],
});
const STEP_KEYS = [
  'id',
  'action',
  'url',
  'selector',
  'value',
  'key',
  'writes',
  'awaitResponse',
];
const FLOW_KEYS = [
  'id',
  'risk',
  'criticalArea',
  'steps',
  'invariants',
  'symptoms',
];

/** Why a `{{...}}` reference is unusable, or null when it is fine. */
function templateError(ref, fixtures) {
  if (!TEMPLATE_KINDS.some((re) => re.test(ref))) {
    return `unknown template {{${ref}}}`;
  }
  if (!ref.startsWith('fixture.')) return null;
  const name = ref.slice('fixture.'.length);
  if (Object.hasOwn(fixtures, name)) return null;
  return `fixture '${name}' is not in $.fixtures`;
}

function checkTemplates(value, path, ctx) {
  if (typeof value !== 'string') return;
  for (const [, ref] of value.matchAll(TEMPLATE_RE)) {
    const problem = templateError(ref, ctx.fixtures);
    if (problem !== null) ctx.errors.push(`${path}: ${problem}`);
  }
}

function checkAction(step, path, ctx) {
  if (!Object.hasOwn(ACTION_FIELDS, step.action)) {
    const choices = Object.keys(ACTION_FIELDS).join(', ');
    ctx.errors.push(`${at(path, 'action')}: must be one of ${choices}`);
    return;
  }
  for (const field of ACTION_FIELDS[step.action]) {
    // `value` may be '' (filling a field empty is a real step).
    if (field === 'value' && typeof step.value === 'string') continue;
    needText(step[field], at(path, field), ctx.errors);
  }
}

function checkStepFlags(step, path, errors) {
  if (step.writes !== undefined && typeof step.writes !== 'boolean') {
    errors.push(`${at(path, 'writes')}: must be true or false`);
  }
  const wait = step.awaitResponse;
  if (
    wait !== undefined &&
    !(typeof wait === 'string' && AWAIT_RE.test(wait))
  ) {
    errors.push(
      `${at(path, 'awaitResponse')}: must be '<METHOD> /path', ` +
        `e.g. 'POST /api/orders'`,
    );
  }
}

function checkStep(step, path, ctx) {
  if (!needObject(step, path, ctx.errors)) return;
  unknownKeys(step, STEP_KEYS, path, ctx.errors);
  needId(step.id, at(path, 'id'), ctx.stepIds, ctx.errors);
  checkAction(step, path, ctx);
  checkStepFlags(step, path, ctx.errors);
  for (const field of ['url', 'selector', 'value', 'key']) {
    checkTemplates(step[field], at(path, field), ctx);
  }
}

function checkHttpProbe(http, path, ctx) {
  if (!needObject(http, path, ctx.errors)) return;
  unknownKeys(http, ['method', 'path'], path, ctx.errors);
  if (!HTTP_METHODS.includes(http.method)) {
    const choices = HTTP_METHODS.join(', ');
    ctx.errors.push(`${at(path, 'method')}: must be one of ${choices}`);
  }
  if (typeof http.path !== 'string' || !http.path.startsWith('/')) {
    ctx.errors.push(`${at(path, 'path')}: must start with '/'`);
  }
  checkTemplates(http.path, at(path, 'path'), ctx);
}

function checkShellProbe(shell, path, ctx) {
  if (!needObject(shell, path, ctx.errors)) return;
  unknownKeys(shell, ['argv'], path, ctx.errors);
  const argvPath = at(path, 'argv');
  const { argv } = shell;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(isText)) {
    ctx.errors.push(
      `${argvPath}: must be a non-empty array of strings ` +
        '(run with execFile, never as a shell string)',
    );
    return;
  }
  argv.forEach((arg, i) => checkTemplates(arg, at(argvPath, i), ctx));
}

function checkProbe(probe, path, ctx) {
  if (!needObject(probe, path, ctx.errors)) return;
  unknownKeys(probe, ['http', 'shell'], path, ctx.errors);
  const kinds = ['http', 'shell'].filter((k) => probe[k] !== undefined);
  if (kinds.length !== 1) {
    ctx.errors.push(`${path}: must declare exactly one of http, shell`);
  } else if (kinds[0] === 'http') {
    checkHttpProbe(probe.http, at(path, 'http'), ctx);
  } else {
    checkShellProbe(probe.shell, at(path, 'shell'), ctx);
  }
}

function checkExpect(expect, path, errors) {
  if (!needObject(expect, path, errors)) return;
  unknownKeys(expect, ['jsonPath', 'delta', 'equals'], path, errors);
  const jp = expect.jsonPath;
  if (jp !== undefined && !(typeof jp === 'string' && jp.startsWith('$'))) {
    errors.push(`${at(path, 'jsonPath')}: must be a string starting with '$'`);
  }
  const has = ['delta', 'equals'].filter((k) => Object.hasOwn(expect, k));
  if (has.length !== 1) {
    errors.push(`${path}: must declare exactly one of delta, equals`);
  } else if (has[0] === 'delta' && !Number.isFinite(expect.delta)) {
    errors.push(`${at(path, 'delta')}: must be a number`);
  }
}

function checkInvariant(inv, path, ctx) {
  if (!needObject(inv, path, ctx.errors)) return;
  unknownKeys(inv, ['id', 'probe', 'expect'], path, ctx.errors);
  needId(inv.id, at(path, 'id'), ctx.invariantIds, ctx.errors);
  checkProbe(inv.probe, at(path, 'probe'), ctx);
  checkExpect(inv.expect, at(path, 'expect'), ctx.errors);
}

function checkSymptoms(symptoms, path, errors) {
  if (!needObject(symptoms, path, errors)) return;
  unknownKeys(symptoms, ['selectors'], path, errors);
  const selectors = at(path, 'selectors');
  eachItem(symptoms.selectors, selectors, errors, true, (s, p) =>
    needText(s, p, errors),
  );
}

function checkFlow(flow, path, ctx) {
  const { errors } = ctx;
  if (!needObject(flow, path, errors)) return;
  unknownKeys(flow, FLOW_KEYS, path, errors);
  needId(flow.id, at(path, 'id'), ctx.flowIds, errors);
  if (!Number.isInteger(flow.risk) || flow.risk < 1 || flow.risk > 5) {
    errors.push(`${at(path, 'risk')}: must be an integer 1-5`);
  }
  if (flow.criticalArea !== undefined) {
    needText(flow.criticalArea, at(path, 'criticalArea'), errors);
  }
  const inner = { ...ctx, stepIds: new Set(), invariantIds: new Set() };
  eachItem(flow.steps, at(path, 'steps'), errors, true, (s, p) =>
    checkStep(s, p, inner),
  );
  eachItem(flow.invariants, at(path, 'invariants'), errors, false, (v, p) =>
    checkInvariant(v, p, inner),
  );
  if (flow.symptoms !== undefined) {
    checkSymptoms(flow.symptoms, at(path, 'symptoms'), errors);
  }
}

function checkFixtures(fixtures, errors) {
  if (fixtures === undefined) return {};
  if (!needObject(fixtures, '$.fixtures', errors)) return {};
  for (const [name, value] of Object.entries(fixtures)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      errors.push(
        `${at('$.fixtures', name)}: must be a string, number or boolean`,
      );
    }
  }
  return fixtures;
}

/** Every problem in a parsed flows.json, each `"<json path>: <problem>"`. */
export function validateFlows(doc) {
  const errors = [];
  if (!needObject(doc, '$', errors)) return errors;
  unknownKeys(doc, ['version', 'fixtures', 'flows'], '$', errors);
  if (doc.version !== 1) errors.push('$.version: must be 1');
  const fixtures = checkFixtures(doc.fixtures, errors);
  const ctx = { errors, fixtures, flowIds: new Set() };
  if (Array.isArray(doc.flows)) {
    doc.flows.forEach((flow, i) => checkFlow(flow, at('$.flows', i), ctx));
  } else {
    errors.push('$.flows: must be an array');
  }
  return errors;
}

function load(file, label, validate) {
  const read = readJsonFile(file, label);
  if (read.error !== undefined) return { doc: null, errors: [read.error] };
  const errors = validate(read.doc).map((e) => `${file}: ${e}`);
  return { doc: errors.length ? null : read.doc, errors };
}

/** flows.json, validated. `doc` is non-null exactly when `errors` is empty. */
export const loadFlows = (file) => load(file, 'flows', validateFlows);

/**
 * targets.json, validated; `flowIds` cross-checks the auth flow names.
 * @param {string} file
 * @param {Set<string> | null} [flowIds]
 */
export const loadTargets = (file, flowIds = null) =>
  load(file, 'targets', (doc) => validateTargets(doc, flowIds));
