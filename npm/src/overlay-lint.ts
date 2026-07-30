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

/** Minimal SKILL.md frontmatter: scalars plus `deploy_to` flow list. */
interface Frontmatter {
  name?: string;
  description?: string;
  cli?: string;
  entry?: string;
  deploy_to?: string[];
}

/**
 * Parse the tiny-YAML subset canary uses. Mirrors the engine's
 * `SkillRegistry.parseFrontmatterWithDiagnostics` (ts/src/core) so lint and
 * migrate can never disagree on what a SKILL.md declares (#501): flow lists
 * may wrap across lines, block sequences (`- item`) are read, and indented
 * continuation lines fold into the scalar above. A declared list the parser
 * still cannot read (e.g. an unterminated `[`) is a diagnostic in `errors`,
 * never a silent empty list.
 */
function parseFrontmatter(md: string): { fm: Frontmatter; errors: string[] } {
  const fm: Frontmatter = {};
  const errors: string[] = [];
  if (!md.startsWith('---')) return { fm, errors };

  const lines = md.split('\n');
  const body: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') break;
    body.push(lines[i]!);
  }

  const splitFlow = (joined: string): string[] =>
    joined
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  let i = 0;
  while (i < body.length) {
    const line = body[i]!;
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('#') || /^\s/.test(line)) {
      i++;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, idx).trim();
    const inline = line.slice(idx + 1).trim();
    i++;
    // Indented continuation lines belong to this key.
    const cont: string[] = [];
    while (i < body.length && /^\s+\S/.test(body[i]!)) {
      const cs = body[i]!.trim();
      if (!cs.startsWith('#')) cont.push(cs);
      i++;
    }

    if (key === 'deploy_to') {
      const listSource = inline.startsWith('[')
        ? [inline, ...cont]
        : inline === '' && cont[0]?.startsWith('[')
          ? cont
          : null;
      if (listSource !== null) {
        const joined = listSource.join(' ').trim();
        if (!joined.endsWith(']')) {
          errors.push(
            `\`deploy_to\`: unterminated flow list (no closing \`]\`): ${joined}`,
          );
          fm.deploy_to = [];
        } else {
          fm.deploy_to = splitFlow(joined);
        }
      } else if (inline === '' && cont.length > 0) {
        // Block sequence; a dash-less line folds into the item above it.
        const items: string[] = [];
        for (const c of cont) {
          if (c === '-') items.push('');
          else if (c.startsWith('- ')) items.push(c.slice(2).trim());
          else if (items.length > 0)
            items[items.length - 1] = `${items[items.length - 1]} ${c}`.trim();
        }
        fm.deploy_to = items.filter(Boolean);
        if (fm.deploy_to.length === 0) {
          errors.push('`deploy_to`: block list has no parseable items');
        }
      } else {
        fm.deploy_to = inline ? [inline] : [];
      }
    } else if (
      key === 'name' ||
      key === 'description' ||
      key === 'cli' ||
      key === 'entry'
    ) {
      // Scalar, folding wrapped/indented continuation lines back in.
      fm[key] = [inline, ...cont].join(' ').trim();
    }
  }
  return { fm, errors };
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
  const { fm, errors: parseErrors } = parseFrontmatter(text);

  // 0. Parse diagnostics — a declared-but-unreadable list is a loud error,
  // never a silent empty (#501).
  for (const message of parseErrors) {
    findings.push({
      skill: name,
      level: 'error',
      message: `frontmatter parse error: ${message}`,
    });
  }

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

  // 2. deploy_to targets. Shapes are extensible — `migrate` compares
  // `deploy_to` against the consuming repo's resolved `canary_shape` as a
  // plain string — so an unknown value is a warning (possible typo), never
  // an error (#501).
  for (const target of fm.deploy_to ?? []) {
    if (!VALID_DEPLOY_TARGETS.has(target)) {
      findings.push({
        skill: name,
        level: 'warning',
        message: `deploy_to value "${target}" is not a bundled target (${[...VALID_DEPLOY_TARGETS].join(', ')}); fine if it matches a consuming repo's custom canary_shape, otherwise a typo`,
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
