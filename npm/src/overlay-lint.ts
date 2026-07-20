'use strict';

/**
 * `canary overlay lint` — validate an overlay against the authoring contract
 * (#332). Overlay quality otherwise depends on each author's discipline;
 * downstream audits found frontmatter chaos, dead `cli:` paths, and invalid
 * doctor manifests that nothing caught mechanically.
 *
 * Checks (per skill under `<overlay>/.canary/skills/<name>/SKILL.md`):
 *   1. frontmatter floor — `name` and `description` present and non-empty
 *      (modeled on harness's `skill validate`);
 *   2. `deploy_to` values resolve to known migration targets;
 *   3. `cli:` script paths exist inside the skill dir (no escape);
 * plus one overlay-level check:
 *   4. `.canary/doctor.json` (if present) passes manifest validation — reuses
 *      `loadManifest` so the lint and `canary doctor` never disagree.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadManifest } from './doctor-manifest.js';

/** Migration target shapes a `deploy_to` entry may name, plus the `all` sentinel. */
export const VALID_DEPLOY_TARGETS: ReadonlySet<string> = new Set([
  'api',
  'e2e_ui',
  'frontend_unit',
  'load',
  'performance',
  'all',
]);

export interface LintFinding {
  /** Skill name, or `(overlay)` for an overlay-level finding. */
  skill: string;
  level: 'error' | 'warning';
  message: string;
}

export interface LintResult {
  overlay: string;
  skillsChecked: number;
  findings: LintFinding[];
}

/** Minimal SKILL.md frontmatter: scalars plus `deploy_to` flow list. */
interface Frontmatter {
  name?: string;
  description?: string;
  cli?: string;
  entry?: string;
  deploy_to?: string[];
}

/** Parse the tiny-YAML subset canary uses (mirrors the Python loader). */
function parseFrontmatter(md: string): Frontmatter {
  const fm: Frontmatter = {};
  if (!md.startsWith('---')) return fm;
  for (const line of md.split('\n').slice(1)) {
    if (line.trim() === '---') break;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === 'deploy_to') {
      fm.deploy_to =
        value.startsWith('[') && value.endsWith(']')
          ? value
              .slice(1, -1)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : value
            ? [value]
            : [];
    } else if (
      key === 'name' ||
      key === 'description' ||
      key === 'cli' ||
      key === 'entry'
    ) {
      fm[key] = value;
    }
  }
  return fm;
}

/** True when `cli` resolves to a real file inside `skillDir` (no escape). */
function cliFinding(
  skill: string,
  skillDir: string,
  cli: string,
): LintFinding | null {
  const resolvedDir = path.resolve(skillDir);
  const target = path.resolve(resolvedDir, cli);
  if (target !== resolvedDir && !target.startsWith(resolvedDir + path.sep)) {
    return {
      skill,
      level: 'error',
      message: `cli: path "${cli}" escapes the skill directory`,
    };
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return {
      skill,
      level: 'error',
      message: `cli: path "${cli}" is missing (no file at ${path.relative(skillDir, target)})`,
    };
  }
  return null;
}

function lintSkill(name: string, skillDir: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const mdPath = path.join(skillDir, 'SKILL.md');
  let text: string;
  try {
    text = fs.readFileSync(mdPath, 'utf8');
  } catch {
    return [{ skill: name, level: 'error', message: 'SKILL.md is unreadable' }];
  }
  const fm = parseFrontmatter(text);

  // 1. Frontmatter floor.
  if (!fm.name) {
    findings.push({
      skill: name,
      level: 'error',
      message: 'frontmatter is missing `name`',
    });
  }
  if (!fm.description) {
    findings.push({
      skill: name,
      level: 'error',
      message: 'frontmatter is missing a non-empty `description`',
    });
  }

  // 2. deploy_to targets.
  for (const target of fm.deploy_to ?? []) {
    if (!VALID_DEPLOY_TARGETS.has(target)) {
      findings.push({
        skill: name,
        level: 'error',
        message: `deploy_to value "${target}" is not a known target (${[...VALID_DEPLOY_TARGETS].join(', ')})`,
      });
    }
  }

  // 3. cli path (entry is a module ref, not a filesystem path — not checked here).
  if (fm.cli) {
    const f = cliFinding(name, skillDir, fm.cli);
    if (f) findings.push(f);
  }

  return findings;
}

/**
 * Lint an overlay clone at `overlayPath`. Returns every finding; the caller
 * decides how to render/exit. Never throws on a malformed overlay — a missing
 * skills dir is itself an error finding.
 */
export function lintOverlay(overlayPath: string): LintResult {
  const findings: LintFinding[] = [];
  const skillsDir = path.join(overlayPath, '.canary', 'skills');

  let skillNames: string[] = [];
  try {
    skillNames = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    findings.push({
      skill: '(overlay)',
      level: 'error',
      message: `no .canary/skills directory at ${skillsDir}`,
    });
  }

  for (const name of skillNames) {
    const skillDir = path.join(skillsDir, name);
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
      findings.push({
        skill: name,
        level: 'warning',
        message: 'directory has no SKILL.md (not a skill)',
      });
      continue;
    }
    findings.push(...lintSkill(name, skillDir));
  }

  // 4. Overlay-level doctor.json validation (reuse loadManifest).
  const manifestPath = path.join(overlayPath, '.canary', 'doctor.json');
  if (fs.existsSync(manifestPath)) {
    const load = loadManifest(overlayPath);
    if (!load.ok) {
      findings.push({
        skill: '(overlay)',
        level: 'error',
        message: `.canary/doctor.json is invalid: ${load.failure.remedy ?? load.failure.label}`,
      });
    }
  }

  return { overlay: overlayPath, skillsChecked: skillNames.length, findings };
}
