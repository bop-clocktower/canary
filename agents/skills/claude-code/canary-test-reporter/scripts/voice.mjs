// Voice footer for canary-test-reporter (#340 slice 1).
//
// Voice is garnish. It is appended to the Markdown report only: the JSON
// report, the exit code and any annotation are built before and without it,
// so turning flavor off (CANARY_NO_FLAVOR / NO_FLAVOR / --no-flavor) removes
// the footer and changes nothing else. Any failure to resolve a line (missing
// or malformed lines file, unknown moment) yields no footer, silently.
//
// Lines come from ../voice-lines.json, a byte-identical copy of the repo's
// voice/lines.json (a test holds them equal); this skill is self-contained and
// cannot read engine files. CANARY_VOICE_LINES overrides the path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LINES_PATH = path.join(HERE, '..', 'voice-lines.json');

/** The reporter's voice is fixed per surface (proposal F4a). */
const PROFILE = 'black-canary';
const DISPLAY = 'Black Canary';

const OFF_ENV = ['CANARY_NO_FLAVOR', 'NO_FLAVOR'];
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Flavor defaults on; the flag or either env var turns it off. */
export function flavorOn(env, noFlavorFlag) {
  if (noFlavorFlag) return false;
  return !OFF_ENV.some((k) =>
    TRUTHY.has(
      String(env[k] ?? '')
        .trim()
        .toLowerCase(),
    ),
  );
}

/** Parsed lines file, or null when it is missing or not an object. */
export function loadLines(linesPath) {
  try {
    const data = JSON.parse(fs.readFileSync(linesPath, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data)
      ? data
      : null;
  } catch {
    return null;
  }
}

export function momentFor({ failed, flaky }) {
  if (failed > 0) return 'report.fail';
  return flaky > 0 ? 'report.flaky' : 'report.pass';
}

/**
 * One line for this profile and moment, chosen by the report's own counts so
 * the same results always give the same line (proposal F5). '' when none.
 */
export function pickLine(lines, profile, moment, counts) {
  const pool = lines?.[profile]?.[moment];
  if (!Array.isArray(pool) || pool.length === 0) return '';
  const seed =
    counts.total + counts.passed * 7 + counts.failed * 13 + counts.flaky * 17;
  const line = pool[seed % pool.length];
  return typeof line === 'string' ? line.trim() : '';
}

/** The Markdown footer, or '' when flavor is off or no line resolves. */
export function voiceFooter(counts, { env, noFlavor, linesPath }) {
  if (!flavorOn(env, noFlavor)) return '';
  const line = pickLine(
    loadLines(linesPath),
    PROFILE,
    momentFor(counts),
    counts,
  );
  if (line === '') return '';
  return (
    '\n\n---\n\n' +
    `_Voice: ${DISPLAY} ${String.fromCharCode(0xb7)} garnish only; CANARY_NO_FLAVOR=1 hides it_\n` +
    `> ${line}\n`
  );
}
