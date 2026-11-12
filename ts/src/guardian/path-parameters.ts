/**
 * Effective OpenAPI operation parameters (#1290), split out of
 * `diff-extractor.ts` so that file stays under the perf ratchet's line limit.
 */

/** `name`+`in` identity of a parameter object; null for a `$ref` or malformed one. */
function paramIdentity(param: unknown): string | null {
  if (typeof param !== 'object' || param === null) return null;
  const { name, in: location } = param as Record<string, unknown>;
  if (typeof name !== 'string' || typeof location !== 'string') return null;
  return JSON.stringify([name, location]);
}

/**
 * The operation as consumers see it: OpenAPI applies path-item `parameters`
 * to every operation on the path, and an operation parameter with the same
 * `name` + `in` overrides the path-level one. The merged list puts the
 * surviving path-level parameters first, then the operation's own. An
 * operation on a path with no path-level parameters is returned unchanged.
 */
export function withPathParameters(
  op: Record<string, unknown>,
  shared: unknown,
): Record<string, unknown> {
  if (!Array.isArray(shared) || shared.length === 0) return op;
  const own: unknown[] = Array.isArray(op['parameters'])
    ? op['parameters']
    : [];
  const overridden = new Set(own.map(paramIdentity).filter((k) => k !== null));
  const inherited = shared.filter((p) => {
    const key = paramIdentity(p);
    return key === null || !overridden.has(key);
  });
  return { ...op, parameters: [...inherited, ...own] };
}
