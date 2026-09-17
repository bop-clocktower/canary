/**
 * Vitest sequencer that runs files in `canary order` plan order (#460 phase 3).
 *
 * ```ts
 * // vitest.config.ts
 * import CanaryOrderSequencer from 'canary-test-cli/vitest-sequencer';
 * export default defineConfig({
 *   test: { sequence: { sequencer: CanaryOrderSequencer } },
 * });
 * ```
 *
 * Then `CANARY_ORDER_PLAN=plan.json vitest run`. Without the variable, or with
 * a plan it cannot read, it defers to vitest's own order and says why on
 * stderr: an unusable plan must never block or shrink a run. Files the plan
 * does not name run last. Vitest still runs files in parallel, so the plan
 * orders scheduling, not strict execution.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { BaseSequencer, type TestSpecification } from 'vitest/node';

import { applyOrderPlan, parseOrderPlan } from './apply.js';

function repoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function readPlan(path: string): ReturnType<typeof parseOrderPlan> {
  try {
    return parseOrderPlan(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export default class CanaryOrderSequencer extends BaseSequencer {
  override async sort(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const path = process.env['CANARY_ORDER_PLAN'];
    if (!path) return super.sort(files);
    const plan = readPlan(path);
    if (plan === null) {
      process.stderr.write(
        `canary order: ${path} is not a readable order plan; using vitest's order.\n`,
      );
      return super.sort(files);
    }
    const ordered = applyOrderPlan(
      files.map((f) => f.moduleId),
      plan,
      repoRoot(),
    );
    const byId = new Map<string, TestSpecification[]>();
    for (const f of files) {
      byId.set(f.moduleId, [...(byId.get(f.moduleId) ?? []), f]);
    }
    return ordered.map((id) => byId.get(id)!.shift()!);
  }
}
