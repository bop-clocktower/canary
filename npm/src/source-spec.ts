"use strict";

/**
 * Source-spec grammar for `canary overlay add <source>` (mirrors the
 * `github:owner/repo` / git-URL / local-path forms used elsewhere in the
 * ecosystem). Parsing is net-new — there is no existing engine parser.
 */

export interface ParsedSource {
  /** Argument handed to `git clone` (URL or local path). */
  cloneUrl: string;
  /** Registry key + clone directory name: `<owner>-<repo>` (or path basename). */
  name: string;
}

/** Raised when a source spec does not match any accepted form. */
export class SourceSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceSpecError";
  }
}

const ACCEPTED_FORMS =
  "accepted forms: github:owner/repo, an https/git@ URL, or a local path";

/** Strip a trailing `.git` and any trailing slashes from a path segment. */
function stripRepoSuffix(segment: string): string {
  return segment.replace(/\.git$/i, "").replace(/\/+$/, "");
}

/** Sanitize a raw `owner/repo` pair into `owner-repo`, rejecting empties. */
function nameFromOwnerRepo(owner: string, repo: string, raw: string): string {
  const cleanOwner = owner.trim();
  const cleanRepo = stripRepoSuffix(repo.trim());
  if (!cleanOwner || !cleanRepo) {
    throw new SourceSpecError(`cannot derive a name from "${raw}" (${ACCEPTED_FORMS})`);
  }
  return `${cleanOwner}-${cleanRepo}`;
}

/** Extract the last two path segments (owner, repo) from a URL-ish path. */
function lastTwoSegments(pathPart: string): [string, string] | null {
  const segments = pathPart.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  return [segments[segments.length - 2], segments[segments.length - 1]];
}

/** github:owner/repo shorthand. Returns null when `spec` is not this form. */
function parseGithubShorthand(spec: string, raw: string): ParsedSource | null {
  if (!spec.startsWith("github:")) {
    return null;
  }
  const parts = spec.slice("github:".length).split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new SourceSpecError(`"${raw}" is not github:owner/repo (${ACCEPTED_FORMS})`);
  }
  const [owner, repo] = parts;
  return {
    cloneUrl: `https://github.com/${owner}/${stripRepoSuffix(repo)}.git`,
    name: nameFromOwnerRepo(owner, repo, raw),
  };
}

/** scp-like git URL: git@host:owner/repo(.git). Returns null when not this form. */
function parseScpUrl(spec: string, raw: string): ParsedSource | null {
  const scpMatch = spec.match(/^[\w.-]+@[\w.-]+:(.+)$/);
  if (!scpMatch) {
    return null;
  }
  const pair = lastTwoSegments(scpMatch[1]);
  if (!pair) {
    throw new SourceSpecError(`cannot derive owner/repo from "${raw}" (${ACCEPTED_FORMS})`);
  }
  return { cloneUrl: spec, name: nameFromOwnerRepo(pair[0], pair[1], raw) };
}

/** Full URL: https://, http://, git://, ssh://. Returns null when not this form. */
function parseFullUrl(spec: string, raw: string): ParsedSource | null {
  if (!/^(https?|git|ssh):\/\//i.test(spec)) {
    return null;
  }
  let pathname: string;
  try {
    pathname = new URL(spec).pathname;
  } catch {
    throw new SourceSpecError(`"${raw}" is not a valid URL (${ACCEPTED_FORMS})`);
  }
  const pair = lastTwoSegments(pathname);
  if (!pair) {
    throw new SourceSpecError(`cannot derive owner/repo from "${raw}" (${ACCEPTED_FORMS})`);
  }
  return { cloneUrl: spec, name: nameFromOwnerRepo(pair[0], pair[1], raw) };
}

/** Local filesystem path (absolute, ./relative, ../relative, or ~-relative). */
function parseLocalPath(spec: string, raw: string): ParsedSource | null {
  if (!(spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("~"))) {
    return null;
  }
  const basename = stripRepoSuffix(spec.split("/").filter(Boolean).pop() ?? "");
  if (!basename) {
    throw new SourceSpecError(`cannot derive a name from path "${raw}" (${ACCEPTED_FORMS})`);
  }
  return { cloneUrl: spec, name: basename };
}

/**
 * Parse a source spec into a clone URL and overlay name. Throws
 * {@link SourceSpecError} on anything that does not match an accepted form.
 */
export function parseSource(raw: string): ParsedSource {
  const spec = (raw ?? "").trim();
  if (!spec) {
    throw new SourceSpecError(`empty source (${ACCEPTED_FORMS})`);
  }
  for (const handler of [parseGithubShorthand, parseScpUrl, parseFullUrl, parseLocalPath]) {
    const parsed = handler(spec, raw);
    if (parsed) {
      return parsed;
    }
  }
  throw new SourceSpecError(`unrecognized source "${raw}" (${ACCEPTED_FORMS})`);
}
