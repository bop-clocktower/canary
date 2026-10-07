// feed -- canary-site.config.json, the inputs, and the composed canary.site/1
// document.
//
// The feed is validated before anyone sees it: composeFeed returns the
// validator's errors and the CLI refuses to write on any (#1151 phase 2).
// gatherInputs lives here, not in cli.mjs, so the CLI couples to one module;
// reading the files is inputs.mjs's job.

import { validateDocument } from '../../../lib/contracts/document.mjs';
import { readInputs, readJson } from './inputs.mjs';
import { flakyTests } from './flaky.mjs';
import {
  ciReadyAssessments,
  latestPerKey,
  registerAbstention,
  withAbstentions,
} from './assess.mjs';

const text = (v) => typeof v === 'string' && v.length > 0;

/** @throws on a config without a full scope -- scope is never inferred (D2). */
export function parseConfig(raw) {
  for (const f of ['id', 'env']) {
    if (!text(raw?.scope?.[f]))
      throw new Error(`canary-site.config.json: scope.${f} is required`);
  }
  const scope = { id: raw.scope.id, env: raw.scope.env };
  if (
    raw.suites !== undefined &&
    !(Array.isArray(raw.suites) && raw.suites.every(text))
  ) {
    throw new Error(
      'canary-site.config.json: suites must be a list of suite names',
    );
  }
  // D12: no declaration is null, which the panel reports as "none declared".
  const suites =
    raw.suites === undefined
      ? null
      : raw.suites.map((suite) => ({ scope, suite }));
  return { scope, suites };
}

function uniqueScopes(records) {
  const seen = new Map();
  for (const { scope } of records)
    seen.set(`${scope.id}\u0000${scope.env}`, {
      id: scope.id,
      env: scope.env,
    });
  return [...seen.values()];
}

export function composeFeed({
  config,
  runs,
  flaky,
  assessments,
  register,
  now,
}) {
  const doc = {
    contract: 'canary.site/1',
    generated_at: now,
    scopes: uniqueScopes([{ scope: config.scope }, ...runs, ...assessments]),
    suites: config.suites,
    runs,
    flaky,
    assessments,
    register,
  };
  return { doc, errors: validateDocument(doc, { layer: 'site' }).errors };
}

/**
 * Reads every input the CLI names and returns composeFeed's arguments (less
 * `now`). Each input it could not use is pushed onto `notes`.
 * @throws on an unreadable config, record, store or ci-ready report
 */
export function gatherInputs(args, notes, now) {
  const config = parseConfig(readJson(args.config, 'config'));
  const input = readInputs(args, config.scope, notes);
  const ci = ciReadyAssessments(input.report, config.scope, {
    now,
    source: args.ciReady ?? null,
  });
  if (ci.note) notes.push(ci.note);
  const unread = registerAbstention(config.scope, now, input.ledgerUnread);
  // Latest per key over REAL records only; abstentions fill what is left.
  const assessments = withAbstentions(
    latestPerKey([...input.assessments, ...ci.real]),
    unread ? [...ci.synthetic, unread] : ci.synthetic,
  );
  return {
    config,
    runs: input.feed,
    flaky: flakyTests(input.window),
    assessments,
    register: input.register,
  };
}
