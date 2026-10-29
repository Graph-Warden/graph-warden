import type { Edge, Node } from "./ontology.js";
import type { Graph } from "./traversal.js";

// Port for graph persistence (proposal 0009). Adapters store and return nodes as they are; they
// never filter by scope. Reads go through the domain (`traverse`), which applies the scopes.

export interface GraphStore {
  // Idempotent on the node id and on (type, from, to) for edges.
  upsertNodes(nodes: readonly Node[]): Promise<void>;
  upsertEdges(edges: readonly Edge[]): Promise<void>;
  getNode(id: string): Promise<Node | undefined>;
  // Removes the node and its edges.
  deleteNode(id: string): Promise<void>;
  // The whole graph, for the domain to traverse. Replaced by per-hop neighbour lookups when
  // graphs outgrow memory.
  snapshot(): Promise<Graph>;
}
