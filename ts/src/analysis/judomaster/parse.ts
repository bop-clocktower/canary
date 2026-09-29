/**
 * Stack-trace parser for canary-judomaster (#614).
 *
 * Accepts a trace as people actually paste it: Slack `>` quote markers, code
 * fences and ANSI colour are stripped first. Two formats are recognised, V8
 * (Node, JS/TS) and CPython; anything else -- Java, Go, Ruby, .NET, prose --
 * returns null so the CLI abstains and says so rather than guessing.
 *
 * A trace needs an error line AND at least one frame. The error line carries
 * the signature `verify` later confirms a reproduction against; without it
 * there is nothing to confirm, so it is required rather than defaulted.
 */

import type { ParsedTrace, RawFrame, TraceFormat } from './types.js';

const ANSI = /\x1b\[[0-9;]*m/g;
const QUOTE = /^>\s?/;
const FENCE = /^\s*```/;
const V8_FRAME = /^\s*at (?:(.+?) \()?(?:file:\/\/)?(.+?):(\d+):(\d+)\)?$/;
const PY_FRAME = /^\s*File "(.+)", line (\d+)(?:, in (.+))?$/;
// `Uncaught ` prefix, a Node ` [ERR_CODE]` suffix and a bare type with no
// message (how both runtimes print an empty message) are all accepted; the
// type must END in Error/Exception, so `ErrorBoundary:` is not an error line.
const ERROR_LINE =
  /^(?:Uncaught\s+)?((?:[\w$]+\.)*[\w$]*(?:Error|Exception))(?:\s*\[[A-Z0-9_]+\])?(?::\s?(.*))?$/;

function normalizeTrace(text: string): string[] {
  return text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.replace(QUOTE, '').trimEnd())
    .filter((line) => !FENCE.test(line));
}

function v8Frame(line: string): RawFrame | null {
  const m = V8_FRAME.exec(line);
  if (m === null) return null;
  const frame: RawFrame = {
    file: m[2]!,
    line: Number(m[3]),
    column: Number(m[4]),
  };
  if (m[1] !== undefined) frame.fn = m[1];
  return frame;
}

function pyFrame(line: string): RawFrame | null {
  const m = PY_FRAME.exec(line);
  if (m === null) return null;
  const frame: RawFrame = { file: m[1]!, line: Number(m[2]) };
  if (m[3] !== undefined) frame.fn = m[3].trim();
  return frame;
}

interface Located<T> {
  at: number;
  value: T;
}

function locate<T>(
  lines: string[],
  read: (line: string) => T | null,
): Located<T>[] {
  const out: Located<T>[] = [];
  lines.forEach((line, at) => {
    const value = read(line);
    if (value !== null) out.push({ at, value });
  });
  return out;
}

const errorLine = (line: string) => ERROR_LINE.exec(line.trim());

function assemble(
  format: TraceFormat,
  error: RegExpExecArray | undefined,
  frames: RawFrame[],
): ParsedTrace | null {
  if (error === undefined || frames.length === 0) return null;
  return {
    format,
    errorType: error[1]!,
    message: (error[2] ?? '').trim(),
    frames,
  };
}

/**
 * The error that owns the frames, not merely the first or last error-like
 * line in the paste: a log line such as `ConnectionError: retrying` above the
 * trace, or `RuntimeError: worker exited` after it, would otherwise become
 * the signature. V8 prints the error just above its first frame.
 */
function parseV8(lines: string[]): ParsedTrace | null {
  const frames = locate(lines, v8Frame);
  const first = frames[0]?.at ?? -1;
  const above = locate(lines, errorLine).filter((e) => e.at < first);
  const error = above[above.length - 1]?.value;
  return assemble(
    'v8',
    error,
    frames.map((f) => f.value),
  );
}

/** CPython prints the error just after its last (innermost) frame. */
function parsePython(lines: string[]): ParsedTrace | null {
  const frames = locate(lines, pyFrame);
  const last = frames[frames.length - 1]?.at ?? lines.length;
  const error = locate(lines, errorLine).find((e) => e.at > last)?.value;
  // CPython prints outermost first; the model is innermost first.
  const inner = frames.map((f) => f.value).reverse();
  return assemble('python', error, inner);
}

/** Parse a pasted V8 or CPython trace; null when neither is recognised. */
export function parseTrace(text: string): ParsedTrace | null {
  const lines = normalizeTrace(text);
  if (lines.some((line) => PY_FRAME.test(line))) return parsePython(lines);
  return parseV8(lines);
}
