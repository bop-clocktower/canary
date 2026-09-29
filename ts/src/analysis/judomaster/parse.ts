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
// Widened from `\w[\w.]*Error` so a bare `Error:` (no prefix) also matches.
const ERROR_LINE = /^((?:[\w$]+\.)*\w*(?:Error|Exception)\w*):\s?(.*)$/;

function normalizeTrace(text: string): string[] {
  return text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.replace(QUOTE, ''))
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

function errorLines(lines: string[]): RegExpExecArray[] {
  return lines
    .map((line) => ERROR_LINE.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null);
}

function framesOf(
  lines: string[],
  read: (line: string) => RawFrame | null,
): RawFrame[] {
  return lines.map(read).filter((f): f is RawFrame => f !== null);
}

function assemble(
  format: TraceFormat,
  error: RegExpExecArray | undefined,
  frames: RawFrame[],
): ParsedTrace | null {
  if (error === undefined || frames.length === 0) return null;
  return {
    format,
    errorType: error[1]!,
    message: error[2]!.trim(),
    frames,
  };
}

function parseV8(lines: string[]): ParsedTrace | null {
  return assemble('v8', errorLines(lines)[0], framesOf(lines, v8Frame));
}

function parsePython(lines: string[]): ParsedTrace | null {
  const errors = errorLines(lines);
  // CPython prints outermost first; the model is innermost first.
  const frames = framesOf(lines, pyFrame).reverse();
  return assemble('python', errors[errors.length - 1], frames);
}

/** Parse a pasted V8 or CPython trace; null when neither is recognised. */
export function parseTrace(text: string): ParsedTrace | null {
  const lines = normalizeTrace(text);
  if (lines.some((line) => PY_FRAME.test(line))) return parsePython(lines);
  return parseV8(lines);
}
