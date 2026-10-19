// Ingest reporter: redact credentials out of free text before it leaves the run (#1354).
//
// Live-environment suites sign in as real test members, and their failures
// echo what a step typed or saw: emails, passwords, bearer tokens. TestTracker
// is a management dashboard, so none of that may reach it. Redaction is ON by
// default; `CANARY_INGEST_REDACT=0` (or `false`) turns it off.
import type { CollectedEntry, ResultEntry } from './payload.js';

/** `eyJ…` header, payload, signature: a JWT. Checked before the bare rule. */
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// The lookbehind starts a match only at the beginning of a run, which keeps a
// long run with no `@` linear instead of quadratic (8 KB stacks go through it).
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/**
 * A run of 32+ token characters. `/` and `.` are deliberately not token
 * characters, so a stack frame's file path is never swallowed whole.
 */
const BARE =
  /(?<![A-Za-z0-9_+=-]|<secret:)[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g;
const HAS_DIGIT = /[0-9]/;
const HAS_LETTER = /[A-Za-z]/;

/**
 * Named values shorter than this are skipped: replacing every `a1` or `true`
 * in a failure would shred the text, and a value that short is not a secret
 * the dashboard can be protected from by substring matching anyway.
 */
const MIN_NAMED_SECRET_LENGTH = 6;

function enabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.CANARY_INGEST_REDACT?.trim().toLowerCase();
  return flag !== '0' && flag !== 'false';
}

/** `CANARY_INGEST_REDACT_ENV=A,B`: the literal values of those env vars, longest first. */
function namedSecrets(
  env: NodeJS.ProcessEnv,
): Array<[name: string, value: string]> {
  const names = (env.CANARY_INGEST_REDACT_ENV ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return names
    .map((name): [string, string] => [name, env[name] ?? ''])
    .filter(([, value]) => value.length >= MIN_NAMED_SECRET_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
}

function replaceNamed(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  for (const [name, value] of namedSecrets(env))
    out = out.split(value).join(`<secret:${name}>`);
  return out;
}

/** The rules a test title gets: named secrets, JWTs and emails. Never the bare rule. */
function titleRules(text: string, env: NodeJS.ProcessEnv): string {
  return replaceNamed(text, env)
    .replace(JWT, '<token>')
    .replace(EMAIL, '<email>');
}

/**
 * Redacts a failure message, stack or skip reason. Adds the bare-credential
 * rule: 32+ token characters containing BOTH a digit and a letter, so a long
 * CamelCase identifier or a long number survives. A 40-hex git SHA does not
 * survive; that trade was accepted at the #1354 security-fleet CONFIRM, since
 * many API keys are hex.
 */
export function redactText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!enabled(env)) return text;
  return titleRules(text, env).replace(BARE, (run) =>
    HAS_DIGIT.test(run) && HAS_LETTER.test(run) ? '<token>' : run,
  );
}

/**
 * Redacts a test title. Titles are the row identity (`full_title`), so they
 * get only the rules that cannot match an ordinary identifier.
 */
export function redactTitle(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return enabled(env) ? titleRules(text, env) : text;
}

/** A `reason:<text>` tag carries a skip message, so it gets the full text rules. */
export function redactTag(
  tag: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return tag.startsWith('reason:')
    ? `reason:${redactText(tag.slice('reason:'.length), env)}`
    : tag;
}

/**
 * The pass every pushed row goes through in buildPayload, whichever path built
 * it. `errorField` already redacted message and stack before truncating, with
 * `process.env`; this pass applies the caller's env, which
 * `canary testtracker push` resolves on its own. Idempotent.
 */
export function redactEntry(
  r: ResultEntry,
  env: NodeJS.ProcessEnv = process.env,
): ResultEntry {
  return {
    ...r,
    full_title: redactTitle(r.full_title, env),
    tags: r.tags.map((t) => redactTag(t, env)),
    ...(r.error_message !== undefined
      ? { error_message: redactText(r.error_message, env) }
      : {}),
    ...(r.error_stack !== undefined
      ? { error_stack: redactText(r.error_stack, env) }
      : {}),
  };
}

/**
 * Redacts the catalog and collapses titles that now read the same into one
 * entry (tags merged): the dashboard keys the catalog by title too.
 */
export function redactCatalog(
  entries: CollectedEntry[],
  env: NodeJS.ProcessEnv = process.env,
): CollectedEntry[] {
  const byTitle = new Map<string, CollectedEntry>();
  for (const c of entries) {
    const full_title = redactTitle(c.full_title, env);
    const tags = c.tags.map((t) => redactTag(t, env));
    const prior = byTitle.get(full_title);
    byTitle.set(
      full_title,
      prior
        ? { ...prior, tags: [...new Set([...prior.tags, ...tags])] }
        : { ...c, full_title, tags },
    );
  }
  return [...byTitle.values()];
}
