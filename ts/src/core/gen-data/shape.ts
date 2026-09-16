/**
 * The canary term for an extracted value shape (#765). Anything a shape
 * source cannot resolve is an `unresolved` node carrying its reason -- never
 * a guessed shape (spec D7, criterion 6).
 */
export type ShapeNode =
  | {
      kind: 'string';
      minLength?: number;
      maxLength?: number;
      enum?: string[];
    }
  | { kind: 'number'; integer: boolean; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'date'; dateOnly?: true }
  | { kind: 'array'; item: ShapeNode }
  | {
      kind: 'object';
      fields: Record<string, { node: ShapeNode; optional: boolean }>;
    }
  | { kind: 'union'; members: ShapeNode[] }
  | { kind: 'unresolved'; reason: string; typeText: string };

export interface UnresolvedField {
  path: string;
  reason: string;
}
export interface FieldTally {
  fieldsTotal: number;
  fieldsResolved: number;
  unresolved: UnresolvedField[];
}

/** Leaf denominator: objects count their leaves; array items use `[]`. */
export function tallyFields(node: ShapeNode, path: string): FieldTally {
  const tally: FieldTally = {
    fieldsTotal: 0,
    fieldsResolved: 0,
    unresolved: [],
  };
  walk(node, path, tally);
  return tally;
}

function walk(node: ShapeNode, path: string, t: FieldTally): void {
  if (node.kind === 'object') {
    for (const [k, f] of Object.entries(node.fields))
      walk(f.node, `${path}.${k}`, t);
    return;
  }
  if (node.kind === 'array') return walk(node.item, `${path}[]`, t);
  t.fieldsTotal += 1;
  const reason = unresolvedReason(node);
  if (reason === undefined) t.fieldsResolved += 1;
  else t.unresolved.push({ path, reason });
}

export const UNION_REASON = 'union member is not a resolved scalar';
const SCALAR_KINDS = new Set(['string', 'number', 'boolean', 'date']);

/** A union resolves only when it is non-empty and every member is a scalar. */
export function isResolvedUnion(members: ShapeNode[]): boolean {
  return members.length > 0 && members.every((m) => SCALAR_KINDS.has(m.kind));
}

function unresolvedReason(node: ShapeNode): string | undefined {
  if (node.kind === 'unresolved') return node.reason;
  if (node.kind === 'union' && !isResolvedUnion(node.members))
    return UNION_REASON;
  return undefined;
}
