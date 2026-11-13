/**
 * The OpenAPI operation as a consumer sees it (#1290), so the diff compares
 * what changed for callers rather than how the spec happens to be written.
 * Split out of `diff-extractor.ts` so that file stays under the perf ratchet's
 * line limit.
 */
import { withPathParameters } from './path-parameters.js';

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value a local `#/...` JSON pointer names in `root`, else undefined. */
function lookupPointer(root: Obj, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    let token: string;
    try {
      token = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    token = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(node) && !Array.isArray(node)) return undefined;
    if (!Object.hasOwn(node, token)) return undefined;
    node = (node as Obj)[token];
  }
  return node;
}

/**
 * `value` with every resolvable local `$ref` replaced by its target (sibling
 * keys kept alongside). An external, unresolvable, or cyclic `$ref` is left as
 * written, so a recursive schema terminates and still compares by pointer.
 */
export function resolveLocalRefs(
  value: unknown,
  root: Obj,
  expanding: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => resolveLocalRefs(v, root, expanding));
  }
  if (!isObject(value)) return value;
  const ref = value['$ref'];
  if (typeof ref === 'string' && !expanding.has(ref)) {
    const target = lookupPointer(root, ref);
    if (target !== undefined) {
      const inner = new Set(expanding).add(ref);
      const resolved = resolveLocalRefs(target, root, inner);
      const { $ref: _ref, ...siblings } = value;
      if (Object.keys(siblings).length === 0 || !isObject(resolved)) {
        return resolved;
      }
      return {
        ...resolved,
        ...(resolveLocalRefs(siblings, root, inner) as Obj),
      };
    }
  }
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = resolveLocalRefs(v, root, expanding);
  }
  return out;
}

/**
 * The effective operation: local `$ref`s resolved, path-item `parameters`
 * merged in (see {@link withPathParameters}), and the spec's top-level
 * `security` applied when the operation declares none of its own. An explicit
 * operation `security` (even `[]`) overrides the global one, per OpenAPI.
 */
export function effectiveOperation(
  op: Obj,
  sharedParameters: unknown,
  spec: Obj,
): Obj {
  const merged = withPathParameters(
    resolveLocalRefs(op, spec) as Obj,
    resolveLocalRefs(sharedParameters, spec),
  );
  if (Object.hasOwn(merged, 'security') || !Object.hasOwn(spec, 'security')) {
    return merged;
  }
  return { ...merged, security: resolveLocalRefs(spec['security'], spec) };
}
