/**
 * Turning a Supabase `{ data, error }` pair into a value or a throw (#1057).
 *
 * `supabase-js` does not throw on a failed request. It resolves to
 * `{ data: null, error }` and leaves the verdict entirely to the caller, so the
 * idiomatic-looking `const { data } = await query` silently discards the only
 * evidence that nothing was measured. In the history store that made an expired
 * JWT, a dropped connection and a genuinely empty table produce one identical
 * answer — and that answer was the reassuring one: no flaky tests, clean
 * history, run recorded. A zero denominator is an abstention, not a pass.
 *
 * Lives in `util` rather than beside its caller so the rule is stated once for
 * any future Supabase-backed store, and so the rationale is not duplicated at
 * each call site.
 */

/**
 * The result shape every supabase-js call resolves to.
 *
 * Declared here rather than imported because the SDK's own result types are
 * generic over the table schema, which these stores do not model.
 */
export interface SupabaseResult<T> {
  data: T | null;
  error: { message?: string; code?: string } | null;
}

/**
 * Return `data`, or throw if the request failed.
 *
 * @param table Named in the message so a failure points at a place rather than
 *              at the store in general.
 * @throws If `error` is non-null. The message carries the table, the PostgREST
 *         code when present, and the server's own text — never the credential.
 */
export function unwrap<T>(table: string, result: SupabaseResult<T>): T | null {
  const { data, error } = result;
  if (error) {
    const code = error.code ? ` [${error.code}]` : '';
    const detail = error.message ?? 'no message';
    throw new Error(`Supabase request on "${table}" failed${code}: ${detail}`);
  }
  return data;
}

/**
 * Resolve the Supabase project URL. A plain `https://…` url passes through; a
 * `postgresql+asyncpg://user:pass@host/db` url yields `https://<host>`. Never
 * returns the raw connection string (it embeds credentials). Pure + exported
 * for direct parity testing against Python `_parse_project_url`.
 */
export function parseProjectUrl(dbUrl: string): string {
  if (dbUrl.startsWith('https://')) return dbUrl;
  try {
    const host = new URL(dbUrl).hostname;
    return `https://${host}`;
  } catch {
    return '<redacted-unparseable-url>';
  }
}

/**
 * Return the anon key, or throw if none is configured.
 *
 * It used to default to `''`, which `createClient` accepts — so the store
 * built fine and every request then failed auth at the server, where the old
 * coalescing (see `unwrap`) turned that failure back into a clean empty
 * result. Failing here makes the missing credential the reported problem.
 *
 * @throws If `SUPABASE_ANON_KEY` is unset or blank. The message never echoes
 *         the value it rejected.
 */
export function requireAnonKey(): string {
  const key = (process.env.SUPABASE_ANON_KEY ?? '').trim();
  if (key === '') {
    throw new Error(
      'SUPABASE_ANON_KEY is not set (or is blank), so the history store ' +
        'cannot authenticate. Set it, or pass a client explicitly.',
    );
  }
  return key;
}
