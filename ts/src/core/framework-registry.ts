/**
 * Framework Registry — queries the collection of supported testing frameworks.
 *
 * Faithful TypeScript port of `agent/core/framework_registry.py`. Reads the same
 * `agent/frameworks/registry.json` the Python engine uses. The default path is
 * resolved relative to this file (../../.. → repo root, then agent/frameworks).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { def } from '../util/coalesce.js';
import { scaffoldableFrameworks } from './scaffolder.js';

export interface Framework {
  name: string;
  category?: string;
  categories?: string[];
  languages?: string[];
  file_extensions?: string[];
  execution_command?: string | null;
  ci_flags?: string[];
  status?: string;
  maturity?: string;
  recommended_for?: string[];
  strengths?: string[];
  license?: string;
  license_note?: string;
  license_gate?: string | null;
  license_scopes?: string[] | null;
  [key: string]: unknown;
}

export interface ExecutionInfo {
  execution_command: string | null;
  ci_flags: string[];
}

/**
 * Honest, code-derived support level for a framework (Python: the dict returned
 * by `FrameworkRegistry.capabilities`). `tier` is one of `full` / `executable`
 * / `catalog`, derived from the two adopter-facing signals so it cannot drift
 * from what the code actually does.
 */
export interface FrameworkCapabilities {
  scaffold: boolean;
  execute: boolean;
  tier: string;
}

export interface FrameworkSummary {
  name: string;
  category: string | null;
  categories: string[];
  languages: string[];
  file_extensions: string[];
  execution_command: string | null;
  ci_flags: string[];
  status: string | null;
  capabilities: FrameworkCapabilities | null;
  tier: string | null;
}

/** Default registry path: <repo>/agent/frameworks/registry.json. */
export function defaultRegistryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = ts/src/core → repo root is three levels up.
  return resolve(
    here,
    '..',
    '..',
    '..',
    'agent',
    'frameworks',
    'registry.json',
  );
}

export class FrameworkRegistry {
  private readonly frameworks: Framework[];

  constructor(registryPath: string = defaultRegistryPath()) {
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8')) as {
      frameworks?: Framework[];
    };
    this.frameworks = def(raw.frameworks, []);
  }

  getAllFrameworks(): Framework[] {
    return this.frameworks;
  }

  getByCategory(category: string): Framework[] {
    return this.frameworks.filter(
      (f) =>
        f.category === category || def(f.categories, []).includes(category),
    );
  }

  getPreferredByCategory(category: string): Framework | null {
    const frameworks = this.getByCategory(category);
    const preferred = frameworks.find((f) => f.status === 'preferred');
    if (preferred) return preferred;
    return frameworks[0] ?? null;
  }

  findByName(name: string): Framework | null {
    return this.frameworks.find((f) => f.name === name) ?? null;
  }

  executionInfo(name: string): ExecutionInfo | null {
    const f = this.findByName(name);
    if (f === null) return null;
    return {
      execution_command: def(f.execution_command, null),
      ci_flags: def(f.ci_flags, []),
    };
  }

  /**
   * Whether canary can actually run a framework's command (Python:
   * `_is_runnable`). The executor substitutes **only** `{file}`, so a command is
   * runnable iff it carries `{file}` (the test path is injected) or has no
   * placeholder at all (a whole-suite runner). A command with a *different*
   * placeholder (e.g. `{target}`) would reach the shell unsubstituted, so it is
   * NOT counted as executable, however plausible the string looks.
   *
   * `if (!cmd)` reproduces Python's `if not cmd` - `null`/`undefined`/`""` all
   * count as not-runnable.
   */
  private static isRunnable(cmd: string | null | undefined): boolean {
    if (!cmd) return false;
    return cmd.includes('{file}') || !cmd.includes('{');
  }

  /**
   * Honest, code-DERIVED support level for a framework - never the registry's
   * subjective `status`/`maturity` prose (Python: `capabilities`).
   *
   * - `scaffold`: a Scaffolder template exists (canary can bootstrap it).
   * - `execute`: the registry carries a command the executor can *run* (see
   *   {@link isRunnable} - not merely a non-empty string).
   *
   * The headline `tier` derives from these two signals: `full` (scaffold +
   * execute), `executable` (execute only), or `catalog` (neither). Returns
   * `null` for an unknown framework. Case-insensitive, matching
   * `Scaffolder.scaffold`.
   */
  capabilities(name: string): FrameworkCapabilities | null {
    if (!name) return null;
    const lowered = name.toLowerCase();
    const f = this.findByName(lowered);
    if (f === null) return null;

    const canScaffold = scaffoldableFrameworks().has(lowered);
    const canExecute = FrameworkRegistry.isRunnable(f.execution_command);

    let tier: string;
    if (canScaffold && canExecute) {
      tier = 'full';
    } else if (canExecute) {
      tier = 'executable';
    } else {
      tier = 'catalog';
    }

    return { scaffold: canScaffold, execute: canExecute, tier };
  }

  summaries(): FrameworkSummary[] {
    return this.frameworks.map((f) => {
      // Python: `self.capabilities(f.get("name"))` - capabilities() lowercases.
      const caps = this.capabilities(f.name);
      return {
        name: f.name,
        category: def(f.category, null),
        categories: def(f.categories, []),
        languages: def(f.languages, []),
        file_extensions: def(f.file_extensions, []),
        execution_command: def(f.execution_command, null),
        ci_flags: def(f.ci_flags, []),
        status: def(f.status, null),
        capabilities: caps,
        // Python: `(caps or {}).get("tier")` - null when caps is null.
        tier: caps === null ? null : caps.tier,
      };
    });
  }

  matchByLanguage(language: string): Framework[] {
    return this.frameworks.filter((f) =>
      def(f.languages, []).includes(language),
    );
  }
}
