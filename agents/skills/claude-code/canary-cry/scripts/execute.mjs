// canary-cry executor (#608 P3): what a MATCHING `run --live <t> --confirm
// <sha>` does. cli.mjs reaches this module only through a lazy dynamic import
// after the sha matched, so validate, matrix and the whole pre-confirm gate
// stay in an import closure that cannot open a socket or start a process
// (canary-cry-tier.test.ts, SC6).
//
// It works from the CONFIRMED manifest alone, never from the input files
// again: what runs is exactly what the operator read. Order, each step
// loud when it cannot go on (D3, spec "Failure modes"):
//
//   1. matrix.json is written -- the matrix is emitted even if the run abstains
//   2. `@playwright/test` must resolve in the target project, else
//      ABSTAINED: no @playwright/test in target (nothing reaches the target)
//   3. preflight GET baseURL, else ABSTAINED: target unreachable
//   4. codegen + the runtime copy, then the target's `playwright test`
//   5. no results.json -> ABSTAINED: playwright crashed (+ its last stderr)
//   6. findings.json, the verdict text, and the exit code

import { buildFindings, renderFindings } from './findings.mjs';
import { preflight, resolvePlaywright, runPlaywright } from './playwright.mjs';
import {
  readOutcome,
  writeFindings,
  writeHarness,
  writeMatrix,
} from './rundir.mjs';
import { exitCode } from './verdict.mjs';

const PROG = 'canary-cry';
const TOOLS = { resolve: resolvePlaywright, preflight, run: runPlaywright };

function finish(ctx, reason, observations) {
  const doc = buildFindings({
    run: ctx.run,
    manifest: ctx.manifest,
    observations,
    abstainedReason: reason,
  });
  const findings = writeFindings(ctx.dir, doc);
  console.log(renderFindings(doc, { dir: ctx.dir, findings }));
  return exitCode(doc, ctx.strict);
}

function runMeta(dir, manifest, sha) {
  return {
    id: dir.split(/[\\/]/).pop(),
    target: manifest.target.name,
    environment: manifest.target.environment,
    baseURL: manifest.target.baseURL,
    amplitude: manifest.amplitude,
    seed: manifest.seed,
    manifestSha: sha,
  };
}

/** Rounds above i1 arrive with convergence (#608 P4): refuse, never shrink. */
function unsupported(manifest) {
  const s = manifest.scenarios.find((x) => x.intensity !== 1);
  if (s === undefined) return null;
  return (
    `${PROG}: error: scenario ${s.id} is at intensity ${s.intensity}; ` +
    'live rounds above i1 are not yet supported (a later phase of #608)'
  );
}

async function execute({ opts, plan, dir, env, pw }) {
  const { manifest, matrix, sha } = plan;
  const refusal = unsupported(manifest);
  if (refusal !== null) {
    console.error(refusal);
    return 2;
  }
  const tools = { ...TOOLS, ...pw };
  const ctx = {
    dir,
    manifest,
    strict: opts.strict,
    run: runMeta(dir, manifest, sha),
  };
  writeMatrix(dir, matrix);
  const cli = tools.resolve(dir);
  if (cli === null) return finish(ctx, 'no @playwright/test in target', null);
  const reach = await tools.preflight(manifest.target.baseURL);
  if (!reach.ok)
    return finish(ctx, `target unreachable (${reach.detail})`, null);
  const config = writeHarness(dir, manifest, sha);
  const ran = await tools.run({ cli, config, cwd: process.cwd(), env });
  const outcome = readOutcome(dir, manifest.scenarios);
  if (!outcome.results) {
    for (const line of ran.stderr) console.error(line);
    return finish(ctx, `playwright crashed (exit ${ran.code})`, null);
  }
  return finish(ctx, undefined, outcome.observations);
}

/**
 * @param {{opts: object, plan: {manifest: object, matrix: object, sha: string},
 *   dir: string, env: Record<string, string | undefined>,
 *   pw?: object}} input `pw` overrides resolve / preflight / run in tests
 * @returns {Promise<number>} the exit code
 */
export async function executeRun(input) {
  try {
    return await execute(input);
  } catch (exc) {
    console.error(`${PROG}: ${exc.message}`);
    return 1;
  }
}
