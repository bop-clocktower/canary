#!/usr/bin/env node
// Turns a cron that stopped firing into a red job instead of silence.
//
// Two weekly Monday crons, `harness-architecture.yml` ('0 6 * * 1') and
// `arch-snapshot.yml` ('0 7 * * 1'), last fired on 2026-09-07 and then missed
// four Mondays in a row. GitHub kept reporting both workflows as `active`, and
// nothing anywhere went red. A schedule that never fires produces no failed
// run, so the only symptom is an absence, and an absence makes no sound. This is
// #508's zero-denominator green in its purest form, the same lesson #758 learnt
// about the deep siren: registration is not execution.
//
// For each named workflow file this asks the GitHub API two questions:
//   1. Is the workflow `active`? A disabled one never fires its schedule.
//   2. When did its most recent `schedule`-event run start? Only schedule runs
//      count, so a push or PR run of the same workflow cannot mask a dead cron.
//
// Exit codes follow the repo's gate convention (#508, ADR 0009):
//   0 = every watched schedule fired within --max-age-days
//   1 = at least one is stale or disabled (a finding, and outranks 3)
//   2 = usage error
//   3 = ABSTAINED: no schedule run on record, the API was unreachable or
//       refused, a payload was unreadable, or zero workflows were checked.
//       None of these is evidence the schedule is alive, so none is a pass.
//
//   node scripts/schedule-staleness.mjs --repo OWNER/NAME --max-age-days 8 \
//     harness-architecture.yml arch-snapshot.yml
//
// Needs `gh` on PATH with a token that can read Actions (in CI,
// `GITHUB_TOKEN` with `actions: read`). The watchdog that runs this must not
// itself depend on the cron scheduler; see `.github/workflows/schedule-watchdog.yml`.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { isMain } from './lib/is-main.mjs';

const DAY_MS = 86_400_000;

const USAGE =
  'usage: schedule-staleness.mjs [--repo OWNER/NAME] --max-age-days N [--json] <workflow-file>...\n' +
  '  --repo defaults to $GITHUB_REPOSITORY';

/**
 * The first fix step every abstention ends with. The new-gate checklist asks
 * for the cause AND the first thing to do; a bare "abstained" is half a bug
 * report.
 */
const FIX_STEP =
  'Fix: confirm the token can read Actions (`actions: read`) and the file name is right. ' +
  'A workflow with no schedule run on record has never fired: edit its file on the default branch ' +
  'to re-register the schedule, then confirm a run appears.';

/**
 * Thrown when `gh` answered but the body is not JSON (an HTML error page, a
 * truncated response). The API was reachable, so the abstention must not say
 * it was not; that would send the reader to check the token instead.
 */
export class UnreadablePayloadError extends Error {}

/**
 * Calls `gh api <path>` and parses the JSON. Throws on any failure, including
 * a missing binary and a non-JSON body. The caller turns the throw into an
 * abstention.
 *
 * @param {string} path API path without a leading slash
 * @param {string} [bin] the gh binary; overridable so the spawn-failure path is testable
 * @returns {unknown}
 */
export function ghApi(path, bin = 'gh') {
  let out;
  try {
    out = execFileSync(bin, ['api', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr ?? '').trim() || error.message;
    throw new Error(`GitHub API call failed for ${path}: ${detail}`);
  }
  try {
    return JSON.parse(out);
  } catch (error) {
    throw new UnreadablePayloadError(
      `unreadable payload for ${path}: ${error.message}`,
    );
  }
}

/**
 * The verdict for one workflow, from data already fetched. Pure.
 *
 * @param {{workflow: string, state: unknown, runs: unknown, now: Date, maxAgeDays: number}} args
 * @returns {{workflow: string, verdict: 'fresh'|'stale'|'abstain', reason: string, lastRunAt?: string, lastRunUrl?: string}}
 */
export function assessSchedule({ workflow, state, runs, now, maxAgeDays }) {
  // Only an explicit state string is evidence about the workflow. `{}`, `null`
  // or `{"message": "Moved"}` says nothing about whether it is disabled, so
  // calling it stale would invent a finding.
  if (typeof state !== 'string') {
    return {
      workflow,
      verdict: 'abstain',
      reason: `unreadable workflow payload: no string state (got ${JSON.stringify(state) ?? 'nothing'})`,
    };
  }
  if (state !== 'active') {
    return {
      workflow,
      verdict: 'stale',
      reason: `workflow state is ${JSON.stringify(state)}, not "active"; GitHub does not fire the schedule of a disabled workflow`,
    };
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    return {
      workflow,
      verdict: 'abstain',
      reason:
        'no schedule-event run on record, so there is no way to tell late from never registered',
    };
  }
  const last = runs[0];
  const startedMs = Date.parse(last?.created_at);
  if (Number.isNaN(startedMs)) {
    return {
      workflow,
      verdict: 'abstain',
      reason: `last schedule run has an unreadable timestamp (${JSON.stringify(last?.created_at)})`,
    };
  }
  const ageDays = (now.getTime() - startedMs) / DAY_MS;
  const fields = { lastRunAt: last.created_at, lastRunUrl: last.html_url };
  const when = `last schedule run ${last.created_at} (${ageDays.toFixed(1)} days ago, max ${maxAgeDays})`;
  return ageDays > maxAgeDays
    ? { workflow, verdict: 'stale', reason: when, ...fields }
    : { workflow, verdict: 'fresh', reason: when, ...fields };
}

/**
 * Fetches and assesses every workflow. An API failure for one workflow
 * abstains for that workflow only, so the others are still reported.
 *
 * @param {{repo: string, workflows: string[], maxAgeDays: number, now: Date, api?: (path: string) => any}} args
 */
export function checkSchedules({
  repo,
  workflows,
  maxAgeDays,
  now,
  api = ghApi,
}) {
  return workflows.map((workflow) => {
    const base = `repos/${repo}/actions/workflows/${workflow}`;
    let state;
    let runs;
    try {
      state = api(base)?.state;
      runs = api(`${base}/runs?event=schedule&per_page=1`)?.workflow_runs;
    } catch (error) {
      return {
        workflow,
        verdict: 'abstain',
        reason:
          error instanceof UnreadablePayloadError
            ? error.message
            : `GitHub API unreachable or refused: ${error.message}`,
      };
    }
    return assessSchedule({ workflow, state, runs, now, maxAgeDays });
  });
}

/**
 * A stale schedule (1) is a finding and outranks an abstention (3). Zero
 * workflows checked is a collapsed denominator, so it abstains rather than
 * passing vacuously.
 *
 * @param {{verdict: string}[]} results
 */
export function exitCode(results) {
  if (results.some((r) => r.verdict === 'stale')) return 1;
  if (results.length === 0 || results.some((r) => r.verdict === 'abstain')) {
    return 3;
  }
  return 0;
}

const LABEL = { fresh: 'FRESH', stale: 'STALE', abstain: 'ABSTAINED' };

/**
 * Human-readable report, denominator first.
 *
 * @param {{workflow: string, verdict: 'fresh'|'stale'|'abstain', reason: string, lastRunUrl?: string}[]} results
 * @param {number} maxAgeDays
 */
export function render(results, maxAgeDays) {
  const count = (v) => results.filter((r) => r.verdict === v).length;
  const lines = [
    `schedule-staleness: checked ${results.length} workflow(s) against a ${maxAgeDays}-day window: ` +
      `${count('fresh')} fresh, ${count('stale')} stale, ${count('abstain')} abstained`,
  ];
  if (results.length === 0) {
    lines.push('ABSTAINED: no workflow was checked, which is not a pass.');
  }
  for (const r of results) {
    const url = r.lastRunUrl ? ` ${r.lastRunUrl}` : '';
    lines.push(
      `${LABEL[r.verdict].padEnd(9)} ${r.workflow}: ${r.reason}${url}`,
    );
  }
  if (exitCode(results) === 3) lines.push(FIX_STEP);
  return lines.join('\n');
}

function usageError(message) {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        repo: { type: 'string' },
        'max-age-days': { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    usageError(error.message);
  }
  const { values, positionals } = parsed;
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    usageError('a repo (OWNER/NAME) is required');
  }
  if (positionals.length === 0) usageError('name at least one workflow file');
  const maxAgeDays = Number(values['max-age-days']);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    usageError('--max-age-days must be a positive number');
  }

  const results = checkSchedules({
    repo,
    workflows: positionals,
    maxAgeDays,
    now: new Date(),
  });
  const code = exitCode(results);
  process.stdout.write(
    values.json
      ? `${JSON.stringify({ checked: results.length, abstained: code === 3, results }, null, 2)}\n`
      : `${render(results, maxAgeDays)}\n`,
  );
  process.exit(code);
}

if (isMain(import.meta.url)) main();
