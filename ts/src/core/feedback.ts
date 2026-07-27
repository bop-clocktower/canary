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
 *   - **Context shape is a contract**: the four keys `{version, os, python,
 *     install}` (and their order) are preserved. The `python` value is the JS
 *     *runtime* version (`process.version`) — the Node analog of Python's
 *     `platform.python_version()`; the field name is kept for shape fidelity.
 *   - `urlencode(...)` (which uses `quote_plus`, space -> `+`) maps to
 *     `URLSearchParams`, which also form-encodes with space -> `+` and preserves
 *     insertion order. Exotic-character percent-encoding can differ byte-for-byte
 *     from CPython's `quote_plus`, but the value round-trips identically on
 *     decode (GitHub decodes it), and no test pins the raw query bytes.
 */

import { release, type } from 'node:os';

/** The public issue tracker (from npm/package.json `repository`). */
export const TRACKER_URL = 'https://github.com/bop-clocktower/canary';

export const VALID_CATEGORIES = ['bug', 'ux', 'docs', 'idea'] as const;

function canaryVersion(): string {
  // Python reads `importlib.metadata.version("canary-test-ai")`, falling back to
  // "unknown". The TS pilot has no equivalent package-metadata lookup wired in,
  // so we return the same best-effort "unknown" sentinel.
  return 'unknown';
}

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
 */
export function collectContext(): Record<string, string> {
  return {
    version: canaryVersion(),
    os: `${type()} ${release()}`.trim(),
    python: process.version,
    install: installMethod(),
  };
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
  // Python `message[:60]` slices by code point; JS `slice` slices by UTF-16
  // unit, so an astral char would truncate the title early. Match the oracle.
  const title =
    `[${category}] ${Array.from(message).slice(0, 60).join('')}`.trim();
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
export function buildFeedback(message: string, category: string): Feedback {
  const context = collectContext();
  return {
    message,
    category,
    context,
    issue_url: buildIssueUrl(category, message, context),
  };
}
