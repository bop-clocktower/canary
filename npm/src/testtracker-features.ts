/**
 * `canary testtracker push --features-map <file>`: reading the file, and which
 * env-map warnings it supersedes.
 */
import { readFileSync } from 'node:fs';
import { parseFeatureMap } from './reporters/ingest/entry/features.js';
import { checkGlobs } from './reporters/ingest/entry/globs.js';
import { errText } from './reporters/ingest/transport.js';

/**
 * The `--features-map` file, parsed. Unreadable or malformed is an error (exit
 * 1, nothing pushed), like `--quarantine-ledger`: a file named on the command
 * line was meant to apply, and silently pushing without it would land a run
 * whose tests all say nothing about features.
 */
export function readFeaturesMap(
  file: string,
  globWarnings: string[],
): Record<string, string[]> {
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`could not read --features-map ${file}: ${errText(e)}.`);
  }
  const map = parseFeatureMap(raw, warnings);
  if (warnings.length)
    throw new Error(`--features-map ${file}: ${warnings[0]}`);
  return checkGlobs('featureMap', map, globWarnings);
}

/**
 * A `--features-map` file replaces the env map, so the env map's own warnings
 * ("sending no features") would be false once the file is read.
 */
export function isEnvFeatureMapWarning(w: string): boolean {
  return (
    w.startsWith('the feature map must be') || w.startsWith('featureMap glob')
  );
}
