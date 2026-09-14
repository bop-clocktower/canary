// blast -- render the one-page broken-main blast. Pure.
//
// Three outputs from one assessment, because the same fact has three audiences:
//   markdown     the standalone artifact a human opens
//   annotations  a single `::error` line so the GitHub Checks UI shows it
//   chatBlock    plain text the on-call pastes into whatever chat they use
//
// The chat block is emitted, never posted. The skill has no credentials, no
// webhook, and no write access to anything but the artifact path it was given.

const CROSS = '\u274c'; // cross mark
const CHECK = '\u2705'; // white heavy check mark
const DASH = '\u2014'; // em dash

/** The first meaningful line of an error blob, clipped. */
function firstLine(error, limit = 160) {
  if (!error) return '(no error message)';
  for (const raw of String(error).split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line) return line.slice(0, limit);
  }
  return '(no error message)';
}

const NEXT_STEP = {
  revert: 'Revert the culprit commit. One area, one attributable commit.',
  quarantine:
    'Quarantine the failing tests and open a tracking issue. The break is not cleanly attributable to one commit.',
  investigate:
    'Investigate before acting. The failing tests carry no owning area, so neither a revert nor a quarantine can be aimed.',
};

/**
 * Render the blast.
 *
 * @param {{branch: string, assessment: object, cluster: object|null}} input
 * @returns {{markdown: string, annotations: string[], chatBlock: string}}
 */
export function renderBlast({ branch, assessment, cluster }) {
  if (assessment.state === 'abstained') {
    const text =
      `${CROSS} canary-screech ABSTAINED ${DASH} the run-history store holds no run for \`${branch}\`.\n\n` +
      'Zero observations is not a healthy branch. Point `--history` at a store ' +
      'that this branch actually writes to, or wire the suite to record runs.';
    return {
      markdown: `# canary-screech ${DASH} ${branch}\n\n${text}\n`,
      annotations: [],
      chatBlock: text,
    };
  }

  if (assessment.state === 'green') {
    const text = `${CHECK} \`${branch}\` is green as of ${assessment.latest.commit_sha ?? '(unknown commit)'}.`;
    return {
      markdown: `# canary-screech ${DASH} ${branch}\n\n${text}\n`,
      annotations: [],
      chatBlock: text,
    };
  }

  const { culpritRange, firstRed } = assessment;
  const from =
    culpritRange.from ?? '(unknown - no green run recorded before the break)';
  const to = culpritRange.to ?? '(unknown)';
  const failureCount = cluster.clusters.reduce((n, c) => n + c.tests.length, 0);

  const chatLines = [
    `${CROSS} ${branch} is RED ${DASH} ${failureCount} failing test${failureCount === 1 ? '' : 's'}`,
    `culprit range: ${from}..${to}`,
    `owning area:   ${cluster.owningArea ?? '(none recorded)'}`,
    `recommendation: ${cluster.recommendation.toUpperCase()} ${DASH} ${NEXT_STEP[cluster.recommendation]}`,
    `first red run: ${firstRed.run_id} (${firstRed.suite}) at ${firstRed.timestamp}`,
  ];
  const chatBlock = chatLines.join('\n');

  const lines = [
    `# ${CROSS} canary-screech ${DASH} \`${branch}\` is red`,
    '',
    `**First red run:** \`${firstRed.run_id}\` (${firstRed.suite}) at ${firstRed.timestamp}`,
    '',
    '## Culprit commit range',
    '',
    `\`${from}\` .. \`${to}\``,
    '',
  ];
  if (!culpritRange.bounded) {
    lines.push(
      '> The lower bound is unknown: the store holds no green run for this ' +
        'branch before the break, so the range below is open-ended.',
      '',
    );
  }
  lines.push('## Failure cluster', '');
  for (const c of cluster.clusters) {
    lines.push(`### ${c.category} (${c.tests.length})`, '');
    for (const t of c.tests) {
      lines.push(`- \`${t.test_name}\` ${DASH} ${firstLine(t.error_text)}`);
    }
    lines.push('');
  }
  lines.push(
    '## Owning area',
    '',
    cluster.areas.length
      ? cluster.areas.map((a) => `- \`${a.area}\` (${a.count})`).join('\n')
      : '_No failing test carries an `area`, so ownership could not be derived._',
    '',
    '## Recommendation',
    '',
    `**${cluster.recommendation.toUpperCase()}** ${DASH} ${NEXT_STEP[cluster.recommendation]}`,
    '',
    '## Chat-ready block',
    '',
    '```text',
    chatBlock,
    '```',
    '',
  );

  const annotations = [
    `::error title=Broken branch::${branch} is red ${DASH} ${failureCount} failing test${failureCount === 1 ? '' : 's'} in ${cluster.owningArea ?? 'an unrecorded area'}; culprit ${from}..${to}; recommendation: ${cluster.recommendation}`,
  ];

  return { markdown: lines.join('\n'), annotations, chatBlock };
}
