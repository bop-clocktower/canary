/**
 * In-CLI feedback / issue reporting (#345).
 *
 * Faithful TypeScript port of `agent/core/feedback.py`. `canary feedback` lowers
 * the discoverability barrier that makes feedback evaporate at submission time:
 * instead of hunting for where the tracker lives, a user runs one command and
 * gets a **pre-filled GitHub issue** with non-sensitive context already
 * attached. This module is the pure, testable core — it builds the payload and
 * URL; the CLI command handles I/O, confirmation, and opening a browser.
 *
 * Privacy: context is limited to version / OS / runtime / install method. It
 * never reads environment variables or file contents.
 *
 * Python→TS nuances:
 *   - The context keys are `{version, os, runtime, install}` (insertion order
 *     preserved). `runtime` carries `process.version`; the key was named
 *     `python` for golden-parity shape fidelity until #506 — in filed issues
 *     it misled triage ("user on python v22?") once the Python engine retired.
 *   - `urlencode(...)` (which uses `quote_plus`, space -> `+`) maps to
 *     `URLSearchParams`, which also form-encodes with space -> `+` and preserves
 *     insertion order. Exotic-character percent-encoding can differ byte-for-byte
 *     from CPython's `quote_plus`, but the value round-trips identically on
 *     decode (GitHub decodes it), and no test pins the raw query bytes.
 */

import { release, type } from 'node:os';

/** The public issue tracker (from npm/package.json `repository`). */
const TRACKER_URL = 'https://github.com/bop-clocktower/canary';

export const VALID_CATEGORIES = ['bug', 'ux', 'docs', 'idea'] as const;

/** Best-effort install-method label — never fails, never inspects secrets. */
function installMethod(): string {
  const exe = (process.execPath || '').toLowerCase();
  if (exe.includes('pipx')) {
    return 'pipx';
  }
  return 'pip/npm';
}

/**
 * Non-sensitive diagnostic context to attach to a report.
 *
 * Deliberately excludes environment variables and file contents — only the
 * coarse runtime facts a maintainer needs to triage a CLI report.
 *
 * `version` comes from the caller (#506): this module is pure and cannot know
 * which package it shipped in, but the CLI layer does (`deps.pkgVersion()`),
 * and the version is the single most useful triage field.
 */
export function collectContext(version = 'unknown'): Record<string, string> {
  return {
    version,
    os: `${type()} ${release()}`.trim(),
    runtime: process.version,
    install: installMethod(),
  };
}

// Horizontal ellipsis, kept as an escape so this source stays ASCII.
const ELLIPSIS = '\u{2026}';

/**
 * Cap the title at 60 code points (`Array.from` slices by code point, not
 * UTF-16 unit, so astral chars do not truncate early). When the cap bites,
 * break on the last word boundary inside the budget (falling back to a hard
 * cut for an unbreakable token) and append an ellipsis so the truncation is
 * visible instead of ending mid-word (#506).
 */
function truncateTitle(message: string): string {
  const points = Array.from(message);
  if (points.length <= 60) return message;
  const hard = points.slice(0, 60).join('');
  const lastBreak = hard.search(/\s+\S*$/);
  const cut = lastBreak > 0 ? hard.slice(0, lastBreak) : hard;
  return `${cut}${ELLIPSIS}`;
}

/**
 * A pre-filled GitHub 'new issue' URL: category in the title, message + context
 * in the body, category as a label. All parts are URL-encoded.
 */
export function buildIssueUrl(
  category: string,
  message: string,
  context: Record<string, string>,
): string {
  const title = `[${category}] ${truncateTitle(message)}`.trim();
  const bodyLines = [
    message,
    '',
    '---',
    '_Submitted via `canary feedback`._',
    '',
    '**Environment**',
  ];
  for (const [k, v] of Object.entries(context)) {
    bodyLines.push(`- ${k}: ${v}`);
  }
  const query = new URLSearchParams({
    title,
    body: bodyLines.join('\n'),
    labels: category,
  });
  return `${TRACKER_URL}/issues/new?${query.toString()}`;
}

export interface Feedback {
  message: string;
  category: string;
  context: Record<string, string>;
  issue_url: string;
}

/** Bundle a report: message, category, context, and the pre-filled URL. */
export function buildFeedback(
  message: string,
  category: string,
  version = 'unknown',
): Feedback {
  const context = collectContext(version);
  return {
    message,
    category,
    context,
    issue_url: buildIssueUrl(category, message, context),
  };
}
