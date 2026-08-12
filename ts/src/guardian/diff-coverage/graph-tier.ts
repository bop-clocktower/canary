/**
 * Tier 2 — coverage derived from the harness knowledge graph
 * (`GRAPH_VERIFIED`). Reads the NDJSON `.harness/graph/graph.json` directly;
 * no agent/LLM module and no `analyze_diff`/`get_impact` MCP tool is involved
 * (SC-11 boundary).
 */

import { existsSync, readFileSync } from 'node:fs';

import { isTestPath } from './paths.js';
import {
  isRecord,
  makeResult,
  pathBoundaryMatch,
  splitLines,
  Fidelity,
  type ChangedUnit,
  type CoverageResult,
} from './types.js';

// Edge types that indicate a test exercises a source unit. The live graph
// carries no explicit `tests`/`covers` edge, so coverage is *derived* from
// calls/imports reach.
const REACH_EDGE_TYPES = new Set(['calls', 'imports']);

/** The three adjacency views a coverage walk needs over one graph file. */
interface GraphIndex {
  idToPath: Map<string, string>;
  containsFwd: Map<string, string[]>;
  /** `to -> [from]` over calls/imports. */
  reachRev: Map<string, string[]>;
}

/**
 * Tier 2: derive coverage from the harness knowledge graph (`GRAPH_VERIFIED`).
 *
 * The graph has no explicit `tests`/`covers` edge, so coverage is **derived**:
 * a changed file is graph-covered iff some **test-path node** reaches the
 * file's node (or a symbol node it `contains`) via a `calls`/`imports` edge.
 * Conservative by design (edge present → covered).
 *
 * `maxDepth` bounds the reverse-BFS hop distance from the changed unit's
 * node(s) to the covering test node (#320). The changed unit's nodes are depth
 * 0; their direct predecessors are depth 1; one hop of indirection is depth 2;
 * and so on. `maxDepth=1` requires a DIRECT test→source edge; `maxDepth=null`
 * is unbounded (today's behavior, byte-for-byte unchanged).
 *
 * Reads the NDJSON `graph.json` directly. Missing/empty graph → `null` (never
 * blocks).
 */
export function resolveFromGraph(
  units: ChangedUnit[],
  graphPath = '.harness/graph/graph.json',
  maxDepth: number | null = null,
): CoverageResult[] | null {
  const graph = readGraph(graphPath);
  if (graph === null) return null;

  // Index file/symbol node ids by path (exact + suffix match support).
  const pathToIds = new Map<string, string[]>();
  for (const [nodeId, nodePath] of graph.idToPath) {
    if (nodePath) push(pathToIds, nodePath, nodeId);
  }

  const results: CoverageResult[] = [];
  for (const unit of units) {
    // Target set: the file node(s) for this unit + all symbols they contain.
    const seedIds = idsForPath(pathToIds, unit.path);
    if (seedIds.length === 0) {
      // Unit has no node in the graph → no graph signal. Emit nothing so the
      // orchestrator falls through to the heuristic tier (FIX 2).
      continue;
    }
    const targets = containedClosure(graph.containsFwd, seedIds);
    const coveringTest = findCoveringTest(graph, targets, maxDepth);

    const covered = coveringTest !== null;
    const evidence = covered
      ? `reached by test ${coveringTest}`
      : `no test node reaches ${unit.path} via calls/imports`;
    results.push(
      makeResult({
        unit,
        covered,
        fidelity: Fidelity.GraphVerified,
        evidence,
      }),
    );
  }
  return results;
}

/** Read the NDJSON graph into its adjacency views; `null` if unusable. */
function readGraph(graphPath: string): GraphIndex | null {
  let text: string;
  try {
    if (!existsSync(graphPath)) return null;
    // ACCEPTED DIVERGENCE: Python's `read_text(encoding="utf-8")` here can raise
    // an UNCAUGHT `UnicodeDecodeError` on a non-UTF-8 graph (the Python only
    // catches `OSError`) — a latent crash that violates the guardian's "absence
    // never blocks" contract. Node's `readFileSync(path, 'utf-8')` substitutes
    // U+FFFD instead of throwing; a replacement char inside a line just fails
    // that line's `JSON.parse` and is skipped. We intentionally KEEP the safe
    // degrade rather than reproduce the crash.
    text = readFileSync(graphPath, 'utf-8');
  } catch {
    return null;
  }
  if (text.trim() === '') return null;

  const graph: GraphIndex = {
    idToPath: new Map(),
    containsFwd: new Map(),
    reachRev: new Map(),
  };
  for (const raw of splitLines(text)) {
    const record = parseRecord(raw);
    if (record === null) continue;
    if (record['kind'] === 'node') addNode(graph, record);
    else if (record['kind'] === 'edge') addEdge(graph, record);
  }
  return graph.idToPath.size === 0 ? null : graph;
}

/** One NDJSON line as an object record, or `null` if it is neither. */
function parseRecord(raw: string): Record<string, unknown> | null {
  const line = raw.trim();
  if (!line) return null;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  // Valid JSON but not an object (e.g. `null`, `5`, `[1,2]`, `"x"`) → not a
  // node/edge record; skip it rather than crash on `.get` (FIX 3).
  return isRecord(record) ? record : null;
}

function addNode(graph: GraphIndex, record: Record<string, unknown>): void {
  const nodeId = record['id'];
  if (nodeId === undefined || nodeId === null) return;
  const p = record['path'];
  graph.idToPath.set(String(nodeId), typeof p === 'string' ? p : '');
}

function addEdge(graph: GraphIndex, record: Record<string, unknown>): void {
  const etype = record['type'];
  const src = record['from'];
  const dst = record['to'];
  if (src === undefined || src === null || dst === undefined || dst === null) {
    return;
  }
  const from = String(src);
  const to = String(dst);
  if (etype === 'contains') push(graph.containsFwd, from, to);
  else if (typeof etype === 'string' && REACH_EDGE_TYPES.has(etype)) {
    push(graph.reachRev, to, from);
  }
}

/** Node ids for `path`; ambiguous suffix matches deliberately resolve to none. */
function idsForPath(pathToIds: Map<string, string[]>, path: string): string[] {
  const exact = pathToIds.get(path);
  if (exact !== undefined) return exact;
  // Boundary suffix match only; on a unique matched path use its ids. On
  // multiple distinct matched paths (duplicate basenames) treat as ambiguous
  // and return no ids — do NOT union unrelated nodes (FIX 6).
  const matchedPaths: string[] = [];
  for (const nodePath of pathToIds.keys()) {
    if (pathBoundaryMatch(nodePath, path)) matchedPaths.push(nodePath);
  }
  return matchedPaths.length === 1 ? pathToIds.get(matchedPaths[0]!)! : [];
}

/** The seed nodes plus everything they transitively `contains`. */
function containedClosure(
  containsFwd: Map<string, string[]>,
  seedIds: string[],
): Set<string> {
  const targets = new Set<string>(seedIds);
  const frontier = [...targets];
  while (frontier.length > 0) {
    const node = frontier.pop()!;
    for (const child of containsFwd.get(node) ?? []) {
      if (!targets.has(child)) {
        targets.add(child);
        frontier.push(child);
      }
    }
  }
  return targets;
}

/**
 * Reverse-BFS over calls/imports; the first reached test-path node wins.
 *
 * FIX 1 (#320): a genuine FIFO BFS so first-discovery depth is the minimum;
 * a LIFO stack could stamp an intermediate node at a non-minimal depth and
 * prune it before a shorter path arrives, under-crediting coverage at
 * maxDepth >= 3.
 */
function findCoveringTest(
  graph: GraphIndex,
  targets: Set<string>,
  maxDepth: number | null,
): string | null {
  const walk: Walk = {
    graph,
    targets,
    seen: new Set<string>(targets),
    queue: [...targets].map((t) => [t, 0]),
  };
  let head = 0;
  while (head < walk.queue.length) {
    const [node, depth] = walk.queue[head++]!;
    if (maxDepth !== null && depth >= maxDepth) {
      continue; // cannot expand deeper — predecessors would exceed bound
    }
    const found = enqueuePredecessors(walk, node, depth);
    if (found !== null) return found;
  }
  return null;
}

/** The mutable state one reverse-BFS carries between its steps. */
interface Walk {
  graph: GraphIndex;
  targets: Set<string>;
  seen: Set<string>;
  queue: Array<[string, number]>;
}

/**
 * Enqueue every unseen predecessor of `node`, returning the path of the first
 * one that is a test (which ends the walk).
 */
function enqueuePredecessors(
  walk: Walk,
  node: string,
  depth: number,
): string | null {
  const predecessors = walk.graph.reachRev.get(node);
  if (predecessors === undefined) return null;
  for (const source of predecessors) {
    if (walk.seen.has(source)) continue;
    walk.seen.add(source);
    const sourcePath = walk.graph.idToPath.get(source) ?? '';
    if (sourcePath && isTestPath(sourcePath) && !walk.targets.has(source)) {
      return sourcePath; // test reached within maxDepth
    }
    walk.queue.push([source, depth + 1]);
  }
  return null;
}

function push<K>(map: Map<K, string[]>, key: K, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}
