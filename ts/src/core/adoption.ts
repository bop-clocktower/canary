/**
 * The adoption report (#459, acceptance criterion 4).
 *
 * Answers one question for a consumer repo: **which pieces of a canary overlay
 * adoption are actually in place here, and which are not?** The reported
 * failure behind #459 is a repo that looks adopted -- overlay skills sitting in
 * `.canary/skills/` -- while no workflow was ever installed, so the guardian
 * never runs and every surface stays quiet. A partial adoption has to be
 * *nameable* before it can be fixed.
 *
 * ## Why it lives here and not in `canary doctor`
 *
 * The issue asks for a "doctor-style" report, and `doctor` would be the natural
 * home -- but `doctor` lives in the CommonJS npm shim (`npm/src/doctor.ts`),
 * which structurally cannot import the ESM engine (see
 * `npm/scripts/sync-gate-result.mjs` for the same boundary). Every piece this
 * report inspects is an engine concept: shape resolution, `deploy_to` matching,
 * the deploy manifest, `install_workflows`. Re-deriving shape detection in the
 * shim to keep the report in `doctor` would be a second implementation of the
 * thing most likely to drift. So the report is doctor-*style* (per-piece
 * present/missing lines with a remedy under each gap) and ships on the command
 * that owns the machinery: `canary migrate --adoption-report`.
 *
 * ## What it never does
 *
 * It writes nothing. The skill and workflow pieces are read from
 * {@link HarnessMigrator.checkFreshness}, whose workflow phase already runs as
 * a dry run, so the report is a pure observation of on-disk state.
 *
 * ## The ownership line, restated
 *
 * A consumer's `.github/workflows/` is theirs (#459 decision). A workflow that
 * differs from the overlay template is therefore **present** -- adopted, then
 * edited -- never a finding. Only a declared template with *no file at all* is
 * missing. Reporting an edited workflow as a gap would nag about the single
 * thing canary has no claim over, which is a worse failure than the partial
 * adoption this report exists to surface.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CompanyKnowledge } from './company-knowledge.js';
import { gateOutcome, type SkipEntry } from './gate-result.js';
import {
  DEPLOY_MANIFEST_NAME,
  type FreshnessReport,
  type HarnessMigrator,
} from './migrator.js';

const CHECK = '\u{2705}'; // white heavy check mark
const CROSS = '\u{274C}'; // cross mark
const WARN = '\u{26A0}'; // warning sign
const EMDASH = '\u{2014}'; // em dash

/**
 * Per-piece verdict.
 *
 * `unknown` is not a soft pass and not a soft fail: it means the report could
 * not reach what the piece describes (no overlay to compare against, nothing
 * declared to install). It is always rendered, and never counted in the
 * denominator -- "cannot verify" is a finding of its own kind, not a skip.
 */
export type AdoptionPieceStatus = 'present' | 'missing' | 'unknown';

/** One line of the report: an adoption piece and whether it is in place. */
export interface AdoptionPiece {
  /** Stable identifier for the machine payload. */
  id: string;
  /** Human label, e.g. "Overlay workflows installed". */
  label: string;
  status: AdoptionPieceStatus;
  /** What was observed. Always populated, whatever the status. */
  detail: string;
  /** The first fix step. Present only when the piece is not `present`. */
  remedy?: string;
}

/**
 * The facts a report is built from.
 *
 * Deliberately a plain record rather than a project root: the derivation is
 * pure and exhaustively testable without a filesystem, and
 * {@link gatherAdoptionReport} is the only place that touches disk.
 */
export interface AdoptionInput {
  /** Every shape resolved for the target, deduplicated (`MigrationContext.shapes`). */
  shapes: string[];
  /** The overlay the target is adopting, or null when none is resolvable. */
  overlayPath: string | null;
  /** Freshness + dry-run workflow state, or null when there is no overlay. */
  freshness: FreshnessReport | null;
  /** Is there a project-local `.canary/company.json`? */
  companyJsonPresent: boolean;
  /** Is there a `.canary/skills/.deploy-manifest.json`? */
  manifestPresent: boolean;
  /** `coverage_report_path` from the company-knowledge cascade, or ''. */
  coverageReportPath: string;
  /** `sut_controllers_path` from the company-knowledge cascade, or ''. */
  sutControllersPath: string;
}

/**
 * Workflow statuses that mean *a file exists at that path*.
 *
 * `outdated` and `conflict` included on purpose: both describe a workflow the
 * repo HAS. The overlay having moved on, or the consumer having tuned their own
 * CI, is a freshness question -- `migrate --check` already reports it -- not an
 * adoption gap.
 */
const WORKFLOW_PRESENT = new Set([
  'installed',
  'updated',
  'skipped',
  'outdated',
  'conflict',
]);

/** The report: a list of pieces, and the single decision that follows. */
export class AdoptionReport {
  pieces: AdoptionPiece[];

  constructor(pieces: AdoptionPiece[]) {
    this.pieces = pieces;
  }

  get present(): AdoptionPiece[] {
    return this.pieces.filter((p) => p.status === 'present');
  }

  get missing(): AdoptionPiece[] {
    return this.pieces.filter((p) => p.status === 'missing');
  }

  /** Pieces the report could not reach. Reported, never counted as verified. */
  get unverifiable(): AdoptionPiece[] {
    return this.pieces.filter((p) => p.status === 'unknown');
  }

  /** The denominator: pieces that produced a real verdict. */
  get checked(): number {
    return this.present.length + this.missing.length;
  }

  /** True only when every piece was verified AND every piece is in place. */
  get adopted(): boolean {
    return (
      this.checked > 0 &&
      this.missing.length === 0 &&
      this.unverifiable.length === 0
    );
  }

  private skipped(): SkipEntry[] {
    return this.unverifiable.map((p) => ({ name: p.id, reason: p.detail }));
  }

  /** A report that reached nothing has abstained, not passed (#508). */
  get abstained(): boolean {
    return gateOutcome(
      {
        checked: this.checked,
        findings: this.missing,
        skipped: this.skipped(),
      },
      'gate',
    ).abstained;
  }

  /** 0 fully adopted, 1 pieces missing, 3 nothing verifiable (#508 D4). */
  exit_code(): number {
    return gateOutcome(
      {
        checked: this.checked,
        findings: this.missing,
        skipped: this.skipped(),
      },
      'gate',
    ).exitCode;
  }

  to_dict(): Record<string, unknown> {
    return {
      schema_version: 1,
      adopted: this.adopted,
      checked: this.checked,
      missing: this.missing.length,
      unverifiable: this.unverifiable.length,
      abstained: this.abstained,
      exit_code: this.exit_code(),
      pieces: this.pieces.map((p) => ({
        id: p.id,
        label: p.label,
        status: p.status,
        detail: p.detail,
        ...(p.remedy !== undefined ? { remedy: p.remedy } : {}),
      })),
    };
  }

  to_markdown(): string {
    const symbol: Record<AdoptionPieceStatus, string> = {
      present: CHECK,
      missing: CROSS,
      unknown: WARN,
    };
    const lines: string[] = ['# Canary Adoption', ''];
    for (const p of this.pieces) {
      lines.push(`- ${symbol[p.status]} **${p.label}** ${EMDASH} ${p.detail}`);
      if (p.remedy) lines.push(`  - fix: ${p.remedy}`);
    }
    lines.push('');
    if (this.unverifiable.length > 0) {
      lines.push(
        `${this.unverifiable.length} piece(s) were **not verified** ` +
          `${EMDASH} that is not the same as being in place.`,
        '',
      );
    }
    lines.push(
      gateOutcome(
        {
          checked: this.checked,
          findings: this.missing,
          skipped: this.skipped(),
        },
        'gate',
        { noun: 'adoption piece(s)' },
      ).summaryLine,
    );
    if (this.abstained) {
      lines.push(
        '',
        `Nothing was verified, so this is not a pass. Track an overlay ` +
          '(`canary overlay add <source>`) and re-run, so there is something ' +
          'to compare this repo against.',
      );
    }
    return lines.join('\n');
  }
}

/** `.canary/company.json` -- the pointer file every other piece reads. */
function companyJsonPiece(input: AdoptionInput): AdoptionPiece {
  return input.companyJsonPresent
    ? {
        id: 'company_json',
        label: 'Company knowledge',
        status: 'present',
        detail: '`.canary/company.json` is present',
      }
    : {
        id: 'company_json',
        label: 'Company knowledge',
        status: 'missing',
        detail: 'no `.canary/company.json` in this repo',
        remedy: 'run `canary setup` to scaffold it',
      };
}

/**
 * A resolved test shape.
 *
 * Load-bearing rather than cosmetic: `deploy_to` matching and `<shape>:`-keyed
 * workflow variants are both shape-keyed, so an unresolved shape silently
 * deploys and installs nothing (#504).
 */
function shapePiece(input: AdoptionInput): AdoptionPiece {
  return input.shapes.length > 0
    ? {
        id: 'shape',
        label: 'Test shape resolved',
        status: 'present',
        detail: input.shapes.map((s) => `\`${s}\``).join(', '),
      }
    : {
        id: 'shape',
        label: 'Test shape resolved',
        status: 'missing',
        detail:
          'no shape was detected, so every shape-keyed skill and workflow ' +
          'variant matches nothing',
        remedy:
          'set `canary_shape` in `.canary/company.json`, or pass ' +
          '`--framework <name>` to resolve one',
      };
}

/**
 * The portable-path pointers a generated workflow interpolates.
 *
 * Undeclared is `unknown`, not `missing`: a template with no pointer falls back
 * to its own default, and whether that default fits this repo is not knowable
 * from the repo alone. Calling it a gap would raise a finding on every
 * lcov-default repo that is working perfectly.
 */
function pathPointersPiece(input: AdoptionInput): AdoptionPiece {
  const declared: string[] = [];
  if (input.coverageReportPath)
    declared.push(`coverage_report_path=\`${input.coverageReportPath}\``);
  if (input.sutControllersPath)
    declared.push(`sut_controllers_path=\`${input.sutControllersPath}\``);
  if (declared.length > 0) {
    return {
      id: 'path_pointers',
      label: 'Portable path pointers',
      status: 'present',
      detail: declared.join(', '),
    };
  }
  return {
    id: 'path_pointers',
    label: 'Portable path pointers',
    status: 'unknown',
    detail:
      'neither `coverage_report_path` nor `sut_controllers_path` is declared, ' +
      'so a workflow template that reads one uses its own default ' +
      `${EMDASH} whether that default fits this repo cannot be told from here`,
    remedy:
      'declare the repo-relative paths in `.canary/company.json` if the ' +
      "installed workflow's defaults are wrong",
  };
}

/** An overlay to adopt from. Without one, nothing overlay-derived is knowable. */
function overlayPiece(input: AdoptionInput): AdoptionPiece {
  return input.overlayPath !== null
    ? {
        id: 'overlay',
        label: 'Overlay resolved',
        status: 'present',
        detail: `\`${input.overlayPath}\``,
      }
    : {
        id: 'overlay',
        label: 'Overlay resolved',
        status: 'missing',
        detail: 'no overlay is tracked or passed, so nothing was deployed here',
        remedy:
          'track one with `canary overlay add <source>`, or pass ' +
          '`--from <overlay>`',
      };
}

/** Overlay skills deployed under `.canary/skills/`. */
function skillsPiece(input: AdoptionInput): AdoptionPiece {
  const label = 'Overlay skills deployed';
  const freshness = input.freshness;
  if (freshness === null) {
    return {
      id: 'skills',
      label,
      status: 'unknown',
      detail: 'no overlay to compare against, so deployment was not checked',
      remedy: 'resolve an overlay (see above) and re-run',
    };
  }
  if (freshness.results.length === 0) {
    return {
      id: 'skills',
      label,
      status: 'unknown',
      detail:
        "zero overlay skills matched this repo's shape, so nothing was " +
        'verified',
      remedy:
        "check the overlay's `deploy_to` lists against the resolved shape",
    };
  }
  const absent = freshness.results.filter((r) => r.status === 'missing');
  if (absent.length === 0) {
    return {
      id: 'skills',
      label,
      status: 'present',
      detail: `${freshness.results.length} matching skill(s) deployed`,
    };
  }
  return {
    id: 'skills',
    label,
    status: 'missing',
    detail:
      `${absent.length} of ${freshness.results.length} matching skill(s) ` +
      `not deployed: ${absent.map((r) => `\`${r.skill_name}\``).join(', ')}`,
    remedy: 'run `canary migrate --apply` to deploy them',
  };
}

/**
 * The deploy manifest.
 *
 * Its own piece rather than a footnote on the skills line: without it the
 * freshness gate cannot tell "the overlay moved ahead" from "the consumer
 * edited this", so drift detection is structurally unreachable however many
 * skills are deployed.
 */
function manifestPiece(input: AdoptionInput): AdoptionPiece {
  return input.manifestPresent
    ? {
        id: 'manifest',
        label: 'Deploy manifest',
        status: 'present',
        detail: `\`.canary/skills/${DEPLOY_MANIFEST_NAME}\` records provenance`,
      }
    : {
        id: 'manifest',
        label: 'Deploy manifest',
        status: 'missing',
        detail:
          `no \`.canary/skills/${DEPLOY_MANIFEST_NAME}\`, so drift cannot be ` +
          'told apart from a local edit',
        remedy: 'run `canary migrate --apply` to record it',
      };
}

/** Declared workflow templates actually sitting in `.github/workflows/`. */
function workflowsPiece(input: AdoptionInput): AdoptionPiece {
  const label = 'Overlay workflows installed';
  const freshness = input.freshness;
  if (freshness === null) {
    return {
      id: 'workflows',
      label,
      status: 'unknown',
      detail:
        'no overlay to compare against, so `.github/workflows/` was not ' +
        'checked',
      remedy: 'resolve an overlay (see above) and re-run',
    };
  }
  if (freshness.workflows.length === 0) {
    return {
      id: 'workflows',
      label,
      status: 'unknown',
      detail:
        'no matching overlay skill declares an `install_workflows` template, ' +
        'so there is nothing to install into `.github/workflows/`',
      remedy:
        'if a workflow is expected, check the declaring skill deploys for ' +
        'this shape',
    };
  }
  const absent = freshness.workflows.filter(
    (w) => !WORKFLOW_PRESENT.has(w.status),
  );
  if (absent.length === 0) {
    return {
      id: 'workflows',
      label,
      status: 'present',
      detail: `${freshness.workflows.length} declared workflow(s) in \`.github/workflows/\``,
    };
  }
  return {
    id: 'workflows',
    label,
    status: 'missing',
    detail: absent
      .map((w) => `\`${w.workflow}\` (${w.status}) ${EMDASH} ${w.detail}`)
      .join('; '),
    remedy: 'run `canary migrate --apply` to install the declared workflow(s)',
  };
}

/**
 * Derive the report from gathered facts.
 *
 * Piece order is the adoption order: local config first, then the overlay, then
 * what the overlay put here. A reader hitting the first `missing` line has
 * found the step to fix, because nothing below it can work without it.
 */
export function buildAdoptionReport(input: AdoptionInput): AdoptionReport {
  return new AdoptionReport([
    companyJsonPiece(input),
    shapePiece(input),
    pathPointersPiece(input),
    overlayPiece(input),
    skillsPiece(input),
    manifestPiece(input),
    workflowsPiece(input),
  ]);
}

/**
 * Read the target repo and build its adoption report. Writes nothing.
 *
 * `home` is the company-knowledge cascade's home layer (a test seam, matching
 * `CompanyKnowledge.load`); the *presence* check deliberately looks only at the
 * project-local file, because an org-wide `~/.canary/company.json` is not
 * something this repo has adopted.
 */
export function gatherAdoptionReport(
  migrator: HarnessMigrator,
  projectRoot: string,
  overlayPath: string | null,
  home?: string,
): AdoptionReport {
  const ctx = migrator.detect(projectRoot);
  const ck = CompanyKnowledge.load(projectRoot, null, home);
  return buildAdoptionReport({
    shapes: ctx.shapes,
    overlayPath,
    freshness:
      overlayPath === null
        ? null
        : migrator.checkFreshness(projectRoot, { overlayPath }),
    companyJsonPresent: existsSync(
      join(projectRoot, '.canary', 'company.json'),
    ),
    manifestPresent: existsSync(
      join(projectRoot, '.canary', 'skills', DEPLOY_MANIFEST_NAME),
    ),
    coverageReportPath: ck.coverage_report_path,
    sutControllersPath: ck.sut_controllers_path,
  });
}
