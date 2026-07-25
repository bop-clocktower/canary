/**
 * OpenAPI spec diff extractor.
 *
 * Faithful TypeScript port of `agent/guardian/diff_extractor.py`. Compares two
 * OpenAPI specs (before/after a commit) and produces a structured list of
 * added, removed, and changed endpoints.
 *
 * Input: parsed objects (from JSON.parse or a YAML loader).
 * Output: an `ApiDiff` with three lists of `EndpointChange`.
 */

/** Python: `ChangeType(str, Enum)`. */
export enum ChangeType {
  ADDED = 'added',
  REMOVED = 'removed',
  CHANGED = 'changed',
}

/**
 * Python: `EndpointChange` dataclass. A class (rather than a bare interface) so
 * the constructor supplies the same field defaults the dataclass does
 * (`operation_id`/`summary` -> "", `before`/`after` -> {}).
 */
export class EndpointChange {
  path: string;
  method: string;
  change_type: ChangeType;
  // `string | null`: mirrors Python `dict.get("operationId", "")` — a MISSING
  // key defaults to "", but a present-null value passes through as `null`.
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

/** Python: `ApiDiff` dataclass. */
export class ApiDiff {
  constructor(
    public added: EndpointChange[],
    public removed: EndpointChange[],
    public changed: EndpointChange[],
  ) {}

  /** Python: `is_empty` property. */
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

/** Collision-free composite key for a (path, method) pair (Python tuple key). */
function opKey(path: string, method: string): string {
  return JSON.stringify([path, method]);
}

/**
 * Python-truthiness for JSON-shaped values: `None`/`undefined`, `false`, `0`,
 * `""`, empty array, and empty object are all falsy (mirrors `if op:`).
 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `a or b`: the fallback wins only when `a` is falsy. */
function pyOr<T>(value: unknown, fallback: T): unknown {
  return pyTruthy(value) ? value : fallback;
}

/** Python `dict.get(key, default)`: default only on a missing key. */
function pyGet(
  obj: Record<string, unknown>,
  key: string,
  fallback: unknown,
): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/**
 * Deep equality mirroring Python `==` on JSON-shaped data: arrays compare
 * order-sensitively, objects compare by key set (order-insensitive), and
 * `None`/`undefined` are interchangeable.
 */
function pyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!pyEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
      if (!pyEqual(ao[key], bo[key])) return false;
    }
    return true;
  }

  return false;
}

function setEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

/**
 * Python: `classify_changes`. Classify a changed OpenAPI operation into the
 * frozen change vocabulary. Returns every applicable category ordered by
 * `VALID_CHANGES`; a change confined to non-contract fields returns [].
 */
export function classifyChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const found = new Set<string>();

  if (!pyEqual(pyOr(before['parameters'], []), pyOr(after['parameters'], []))) {
    found.add('params');
  }
  if (!pyEqual(before['requestBody'], after['requestBody'])) {
    found.add('request-body');
  }
  if (!pyEqual(before['security'], after['security'])) {
    found.add('auth');
  }

  const beforeResp = pyOr(before['responses'], {}) as Record<string, unknown>;
  const afterResp = pyOr(after['responses'], {}) as Record<string, unknown>;
  const beforeKeys = new Set(Object.keys(beforeResp));
  const afterKeys = new Set(Object.keys(afterResp));
  if (!setEqual(beforeKeys, afterKeys)) {
    found.add('status-codes');
  }
  for (const code of beforeKeys) {
    if (afterKeys.has(code) && !pyEqual(beforeResp[code], afterResp[code])) {
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

/**
 * Python: `_iter_operations`. Insertion-ordered to match Python's dict
 * iteration order.
 */
function iterOperations(spec: Record<string, unknown>): Map<string, Operation> {
  const result = new Map<string, Operation>();
  const paths = pyOr(spec['paths'], {}) as Record<string, unknown>;
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    const pathItem = pathItemRaw as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (pyTruthy(op)) {
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

/**
 * Python: `extract_api_diff`. Compare two OpenAPI spec objects and return the
 * diff.
 */
export function extractApiDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ApiDiff {
  const beforeOps = iterOperations(before);
  const afterOps = iterOperations(after);

  const added: EndpointChange[] = [];
  const removed: EndpointChange[] = [];
  const changed: EndpointChange[] = [];

  for (const [key, { path, method, op }] of afterOps) {
    if (!beforeOps.has(key)) {
      added.push(
        new EndpointChange({
          path,
          method,
          change_type: ChangeType.ADDED,
          operation_id: pyGet(op, 'operationId', '') as string | null,
          summary: pyGet(op, 'summary', '') as string | null,
          after: op,
        }),
      );
    } else {
      const beforeOp = beforeOps.get(key)!.op;
      if (!pyEqual(op, beforeOp)) {
        changed.push(
          new EndpointChange({
            path,
            method,
            change_type: ChangeType.CHANGED,
            operation_id: pyGet(
              op,
              'operationId',
              pyGet(beforeOp, 'operationId', ''),
            ) as string | null,
            summary: pyGet(op, 'summary', '') as string | null,
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
          operation_id: pyGet(op, 'operationId', '') as string | null,
          summary: pyGet(op, 'summary', '') as string | null,
          before: op,
        }),
      );
    }
  }

  return new ApiDiff(added, removed, changed);
}
