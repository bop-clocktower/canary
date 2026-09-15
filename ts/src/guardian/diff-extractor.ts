/**
 * OpenAPI spec diff extractor.
 *
 * Compares two OpenAPI specs (before/after a commit) and produces a structured
 * list of added, removed, and changed endpoints.
 *
 * Input: parsed objects (from JSON.parse or a YAML loader).
 * Output: an `ApiDiff` with three lists of `EndpointChange`.
 */

/** How an endpoint differs between the two specs. */
export enum ChangeType {
  ADDED = 'added',
  REMOVED = 'removed',
  CHANGED = 'changed',
}

/**
 * One endpoint's change. A class (rather than a bare interface) so the
 * constructor supplies the field defaults
 * (`operation_id`/`summary` -> "", `before`/`after` -> {}).
 */
export class EndpointChange {
  path: string;
  method: string;
  change_type: ChangeType;
  // `string | null`: a MISSING `operationId` key defaults to "", but a
  // present-null value passes through as `null`.
  operation_id: string | null;
  summary: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;

  constructor(init: {
    path: string;
    method: string;
    change_type: ChangeType;
    operation_id?: string | null;
    summary?: string | null;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  }) {
    this.path = init.path;
    this.method = init.method;
    this.change_type = init.change_type;
    // Default only on undefined (missing key), never on a present null.
    this.operation_id =
      init.operation_id === undefined ? '' : init.operation_id;
    this.summary = init.summary === undefined ? '' : init.summary;
    this.before = init.before === undefined ? {} : init.before;
    this.after = init.after === undefined ? {} : init.after;
  }
}

/** The full diff: added, removed, and changed endpoints. */
export class ApiDiff {
  constructor(
    public added: EndpointChange[],
    public removed: EndpointChange[],
    public changed: EndpointChange[],
  ) {}

  /** True when no endpoint was added, removed, or changed. */
  get isEmpty(): boolean {
    return !(this.added.length || this.removed.length || this.changed.length);
  }
}

const HTTP_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
] as const;

// Frozen vocabulary for a changed endpoint (see
// docs/specs/api-delta-contract.md).
export const VALID_CHANGES = [
  'params',
  'request-body',
  'response',
  'auth',
  'status-codes',
] as const;

/** Collision-free composite key for a (path, method) pair. */
function opKey(path: string, method: string): string {
  return JSON.stringify([path, method]);
}

/**
 * False for `null`/`undefined`, `false`, `0`, `""`, and an empty array or
 * object; true for every other value.
 */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** `value` when {@link isTruthy}, else `fallback`. */
function orDefault<T>(value: unknown, fallback: T): unknown {
  return isTruthy(value) ? value : fallback;
}

/** `obj[key]` when the key is present (even if falsy), else `fallback`. */
function getOrDefault(
  obj: Record<string, unknown>,
  key: string,
  fallback: unknown,
): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/**
 * Deep equality for spec values: arrays by order, objects by key set, null and
 * undefined interchangeable. A boolean never equals a number (#922): a spec's
 * true -> 1 rewrite changes the type consumers see, so it is a change.
 */
function specValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isAbsent(a) || isAbsent(b)) return isAbsent(a) && isAbsent(b);
  if (Array.isArray(a) || Array.isArray(b)) return arrayEqual(a, b);
  return objectEqual(a, b);
}

/** JSON `null`, or a missing key read as `undefined`. */
function isAbsent(value: unknown): boolean {
  return value === null || value === undefined;
}

/** Both arrays, same length, element-wise {@link specValueEqual} in order. */
function arrayEqual(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++)
    if (!specValueEqual(a[i], b[i])) return false;
  return true;
}

/** Both objects, same key set in any order, values {@link specValueEqual}. */
function objectEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const [ao, bo] = [a, b] as Record<string, unknown>[];
  const keys = Object.keys(ao!);
  if (keys.length !== Object.keys(bo!).length) return false;
  return keys.every(
    (k) => Object.hasOwn(bo!, k) && specValueEqual(ao![k], bo![k]),
  );
}

function setEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

/**
 * Classify a changed OpenAPI operation into the frozen change vocabulary.
 * Returns every applicable category ordered by `VALID_CHANGES`; a change
 * confined to non-contract fields returns [].
 */
export function classifyChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const found = new Set<string>();
  const params = (op: Record<string, unknown>) =>
    orDefault(op['parameters'], []);

  if (!specValueEqual(params(before), params(after))) {
    found.add('params');
  }
  if (!specValueEqual(before['requestBody'], after['requestBody'])) {
    found.add('request-body');
  }
  if (!specValueEqual(before['security'], after['security'])) {
    found.add('auth');
  }

  type Responses = Record<string, unknown>;
  const beforeResp = orDefault(before['responses'], {}) as Responses;
  const afterResp = orDefault(after['responses'], {}) as Responses;
  const beforeKeys = new Set(Object.keys(beforeResp));
  const afterKeys = new Set(Object.keys(afterResp));
  if (!setEqual(beforeKeys, afterKeys)) {
    found.add('status-codes');
  }
  for (const code of beforeKeys) {
    if (!afterKeys.has(code)) continue;
    if (!specValueEqual(beforeResp[code], afterResp[code])) {
      found.add('response');
      break;
    }
  }

  return VALID_CHANGES.filter((c) => found.has(c));
}

interface Operation {
  path: string;
  method: string;
  op: Record<string, unknown>;
}

/** Operations keyed by (path, method), in spec insertion order. */
function iterOperations(spec: Record<string, unknown>): Map<string, Operation> {
  const result = new Map<string, Operation>();
  const paths = orDefault(spec['paths'], {}) as Record<string, unknown>;
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    const pathItem = pathItemRaw as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (isTruthy(op)) {
        result.set(opKey(path, method), {
          path,
          method,
          op: op as Record<string, unknown>,
        });
      }
    }
  }
  return result;
}

/** Compare two OpenAPI spec objects and return the diff. */
export function extractApiDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ApiDiff {
  const beforeOps = iterOperations(before);
  const afterOps = iterOperations(after);

  const added: EndpointChange[] = [];
  const removed: EndpointChange[] = [];
  const changed: EndpointChange[] = [];
  type Str = string | null;

  for (const [key, { path, method, op }] of afterOps) {
    if (!beforeOps.has(key)) {
      added.push(
        new EndpointChange({
          path,
          method,
          change_type: ChangeType.ADDED,
          operation_id: getOrDefault(op, 'operationId', '') as Str,
          summary: getOrDefault(op, 'summary', '') as Str,
          after: op,
        }),
      );
    } else {
      const beforeOp = beforeOps.get(key)!.op;
      if (!specValueEqual(op, beforeOp)) {
        const priorId = getOrDefault(beforeOp, 'operationId', '');
        changed.push(
          new EndpointChange({
            path,
            method,
            change_type: ChangeType.CHANGED,
            operation_id: getOrDefault(op, 'operationId', priorId) as Str,
            summary: getOrDefault(op, 'summary', '') as Str,
            before: beforeOp,
            after: op,
          }),
        );
      }
    }
  }

  for (const [key, { path, method, op }] of beforeOps) {
    if (!afterOps.has(key)) {
      removed.push(
        new EndpointChange({
          path,
          method,
          change_type: ChangeType.REMOVED,
          operation_id: getOrDefault(op, 'operationId', '') as Str,
          summary: getOrDefault(op, 'summary', '') as Str,
          before: op,
        }),
      );
    }
  }

  return new ApiDiff(added, removed, changed);
}
