/**
 * Run canary-blackhawk and canary-savant over emitted fixture text before it
 * is written (#765). The scanners live in agents/skills (outside ts/src's
 * rootDir), so they are loaded with a runtime dynamic import from the
 * bundled skills dir -- the same packaging contract skill-registry pins
 * (#757). If they cannot be loaded the result is `unavailable`: a check
 * that did not run is an abstention, never a clean result.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundledSkillsDirFrom } from '../skill-registry.js';

export interface DetectorFinding {
  detector: string;
  ruleId: string;
  line: number;
  snippet: string;
}
export type SelfCheckResult =
  | { status: 'ran'; detectors: string[]; findings: DetectorFinding[] }
  | { status: 'unavailable'; reason: string };

const DETECTORS = ['canary-blackhawk', 'canary-savant'] as const;
type ScanText = (
  text: string,
  file: string,
) => Array<{ ruleId: string; line: number; snippet: string }>;

// This module sits one directory below core/, so hand skill-registry the
// core/ directory to keep its "three levels up" contract intact.
const defaultSkillsDir = () =>
  bundledSkillsDirFrom(join(dirname(fileURLToPath(import.meta.url)), '..'));

async function loadScan(
  skillsDir: string,
  skill: string,
): Promise<ScanText | string> {
  const file = join(skillsDir, 'claude-code', skill, 'scripts', 'scanner.mjs');
  if (!existsSync(file)) return `${skill} scanner not found at ${file}`;
  const mod: unknown = await import(pathToFileURL(file).href);
  const fn = (mod as { scanText?: unknown }).scanText;
  return typeof fn === 'function'
    ? (fn as ScanText)
    : `${skill} scanner exports no scanText`;
}

export async function selfCheck(
  text: string,
  file: string,
  skillsDir = defaultSkillsDir(),
): Promise<SelfCheckResult> {
  const findings: DetectorFinding[] = [];
  for (const detector of DETECTORS) {
    const scan = await loadScan(skillsDir, detector);
    if (typeof scan === 'string')
      return { status: 'unavailable', reason: scan };
    for (const f of scan(text, file))
      findings.push({
        detector,
        ruleId: f.ruleId,
        line: f.line,
        snippet: f.snippet,
      });
  }
  return { status: 'ran', detectors: [...DETECTORS], findings };
}
