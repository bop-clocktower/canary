// feed -- canary-site.config.json and the composed canary.site/1 document.
//
// The feed is validated before anyone sees it: composeFeed returns the
// validator's errors and the CLI refuses to write on any (#1151 phase 2).

import { validateDocument } from '../../../lib/contracts/validate.mjs';

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
