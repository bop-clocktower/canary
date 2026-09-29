/**
 * The regression brief for canary-judomaster (#614).
 *
 * The brief is the hand-off to the existing authoring path
 * (`/canary-write-test`, `canary-test-author`): it names the suspect frame,
 * the error signature `verify` will confirm a reproduction against (D2), where
 * the test goes (always under `tests/generated/regression/`, D6), and the
 * requirement string the author works from. It writes no test code itself.
 *
 * `suspect` is null when no frame resolved inside the root; the CLI turns
 * that into an abstention (exit 3), never a brief with nothing to point at.
 */

import { basename, extname } from 'node:path';

import type {
  ParsedTrace,
  RegressionBrief,
  ResolvedFrame,
  TraceFormat,
} from './types.js';

const OUT_DIR = 'tests/generated/regression';

function pickSuspect(frames: ResolvedFrame[]): ResolvedFrame | null {
  const hit = frames.find(
    (f) => f.status === 'resolved' || f.status === 'stale',
  );
  return hit ?? null;
}

function signatureOf(trace: ParsedTrace): RegressionBrief['signature'] {
  const first = trace.message.split(/\r?\n/)[0]!.trim();
  const type = trace.errorType;
  if (first === '') return { text: type, kind: 'type-only', type };
  return { text: first, kind: 'message', type };
}

function slug(text: string, joiner: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== '')
    .join(joiner);
}

function outputPathFor(
  format: TraceFormat,
  suspect: ResolvedFrame | null,
  errorType: string,
): string {
  const file = suspect?.path ?? 'incident';
  const ext = extname(file);
  const stem = basename(file, ext);
  if (format === 'python') {
    return `${OUT_DIR}/test_${slug(`${stem} ${errorType}`, '_')}.py`;
  }
  const testExt = ext === '' ? '.ts' : ext;
  return `${OUT_DIR}/${slug(`${stem} ${errorType}`, '-')}.test${testExt}`;
}

function requirementFor(brief: Omit<RegressionBrief, 'requirement'>): string {
  const s = brief.suspect;
  const where =
    s === null
      ? 'the incident'
      : `${s.path}:${s.line}${s.fn ? ` (in ${s.fn})` : ''}`;
  return [
    `Write one ${brief.framework} regression test for the escaped defect at ${where}.`,
    `It must reproduce ${brief.errorType}: ${brief.signature.text}.`,
    'The test must fail against the current code, and its failure output must',
    'contain that signature. Call the code and assert the correct behaviour;',
    'do not quote the error text in the test, because a match on text the test',
    `prints itself proves nothing. Write it to ${brief.outputPath}.`,
  ].join(' ');
}

/** Build the regression brief from a parsed trace and its resolved frames. */
export function buildBrief(
  trace: ParsedTrace,
  frames: ResolvedFrame[],
): RegressionBrief {
  const suspect = pickSuspect(frames);
  const partial = {
    schema: 'canary-judomaster-brief/1' as const,
    format: trace.format,
    errorType: trace.errorType,
    message: trace.message,
    signature: signatureOf(trace),
    suspect,
    frames,
    framework: trace.format === 'python' ? 'pytest' : 'vitest',
    outputPath: outputPathFor(trace.format, suspect, trace.errorType),
  };
  return { ...partial, requirement: requirementFor(partial) };
}
