'use strict';

/**
 * `canary overlay lint` — validate an overlay against the authoring contract
 * (#332). Overlay quality otherwise depends on each author's discipline;
 * downstream audits found frontmatter chaos, dead `cli:` paths, and invalid
 * doctor manifests that nothing caught mechanically.
 *
 * Checks (per skill under `<overlay>/.canary/skills/<name>/SKILL.md`):
 *   1. frontmatter floor — `name` and `description` present and non-empty
 *      (modeled on harness's `skill validate`), plus any frontmatter parse
 *      diagnostic (e.g. an unterminated flow list) reported as an error —
 *      a declared list must never silently read as empty (#501);
 *   2. `deploy_to` values that are not bundled migration targets are a
 *      WARNING, not an error — shapes are extensible and `migrate` matches
 *      `deploy_to` against the consuming repo's resolved `canary_shape` by
 *      plain string comparison, so a custom shape is legitimate (#501);
 *   3. `cli:` script paths exist inside the skill dir (no escape);
 * plus one overlay-level check:
 *   4. `.canary/doctor.json` (if present) passes manifest validation — reuses
 *      `loadManifest` so the lint and `canary doctor` never disagree.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadManifest } from './doctor-manifest.js';
import {
  type Frontmatter,
  listField,
  parseFrontmatter,
  scalarField,
} from './skill-frontmatter.js';

/**
 * The BUNDLED migration target shapes, plus the `all` sentinel. Not a closed
 * set: `migrate` matches `deploy_to` against the consuming repo's resolved
 * `canary_shape` by plain string comparison, so downstream overlays may use
 * custom shapes. Lint warns (never errors) on a value outside this set (#501).
 */
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

/**
 * Checks 0–2: parse diagnostics (a declared-but-unreadable list is a loud
 * error, never a silent empty), the name/description floor, and deploy_to
 * values — unknown targets warn, since shapes are extensible (#501).
 */
function frontmatterFindings(
  skill: string,
  fm: Frontmatter,
  parseErrors: string[],
): LintFinding[] {
  const findings: LintFinding[] = parseErrors.map((m) => ({
    skill,
    level: 'error' as const,
    message: `frontmatter parse error: ${m}`,
  }));
  for (const field of ['name', 'description'] as const) {
    if (!scalarField(fm, field)) {
      findings.push({
        skill,
        level: 'error',
        message:
          field === 'name'
            ? 'frontmatter is missing `name`'
            : 'frontmatter is missing a non-empty `description`',
      });
    }
  }
  for (const target of listField(fm, 'deploy_to')) {
    if (!VALID_DEPLOY_TARGETS.has(target)) {
      findings.push({
        skill,
        level: 'warning',
        message: `deploy_to value "${target}" is not a bundled target (${[...VALID_DEPLOY_TARGETS].join(', ')}); fine if it matches a consuming repo's custom canary_shape, otherwise a typo`,
      });
    }
  }
  return findings;
}

function lintSkill(name: string, skillDir: string): LintFinding[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  } catch {
    return [{ skill: name, level: 'error', message: 'SKILL.md is unreadable' }];
  }
  const { frontmatter: fm, errors } = parseFrontmatter(text);
  const findings = frontmatterFindings(name, fm, errors);

  // 3. cli path (entry is a module ref, not a filesystem path — not checked here).
  const cli = scalarField(fm, 'cli');
  if (cli) {
    const f = cliFinding(name, skillDir, cli);
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
