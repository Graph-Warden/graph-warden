import type { Edge, EdgeType, Node } from "./ontology.js";
import { canRead, type Principal } from "./scope.js";

// Traversal with the reader's scopes checked on every hop (proposal 0003): a node the principal
// cannot read is neither returned nor crossed, so it cannot reveal what lies behind it. An
// unreadable start behaves like an unknown one.

export interface Graph {
  readonly nodes: ReadonlyMap<string, Node>;
  readonly edges: readonly Edge[];
}

export function createGraph(nodes: readonly Node[], edges: readonly Edge[]): Graph {
  const byId = new Map<string, Node>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    byId.set(node.id, node);
  }
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      throw new Error(`Edge ${edge.type} ${edge.from} -> ${edge.to} references an unknown node`);
    }
  }
  return { nodes: byId, edges };
}

export interface TraversalOptions {
  readonly direction?: "out" | "in" | "both";
  readonly edgeTypes?: readonly EdgeType[];
  readonly maxDepth?: number;
}

// Nodes reachable from `start`, nearest first, without `start` itself.
export function traverse(
  graph: Graph,
  principal: Principal,
  start: string,
  options: TraversalOptions = {},
): readonly Node[] {
  const { direction = "out", edgeTypes, maxDepth = Infinity } = options;
  const readable = (id: string): Node | undefined => {
    const node = graph.nodes.get(id);
    return node !== undefined && canRead(principal, node.scope) ? node : undefined;
  };
  if (readable(start) === undefined) return [];

  const neighbours = (id: string): string[] =>
    graph.edges
      .filter((edge) => edgeTypes === undefined || edgeTypes.includes(edge.type))
      .flatMap((edge) => {
        const next: string[] = [];
        if (direction !== "in" && edge.from === id) next.push(edge.to);
        if (direction !== "out" && edge.to === id) next.push(edge.from);
        return next;
      });

  const visited = new Set([start]);
  const reached: Node[] = [];
  let frontier = [start];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of neighbours(id)) {
        if (visited.has(neighbour)) continue;
        const node = readable(neighbour);
        if (node === undefined) continue;
        visited.add(neighbour);
        reached.push(node);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return reached;
}
