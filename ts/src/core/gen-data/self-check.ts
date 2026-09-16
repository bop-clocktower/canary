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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One detector's findings, or why it could not produce any. */
async function runDetector(
  skillsDir: string,
  detector: string,
  text: string,
  file: string,
): Promise<DetectorFinding[] | string> {
  // A scanner that throws on import or mid-scan did not check anything, so
  // the caller must hear "could not run", never a clean zero.
  try {
    const scan = await loadScan(skillsDir, detector);
    if (typeof scan === 'string') return scan;
    return scan(text, file).map((f) => ({
      detector,
      ruleId: f.ruleId,
      line: f.line,
      snippet: f.snippet,
    }));
  } catch (e) {
    return `${detector} scanner failed: ${message(e)}`;
  }
}

export async function selfCheck(
  text: string,
  file: string,
  skillsDir = defaultSkillsDir(),
): Promise<SelfCheckResult> {
  const findings: DetectorFinding[] = [];
  for (const detector of DETECTORS) {
    const result = await runDetector(skillsDir, detector, text, file);
    if (typeof result === 'string')
      return { status: 'unavailable', reason: result };
    findings.push(...result);
  }
  return { status: 'ran', detectors: [...DETECTORS], findings };
}
