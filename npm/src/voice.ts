/**
 * Voice lines for npm-package surfaces (#340 slice 2), today `canary doctor`.
 *
 * A port of the test reporter's `scripts/voice.mjs` selector: that skill is
 * ESM and self-contained, and this package is CommonJS, so neither can import
 * the other. A conformance test holds the two to the same line for the same
 * counts. Lines come from `voice/lines.json`, staged into `dist/voice/` by the
 * build. ADR 0031: voice is presentation only, and any failure to resolve a
 * line yields no line.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type VoiceLines = Record<string, Record<string, unknown>>;

export interface VoiceCounts {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
}

export const DEFAULT_VOICE_LINES = path.join(__dirname, 'voice', 'lines.json');

const OFF_ENV = ['CANARY_NO_FLAVOR', 'NO_FLAVOR'];
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Flavor defaults on; the flag or either env var turns it off. */
export function flavorOn(
  env: Record<string, string | undefined>,
  noFlavorFlag: boolean,
): boolean {
  if (noFlavorFlag) return false;
  return !OFF_ENV.some((k) =>
    TRUTHY.has(
      String(env[k] ?? '')
        .trim()
        .toLowerCase(),
    ),
  );
}

export function loadLines(linesPath: string): VoiceLines | null {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(linesPath, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as VoiceLines)
      : null;
  } catch {
    return null;
  }
}

/** One line chosen by the counts, so the same result gives the same line. */
export function pickLine(
  lines: VoiceLines | null,
  profile: string,
  moment: string,
  counts: VoiceCounts,
): string {
  const pool = lines?.[profile]?.[moment];
  if (!Array.isArray(pool) || pool.length === 0) return '';
  const seed =
    counts.total + counts.passed * 7 + counts.failed * 13 + counts.flaky * 17;
  const line: unknown = pool[seed % pool.length];
  return typeof line === 'string' ? line.trim() : '';
}
