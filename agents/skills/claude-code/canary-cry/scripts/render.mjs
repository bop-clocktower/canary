// canary-cry text output -- PURE, no imports (#608). Everything a human reads
// on stdout: the --help text, the matrix, the live-run manifest, and the
// abstention lines both commands share so an empty matrix reads the same on
// either path (#508 convention, SC24). Kept apart from cli.mjs so the wiring
// module stays small and this one stays import-free.

const PROG = 'canary-cry';

export const USAGE =
  'usage: canary-cry [-h] {validate,matrix,run} [--flows PATH] [--targets PATH]\n' +
  '                  [--target NAME] [--critical-areas PATH]\n' +
  '                  [--amplitude {whisper,shout,scream}] [--seed N]\n' +
  '                  [--live NAME] [--confirm SHA] [--json] [--strict]\n' +
  '\n' +
  'Pre-launch "try to break it" sweep of ordinary user flows. Nothing reaches\n' +
  'a target until run --confirm carries the sha of the manifest you read.\n' +
  '\n' +
  'commands:\n' +
  '  validate              check flows.json and targets.json\n' +
  '  matrix                rank flows x abuse patterns, cut to a budget\n' +
  '  run                   --live NAME: gate the target, print the manifest\n' +
  '                        and its manifest-sha (no target request);\n' +
  '                        with a matching --confirm, run the scenarios\n' +
  "                        on the target project's Playwright\n" +
  '\n' +
  'options:\n' +
  '  -h, --help            show this help message and exit\n' +
  '  --flows PATH          flows file (default: .canary/cry/flows.json)\n' +
  '  --targets PATH        targets file (default: .canary/cry/targets.json)\n' +
  '  --target NAME         matrix: also schedule the target-scoped patterns\n' +
  '  --critical-areas PATH matrix: rank with critical areas (default:\n' +
  '                        .canary/critical-areas.json, when present)\n' +
  '  --amplitude A         matrix budget: whisper (default), shout, scream\n' +
  '  --seed N              recorded for {{unique.*}} test data; never selects\n' +
  '                        scenarios (default: 0)\n' +
  '  --live NAME           run: the targets.json target to gate (exit 4 when\n' +
  '                        refused: unlisted, non-allowed environment, or a\n' +
  '                        prodHosts match; there is no override)\n' +
  '  --confirm SHA         run: the manifest-sha you read; exit 4 unless it\n' +
  "                        equals the freshly rebuilt manifest's sha\n" +
  '                        (a match executes it)\n' +
  '  --json                matrix: print the canonical matrix.json document\n' +
  '  --strict              matrix, run: exit 3 when abstained; run: exit 1\n' +
  '                        when a scenario is corrupted';

// #508 convention line, written as escapes so this source stays ASCII (the
// same wording as ts/src/core/gate-result.ts and the other skill CLIs).
export const ABSTAINED_LINE =
  '\u{26A0} Abstained \u{2014} verified zero items; this is not a pass.';

/** Why the matrix is empty: no flows at all, or no pattern fits a step. */
function abstainedLines(matrix, declaredFlows) {
  const why =
    declaredFlows === 0
      ? 'no flows are declared'
      : `no scheduled pattern (${matrix.patterns.join(', ')}) ` +
        'applies to any declared step';
  return [`ABSTAINED: zero scenarios -- ${why}.`, ABSTAINED_LINE];
}

/** One line per distinct reason, in first-seen (catalog) order. */
function unscheduledLines(unscheduled) {
  const byReason = new Map();
  for (const u of unscheduled) {
    byReason.set(u.reason, [...(byReason.get(u.reason) ?? []), u.pattern]);
  }
  return [...byReason].map(
    ([reason, names]) =>
      `target-scoped patterns not scheduled (${reason}): ${names.join(', ')}`,
  );
}

const scenarioLine = (s) => `  ${String(s.score).padStart(3)}  ${s.id}`;

export function renderMatrix(m, declaredFlows) {
  const where = m.target === null ? '' : `, target ${m.target}`;
  const lines = [
    `${PROG} matrix -- amplitude ${m.amplitude}, seed ${m.seed}, ` +
      `ranking: ${m.ranking}${where}`,
  ];
  if (m.status === 'abstained') {
    lines.push(...abstainedLines(m, declaredFlows));
  } else {
    const rounds = m.intensities.map((n) => `i${n}`).join(', ');
    lines.push(
      `${m.scenarios.length} scenario(s) over ${m.flows.length} flow(s); ` +
        `patterns: ${m.patterns.join(', ')}; intensity: ${rounds}`,
      ...m.scenarios.map(scenarioLine),
    );
  }
  lines.push(...unscheduledLines(m.unscheduled));
  return lines.join('\n');
}

/** `run --live` over an empty matrix: no manifest, so nothing to confirm. */
export function renderRunAbstained(m, targetName, declaredFlows) {
  return [
    `${PROG} run --live ${targetName} -- amplitude ${m.amplitude}, seed ${m.seed}`,
    ...abstainedLines(m, declaredFlows),
  ].join('\n');
}

const probeText = (probe) =>
  probe.shell
    ? `shell ${JSON.stringify(probe.shell.argv)}`
    : `http ${probe.http.method} ${probe.http.path}`;

const stepText = (w) => [w.action, w.selector ?? w.url].join(' ');

/** The manifest as an operator reads it before confirming (ADR 0046). */
export function renderManifest(m, sha, file) {
  const accounts = m.accounts.map((a) => `${a.account}=${a.env}`);
  return [
    `${PROG} run --live ${m.target.name} -- manifest (no request has been sent)`,
    `target: ${m.target.name} (${m.target.environment}) ${m.target.baseURL}`,
    `egress hosts: ${m.egressHosts.join(', ')}`,
    `accounts (env var names): ${accounts.join(', ') || 'none'}`,
    `amplitude ${m.amplitude}, seed ${m.seed}; scenario(s): ${m.scenarios.length}`,
    ...m.scenarios.map(scenarioLine),
    ...m.writes.map((w) => `write: ${w.flow}/${w.step} ${stepText(w)}`),
    ...m.probes.map(
      (p) =>
        `probe: ${p.flow}/${p.invariant} ${probeText(p.probe)} ` +
        `-> expect ${JSON.stringify(p.expect)}`,
    ),
    m.serverSideLimit,
    `manifest: ${file}`,
    `manifest-sha: ${sha}`,
    `To run exactly this, re-run with: --confirm ${sha}`,
  ].join('\n');
}
