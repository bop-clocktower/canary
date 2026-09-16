/**
 * Turn assembled facts into the command's output (#593): fold in skill
 * judgment, pick Markdown or JSON, and deliver to stdout or a PR comment.
 *
 * Kept apart from `briefing-cli.ts`, which owns diff scoping and abstention,
 * so neither module crosses the perf size and import-count thresholds. Every
 * path here ends in exit 0: bad judgment and a failed comment both degrade to
 * printing the charter, because a charter is advisory and never a gate.
 *
 * It takes a narrow {@link CharterSink} rather than all of `MainDeps`: this
 * module needs four seams, and depending on only those keeps it decoupled.
 */
import { readFileSync } from 'node:fs';

import { jsonIndent2 } from '../cli-common.js';
import { renderCharter } from './charter.js';
import { commentClientFor, postCharter } from './comment.js';
import {
  type JudgmentResult,
  applyJudgment,
  parseJudgment,
} from './judgment.js';

type BriefingFacts = Parameters<typeof renderCharter>[0];

/** The slice of `MainDeps` delivery uses; `MainDeps` satisfies it. */
interface CharterSink {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  buildCommentClient?: Parameters<typeof commentClientFor>[1];
}

interface EmitOpts {
  json?: boolean;
  judgment?: string;
  comment?: boolean;
}

/** Read skill judgment; any problem degrades to a facts-only charter, never exit 1. */
function loadJudgment(
  path: string | undefined,
  facts: BriefingFacts,
  sink: CharterSink,
): JudgmentResult | undefined {
  if (path === undefined) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    sink.err(
      `WARNING: judgment ignored: '${path}' could not be read (${(e as Error).message})`,
    );
    return undefined;
  }
  const parsed = parseJudgment(raw);
  if (typeof parsed === 'string') {
    sink.err(`WARNING: judgment ignored: ${parsed}`);
    return undefined;
  }
  return applyJudgment(parsed, facts.units);
}

/** `--comment`: post, else print with a note or ::warning:: (never exit 1). */
async function deliverComment(
  charter: string,
  fallback: string,
  sink: CharterSink,
): Promise<void> {
  const client = commentClientFor(sink.env, sink.buildCommentClient);
  if (client === null) {
    sink.err('canary briefing: no PR context; charter printed to stdout');
    sink.out(fallback);
    return;
  }
  const result = await postCharter(client, charter);
  if (result.kind === 'posted') {
    sink.out(
      `Charter posted as a PR comment (${result.action}, id ${result.commentId}).`,
    );
    return;
  }
  sink.out(fallback);
  sink.out(`::warning::${result.notice}`);
}

/** Write the charter (or its JSON) for `facts`, honouring the output flags. */
export async function emitCharter(
  facts: BriefingFacts,
  opts: EmitOpts,
  sink: CharterSink,
): Promise<void> {
  const judgment = loadJudgment(opts.judgment, facts, sink);
  const output =
    opts.json === true
      ? jsonIndent2(judgment === undefined ? facts : { ...facts, judgment })
      : renderCharter(facts, judgment);
  if (opts.comment === true) {
    // The comment is always the Markdown charter; `output` is the fallback.
    await deliverComment(renderCharter(facts, judgment), output, sink);
    return;
  }
  sink.out(output);
}
