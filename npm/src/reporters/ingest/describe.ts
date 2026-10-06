import type { FullConfig, Suite, TestCase } from "@playwright/test/reporter";
// Ingest reporter: per-test identity, tags, catalog filters and result rows.

/** Playwright reporter suites, innermost first, as far as the root. */
type SuiteLike = { type?: string; title: string; parent?: SuiteLike };

/**
 * `file > describe… > title`: the legacy title without the project. Every
 * part comes from the test itself, so the identity never depends on which
 * other tests are in a push and two tests never share it.
 */
export function cleanTitle(test: TestCase): string {
  const parts = [test.title];
  for (let s = test.parent as SuiteLike | undefined; s && (s.type === "describe" || s.type === "file"); s = s.parent) {
    parts.unshift(s.title);
  }
  return parts.filter(Boolean).join(" > ");
}

export function projectName(test: TestCase): string | undefined {
  for (let s = test.parent as SuiteLike | undefined; s; s = s.parent) {
    if (s.type === "project") return s.title || undefined;
  }
  return undefined;
}

/** The longest `reason:` tag; enough for an issue ref and a sentence. */
const MAX_REASON = 100;

/**
 * Tags that say why a test did not run: `fixme`, and `reason:<text>` from a
 * fixme/skip annotation's description (often an issue ref). The ingest API
 * has no skip-reason field, so the reason rides as a tag (#1183).
 */
export function skipTags(annotations: ReadonlyArray<{ type: string; description?: string }>): string[] {
  const tags: string[] = [];
  for (const a of annotations) {
    if (a.type !== "fixme" && a.type !== "skip") continue;
    if (a.type === "fixme") tags.push("fixme");
    const reason = a.description?.replace(/\s+/g, " ").trim();
    if (reason) tags.push(`reason:${reason.slice(0, MAX_REASON)}`);
  }
  return tags;
}


/**
 * Why `collected` would not be the whole suite, or null when it is. A
 * filtered run's `allTests()` is only the subset that ran, and sending it
 * would shrink the suite's denominator on the dashboard (#1150). Playwright
 * does not expose `--last-failed`/`--only-changed` to a reporter; those jobs
 * opt out with `collected: false`.
 */
export function catalogFilter(config: FullConfig | undefined, suite: Suite | undefined): string | null {
  if (!config) return null;
  if (config.shard && config.shard.total > 1) return `this is shard ${config.shard.current} of ${config.shard.total}`;
  return grepFilter(config) ?? projectFilter(config, suite);
}

function grepFilter(config: FullConfig): string | null {
  const greps = [config.grep].flat().filter(Boolean) as RegExp[];
  if (greps.some((g) => g.source !== ".*")) return "the run is filtered by --grep";
  if ([config.grepInvert].flat().filter(Boolean).length) return "the run is filtered by --grep-invert";
  return null;
}

function projectFilter(config: FullConfig, suite: Suite | undefined): string | null {
  const configured = (config.projects ?? []).map((p) => p.name);
  const present = new Set((suite?.suites ?? []).filter((s) => s.type === "project").map((s) => s.title));
  const missing = configured.filter((name) => !present.has(name));
  return missing.length ? `project(s) ${missing.join(", ")} did not run` : null;
}

export function relativeFile(file: string, prefix: string): string {
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}
