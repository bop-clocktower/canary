/**
 * Contract guard: the impact skills must call harness's purpose-built impact
 * primitives when the harness MCP is present, while preserving today's grep /
 * `git log` fallbacks when it is absent.
 *
 * Ported from `tests/unit/test_skill_harness_impact_primitives.py` (#338).
 * `canary-critical-areas` and `canary-failure-impact` are prose-only (no backing
 * Python), so the contract is enforced against the SKILL.md text: the primitive
 * names must appear, and the graceful degradation language must survive.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = join(REPO, 'agents', 'skills', 'claude-code');
const CRITICAL_AREAS = join(SKILLS_DIR, 'canary-critical-areas', 'SKILL.md');
const FAILURE_IMPACT = join(SKILLS_DIR, 'canary-failure-impact', 'SKILL.md');

function read(path: string): string {
  expect(existsSync(path), `missing skill: ${path}`).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('impact skills use harness primitives', () => {
  it('critical-areas calls the impact primitives', () => {
    const text = read(CRITICAL_AREAS);
    // Downstream-dependents signal must prefer the real impact primitive.
    expect(text).toContain('get_impact');
    // Churn / hotspot signal must prefer harness anomaly detection.
    expect(text).toContain('detect_anomalies');
    // Perf/critical-path signal must consult the dedicated primitive.
    expect(text).toContain('get_critical_paths');
  });

  it('critical-areas preserves the fallbacks', () => {
    const text = read(CRITICAL_AREAS);
    // Graceful degradation: git churn + grep fallbacks must survive.
    expect(text).toContain('git log');
    expect(text).toContain('grep');
    expect(text).toContain('Fallback');
    expect(text).toContain('harness MCP');
  });

  it('failure-impact calls the blast-radius primitive', () => {
    const text = read(FAILURE_IMPACT);
    // Blast-radius tracing must prefer the probability-weighted primitive.
    expect(text).toContain('compute_blast_radius');
    // ...and the impact primitive for the affected-node inventory.
    expect(text).toContain('get_impact');
  });

  it('failure-impact preserves the fallbacks', () => {
    const text = read(FAILURE_IMPACT);
    expect(text).toContain('grep');
    expect(text).toContain('Fallback');
    expect(text).toContain('harness MCP');
  });
});
