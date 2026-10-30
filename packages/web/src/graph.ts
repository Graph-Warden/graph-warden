import type { Delta, Edge, EdgeType, Node, NodeType, Scope } from "@graph-warden/core";

// The part of the graph the signed-in user may read, as pulled from the API (proposal 0006): the
// app never filters by scope, it only holds what the API sent. Deltas apply as in the CLI cache.

export interface Store {
  readonly nodes: ReadonlyMap<string, Node>;
  readonly edges: readonly Edge[];
  readonly cursor: number;
}

export const empty: Store = { nodes: new Map(), edges: [], cursor: 0 };

const touches = (edge: Edge, ids: ReadonlySet<string>) => ids.has(edge.from) || ids.has(edge.to);

// A delta carries every readable edge of the nodes it sends, so theirs are replaced; removed nodes
// go with their edges.
export function applyDelta(store: Store, delta: Delta): Store {
  const nodes = new Map(store.nodes);
  for (const id of delta.removed) nodes.delete(id);
  for (const node of delta.nodes) nodes.set(node.id, node);
  const replaced = new Set([...delta.removed, ...delta.nodes.map((node) => node.id)]);
  const key = (e: Edge) => `${e.type} ${e.from} ${e.to}`;
  const edges = new Map<string, Edge>();
  for (const edge of store.edges) if (!touches(edge, replaced)) edges.set(key(edge), edge);
  for (const edge of delta.edges) if (nodes.has(edge.from) && nodes.has(edge.to)) edges.set(key(edge), edge);
  return { nodes, edges: [...edges.values()], cursor: delta.cursor };
}

export interface Relation {
  readonly type: EdgeType;
  readonly node: Node;
}

export const outgoing = (store: Store, id: string): Relation[] =>
  store.edges.flatMap((e) => (e.from === id && store.nodes.has(e.to) ? [{ type: e.type, node: store.nodes.get(e.to) as Node }] : []));

export const incoming = (store: Store, id: string): Relation[] =>
  store.edges.flatMap((e) => (e.to === id && store.nodes.has(e.from) ? [{ type: e.type, node: store.nodes.get(e.from) as Node }] : []));

// As in core's ontology (a test checks they agree), which the browser cannot import.
export const NODE_TYPES = [
  "Source",
  "Change",
  "Module",
  "Endpoint",
  "Decision",
  "Concept",
  "Incident",
  "Team",
  "Person",
  "Session",
] as const satisfies readonly NodeType[];

export const nameOf = (node: Node) => node.title ?? node.id;

// As in core, whose entry point the browser cannot load (it needs node:crypto).
export function formatScope(scope: Scope): string {
  switch (scope.kind) {
    case "shared":
      return "shared";
    case "team":
      return `team:${scope.team}`;
    case "teams":
      return `teams:${scope.teams.join(",")}`;
    case "private":
      return `private:${scope.user}`;
  }
}

// Nodes whose id, title or text contain every word of the query, title and id matches first.
export function filterNodes(store: Store, query: string): Node[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  const all = [...store.nodes.values()].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  if (words.length === 0) return all;
  const named = (n: Node) => `${n.id} ${n.title ?? ""}`.toLowerCase();
  return all
    .filter((n) => words.every((w) => `${named(n)} ${(n.body ?? "").toLowerCase()}`.includes(w)))
    .sort((a, b) => Number(words.every((w) => named(b).includes(w))) - Number(words.every((w) => named(a).includes(w))));
}

// What the graph view draws: everything, or the nodes within `depth` hops of `focus` either way,
// with the edges between them.
export function neighbourhood(store: Store, focus: string | undefined, depth = 2): { nodes: Node[]; edges: Edge[] } {
  if (focus === undefined) return { nodes: [...store.nodes.values()], edges: [...store.edges] };
  if (!store.nodes.has(focus)) return { nodes: [], edges: [] };
  const kept = new Set([focus]);
  let frontier = [focus];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const edge of store.edges) {
      for (const [here, there] of [
        [edge.from, edge.to],
        [edge.to, edge.from],
      ] as const) {
        if (frontier.includes(here) && !kept.has(there)) {
          kept.add(there);
          next.push(there);
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: [...kept].map((id) => store.nodes.get(id) as Node),
    edges: store.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
  };
}
