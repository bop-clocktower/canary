/**
 * Framework Recommender — picks testing tools for a classification, ranked.
 *
 * Faithful TypeScript port of `agent/core/recommender.py`. Wires the classifier
 * result + the framework registry into a ranked candidate list.
 */

import { def } from '../util/coalesce.js';
import type { ClassificationResult } from './classifier.js';
import { FrameworkRegistry, type Framework } from './framework-registry.js';

const MAX_CANDIDATES = 3;
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export interface ProjectMetadata {
  detected_languages: string[];
}

export interface Candidate {
  framework: string;
  category: string;
  file_extension: string;
  reason: string[];
  confidence: number;
  kind?: string;
  license?: string | null;
  warning?: string;
}

/** Whether a framework may surface given the current env license signals. */
export function licenseAllowed(framework: Framework): boolean {
  const gate = framework.license_gate;
  if (!gate) return true;
  const value = def(process.env[gate], '').trim();
  if (!value || FALSE_VALUES.has(value.toLowerCase())) return false;
  const scopes = framework.license_scopes;
  if (scopes) return scopes.includes(value);
  return true;
}

const LANG_EXT: Record<string, string> = {
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
};

function fileExtensionFor(f: Framework): string {
  const exts = def(f.file_extensions, []);
  if (exts.length > 0) return exts[0]!;
  const langs = def(f.languages, []);
  if (langs.length > 0) return def(LANG_EXT[langs[0]!.toLowerCase()], 'ts');
  return 'ts';
}

function buildReason(f: Framework): string[] {
  const reasons: string[] = [];
  reasons.push(...def(f.recommended_for, []));
  reasons.push(...def(f.strengths, []).slice(0, 2));
  if (f.maturity) reasons.push(`Maturity level: ${f.maturity}`);
  return reasons;
}

function formatCandidate(f: Framework, confidence: number): Candidate {
  const candidate: Candidate = {
    framework: f.name,
    category: def(f.category, ''),
    file_extension: fileExtensionFor(f),
    reason: buildReason(f),
    confidence,
  };
  if (f.license_note) {
    candidate.license = def(f.license, null);
    candidate.warning = f.license_note;
    const label = def(f.license, 'non-OSI license');
    candidate.reason.unshift(`⚠ ${label}: review against your license policy`);
  }
  return candidate;
}

export class FrameworkRecommender {
  private readonly registry: FrameworkRegistry;

  constructor(registry: FrameworkRegistry = new FrameworkRegistry()) {
    this.registry = registry;
  }

  recommend(
    classification: ClassificationResult,
    metadata: ProjectMetadata | null = null,
    frameworkHint: string | null = null,
  ): Candidate[] {
    if (classification.test_type === 'observability') {
      return this.recommendObservability(classification);
    }

    let frameworks = this.registry.getByCategory(classification.test_type);
    frameworks = frameworks.filter(licenseAllowed);
    if (frameworks.length === 0) return [];

    const candidates = this.applyLanguageFilter(frameworks, metadata);
    const ranked = this.rankPool(candidates, frameworkHint);
    return this.dedupeAndFormat(
      ranked,
      frameworkHint,
      classification.confidence,
    );
  }

  private applyLanguageFilter(
    frameworks: Framework[],
    metadata: ProjectMetadata | null,
  ): Framework[] {
    if (metadata === null) return frameworks;
    const detected = new Set(def(metadata.detected_languages, []));
    if (detected.size === 0) return frameworks;
    const filtered = frameworks.filter((f) =>
      def(f.languages, []).some((l) => detected.has(l)),
    );
    return filtered.length > 0 ? filtered : frameworks;
  }

  private rankPool(
    candidates: Framework[],
    frameworkHint: string | null,
  ): Framework[] {
    const hinted = frameworkHint
      ? candidates.find((f) => f.name === frameworkHint.toLowerCase())
      : undefined;
    const preferred = candidates.filter((f) => f.status === 'preferred');
    const rest = candidates.filter((f) => f.status !== 'preferred');
    return [...(hinted ? [hinted] : []), ...preferred, ...rest];
  }

  private dedupeAndFormat(
    pool: Framework[],
    frameworkHint: string | null,
    confidence: number,
  ): Candidate[] {
    const hintName = frameworkHint ? frameworkHint.toLowerCase() : null;
    const ranked: Candidate[] = [];
    const seen = new Set<string>();
    for (const fw of pool) {
      if (seen.has(fw.name)) continue;
      seen.add(fw.name);
      const entry = formatCandidate(fw, confidence);
      if (hintName !== null && fw.name === hintName) {
        entry.reason.unshift(`prompt-named framework (${fw.name})`);
      }
      ranked.push(entry);
      if (ranked.length >= MAX_CANDIDATES) break;
    }
    return ranked;
  }

  private recommendObservability(
    classification: ClassificationResult,
  ): Candidate[] {
    const confidence = classification.confidence;
    const candidates: Candidate[] = [];

    const scope = def(process.env['CANARY_SCOPE'], '').trim();
    if (scope) {
      candidates.push({
        framework: `${scope}-dashboard`,
        category: 'observability',
        file_extension: '',
        reason: [
          `configured aggregation dashboard (CANARY_SCOPE=${scope})`,
          'overlay reporting sink — receives results in addition to ReportPortal',
        ],
        confidence,
        kind: 'reporting-sink',
      });
    }

    candidates.push({
      framework: 'reportportal',
      category: 'observability',
      file_extension: '',
      reason: [
        'self-hosted OSS reporting sink — default for observability output',
      ],
      confidence,
      kind: 'reporting-sink',
    });

    const otel = this.registry
      .getByCategory('observability')
      .find((f) => f.name === 'opentelemetry');
    if (otel) {
      const c = formatCandidate(otel, confidence);
      c.kind = 'instrumentation';
      candidates.push(c);
    }

    return candidates.slice(0, MAX_CANDIDATES);
  }
}
