// canary-misfit -- the report (#592).
//
// Markdown for a human plus a JSON artifact for a consumer. Every report, in
// both shapes, carries the seed and the exact command that reproduces the run:
// a resilience finding nobody can reproduce is an anecdote, and the issue's
// design note asked for the opposite.

/** The line the family prints when the denominator collapsed (#508). */
export const ABSTAINED_LINE =
  'ABSTAINED: zero flows had a fault injected, so no resilience was measured.';

const HEADLINE = {
  shattered: 'shattered',
  degraded: 'degraded',
  graceful: 'graceful',
  unexercised: 'unexercised',
};

/** The command that replays this exact run. */
export function reproduceCommand({ profilePath, seed }) {
  return (
    `canary skills run canary-misfit -- --profile ${profilePath} --seed ${seed} ` +
    '--results test-results/results.json --ledger test-results/misfit-ledger.jsonl'
  );
}

export function buildArtifact({ profile, profilePath, assessment, producer }) {
  return {
    schema_version: 1,
    producer,
    profile: {
      name: profile.name,
      seed: profile.seed,
      budget_ms: profile.budget_ms,
    },
    reproduce: reproduceCommand({ profilePath, seed: profile.seed }),
    abstained: assessment.abstained,
    exercised: assessment.exercised,
    counts: assessment.counts,
    flows: assessment.flows.map((flow) => ({
      id: flow.id,
      title: flow.title,
      file: flow.file,
      verdict: flow.verdict,
      why: flow.why,
      injections: flow.injections,
      faults: flow.faults,
      duration_ms: Math.round(flow.duration_ms),
    })),
  };
}

export function renderMarkdown(artifact) {
  const lines = [
    '# canary-misfit — resilience verdicts (advisory, not a gate)',
    '',
    `Profile **${artifact.profile.name}**, seed \`${artifact.profile.seed}\`, ` +
      `producer \`${artifact.producer}\`.`,
    '',
  ];

  if (artifact.abstained) {
    // The summary table is not printed at all in this case: a table of
    // "unexercised" rows under a "0 shattered" heading is exactly the reassuring
    // shape an abstention must not wear.
    lines.push(
      ABSTAINED_LINE,
      '',
      'Check that the route fixture is wired into the suite and that the ' +
        "profile's `match` globs actually match the URLs the flows call.",
      '',
    );
  } else {
    lines.push(
      `${artifact.exercised} flow(s) exercised: ` +
        `${artifact.counts.shattered} ${HEADLINE.shattered}, ` +
        `${artifact.counts.degraded} ${HEADLINE.degraded}, ` +
        `${artifact.counts.graceful} ${HEADLINE.graceful} ` +
        `(${artifact.counts.unexercised} unexercised, excluded from the denominator).`,
      '',
      '| Flow | Verdict | Why | Faults |',
      '| --- | --- | --- | --- |',
      ...artifact.flows.map(
        (flow) =>
          `| ${flow.title} | ${flow.verdict} | ${flow.why} | ${flow.faults.join(', ') || '—'} |`,
      ),
      '',
    );
  }

  lines.push('Reproduce:', '', '```bash', artifact.reproduce, '```', '');
  return lines.join('\n');
}

/** GitHub Actions annotations: one per shattered flow, advisory wording. */
export function annotations(artifact) {
  if (artifact.abstained) return [`::warning::${ABSTAINED_LINE}`];
  return artifact.flows
    .filter((flow) => flow.verdict === 'shattered')
    .map(
      (flow) =>
        `::warning file=${flow.file ?? ''}::canary-misfit: "${flow.title}" shattered — ${flow.why}`,
    );
}
