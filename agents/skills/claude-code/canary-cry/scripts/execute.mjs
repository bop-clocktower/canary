// canary-cry executor (#608 P3, P4): what a MATCHING `run --live <t> --confirm
// <sha>` -- or a trusted `run --resume <run-id> --confirm <sha>` -- does.
// cli.mjs reaches this module only through a lazy dynamic import after the
// sha matched, so validate, matrix and the whole pre-confirm gate stay in an
// import closure that cannot open a socket or start a process
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
//   4. codegen + the runtime copy
//   5. the rounds (rounds.mjs): one `playwright test` per scenario, so
//      checkpoint.json is rewritten after every one and --max-wall can stop
//      between them; a scenario that leaves no report is ABSTAINED:
//      playwright crashed (+ its last stderr), keeping what completed
//   6. results.json, findings.json, the verdict text, and the exit code

import { buildFindings, exitCode, renderFindings } from './findings.mjs';
import {
  preflight,
  resolvePlaywright,
  runPlaywright,
  specFilter,
} from './playwright.mjs';
import { runRounds, toResult } from './rounds.mjs';
import {
  RESULTS_ENV,
  mergeResults,
  readObservations,
  readScenario,
  resetScenario,
  writeCheckpoint,
  writeFindings,
  writeHarness,
  writeMatrix,
} from './rundir.mjs';

const PROG = 'canary-cry';
const TOOLS = { resolve: resolvePlaywright, preflight, run: runPlaywright };

/** The scenarios that ran, in manifest order: the run's denominator. */
function ranScenarios(manifest, out) {
  if (out === null) return null;
  const ran = new Set(out.checkpoint.results.map((r) => r.id));
  return manifest.scenarios.filter((s) => ran.has(s.id));
}

function finish(ctx, { reason, out = null }) {
  const scenarios = ranScenarios(ctx.manifest, out);
  if (scenarios !== null) mergeResults(ctx.dir, scenarios);
  const doc = buildFindings({
    run: ctx.run,
    manifest: { scenarios: scenarios ?? [] },
    observations:
      scenarios === null ? null : readObservations(ctx.dir, scenarios),
    abstainedReason: reason,
    stop: out && { reason: out.stop, line: out.line, rounds: out.rounds },
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

/** One scenario, as its own Playwright run; no report at all is a crash. */
async function runScenario(h, scenario) {
  const files = resetScenario(h.dir, scenario);
  const ran = await h.tools.run({
    cli: h.cli,
    config: h.config,
    cwd: process.cwd(),
    env: { ...h.env, [RESULTS_ENV]: files.results },
    spec: specFilter(files.spec),
  });
  const seen = readScenario(h.dir, scenario);
  if (!seen.results) return { crashed: ran };
  return { result: toResult(scenario, seen.observation) };
}

async function execute({ opts, plan, dir, env, pw, now, resume }) {
  const { manifest, matrix, sha } = plan;
  const tools = { ...TOOLS, ...pw };
  const run = runMeta(dir, manifest, sha);
  const ctx = { dir, manifest, strict: opts.strict, run };
  writeMatrix(dir, matrix);
  const cli = tools.resolve(dir);
  if (cli === null) {
    return finish(ctx, { reason: 'no @playwright/test in target' });
  }
  const reach = await tools.preflight(manifest.target.baseURL);
  if (!reach.ok) {
    return finish(ctx, { reason: `target unreachable (${reach.detail})` });
  }
  const config = writeHarness(dir, manifest, sha);
  const h = { tools, cli, config, dir, env };
  const out = await runRounds({
    manifest,
    run,
    resumed: resume ?? null,
    runOne: (scenario) => runScenario(h, scenario),
    save: (checkpoint) => writeCheckpoint(dir, checkpoint),
    clock: () => now().getTime(),
    maxWall: opts.maxWall ?? null,
  });
  if (out.stop !== 'crashed') return finish(ctx, { out });
  for (const line of out.crash.stderr) console.error(line);
  return finish(ctx, {
    reason: `playwright crashed (exit ${out.crash.code})`,
    out,
  });
}

/**
 * @param {{opts: object, plan: {manifest: object, matrix: object, sha: string},
 *   dir: string, env: Record<string, string | undefined>, now: () => Date,
 *   resume?: object, pw?: object}} input `resume` is a checkpoint
 *   planResume trusted; `pw` overrides resolve / preflight / run in tests
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
