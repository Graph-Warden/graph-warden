import type { AbstractGraph } from "graphology-types";
import type { Edge, Node, NodeType, Scope } from "@graph-warden/core";

// The graph view's model, kept apart from Sigma so that it can be tested (issue #15). The drawn
// graph is updated in place as the readable graph changes: nodes keep their positions, new ones
// start next to their neighbours, so that a live update does not throw the layout away.

export interface NodeLook {
  readonly label: string;
  readonly color: string;
  readonly size: number;
}

export interface Filter {
  // Types shown; all of them when undefined.
  readonly types?: ReadonlySet<NodeType>;
  // Only nodes of this team's scope (`team:x`, or `teams:` naming it).
  readonly team?: string;
}

// The teams a scope names: a filter by team keeps the nodes it names.
export function teamsOf(scope: Scope): readonly string[] {
  return scope.kind === "team" ? [scope.team] : scope.kind === "teams" ? scope.teams : [];
}

export function matches(node: { readonly type: NodeType; readonly scope: Scope }, filter: Filter): boolean {
  if (filter.types !== undefined && !filter.types.has(node.type)) return false;
  return filter.team === undefined || teamsOf(node.scope).includes(filter.team);
}

export const teamsIn = (nodes: Iterable<Node>): string[] => [...new Set([...nodes].flatMap((node) => teamsOf(node.scope)))].sort();

export const edgeKey = (edge: Edge): string => `${edge.type} ${edge.from} ${edge.to}`;

// A stable starting position per id, so that the same graph is laid out the same way each time.
export function seed(id: string): [number, number] {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const angle = ((hash >>> 0) % 3600) / 572.96;
  const radius = 1 + (((hash >>> 12) % 100) / 100) * 9;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

const BULK = 100;

// Makes `graph` hold exactly `nodes` and `edges`; returns the ids of the nodes added.
export function syncGraph(graph: AbstractGraph, nodes: readonly Node[], edges: readonly Edge[], look: (node: Node, degree: number) => NodeLook): string[] {
  const ids = new Set(nodes.map((node) => node.id));
  const keys = new Set(edges.map(edgeKey));
  // Sigma indexes the whole graph again on each node dropped: many at once (a focus on a large
  // graph) are dropped by clearing it and adding back the nodes kept, where they were.
  const kept = new Map<string, { x: number; y: number }>();
  if (graph.filterNodes((id) => !ids.has(id)).length > BULK) {
    graph.forEachNode((id, attributes) => {
      if (ids.has(id)) kept.set(id, { x: attributes.x as number, y: attributes.y as number });
    });
    graph.clear();
  }
  graph.forEachEdge((key) => {
    if (!keys.has(key)) graph.dropEdge(key);
  });
  graph.forEachNode((id) => {
    if (!ids.has(id)) graph.dropNode(id);
  });

  const degree = new Map<string, number>();
  const neighbours = new Map<string, string[]>();
  for (const edge of edges) {
    for (const [here, there] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ] as const) {
      degree.set(here, (degree.get(here) ?? 0) + 1);
      neighbours.set(here, [...(neighbours.get(here) ?? []), there]);
    }
  }
  const added: string[] = [];
  for (const node of nodes) {
    const attributes = { ...look(node, degree.get(node.id) ?? 0), kind: node.type, scope: node.scope };
    if (graph.hasNode(node.id)) {
      graph.mergeNodeAttributes(node.id, attributes);
      continue;
    }
    const before = kept.get(node.id);
    if (before !== undefined) {
      graph.addNode(node.id, { ...attributes, ...before });
      continue;
    }
    // Next to the neighbours already placed, or where its id puts it.
    const placed = (neighbours.get(node.id) ?? []).filter((id) => graph.hasNode(id));
    const [sx, sy] = seed(node.id);
    const [x, y] =
      placed.length === 0
        ? [sx, sy]
        : [
            placed.reduce((sum, id) => sum + (graph.getNodeAttribute(id, "x") as number), 0) / placed.length + sx / 20,
            placed.reduce((sum, id) => sum + (graph.getNodeAttribute(id, "y") as number), 0) / placed.length + sy / 20,
          ];
    graph.addNode(node.id, { ...attributes, x, y });
    added.push(node.id);
  }
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (!graph.hasEdge(key) && graph.hasNode(edge.from) && graph.hasNode(edge.to)) {
      graph.addDirectedEdgeWithKey(key, edge.from, edge.to, { label: edge.type, kind: edge.type });
    }
  }
  return added;
}

// `shown` with every neighbour of `id`, either way.
export function expand(shown: ReadonlySet<string>, edges: readonly Edge[], id: string): Set<string> {
  const next = new Set(shown).add(id);
  for (const edge of edges) {
    if (edge.from === id) next.add(edge.to);
    if (edge.to === id) next.add(edge.from);
  }
  return next;
}
