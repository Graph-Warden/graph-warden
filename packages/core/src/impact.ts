import type { Node } from "./ontology.js";
import { findRelated, isKnowledge } from "./revalidation.js";
import { canRead, requiredTeams, type Principal } from "./scope.js";
import type { Graph } from "./traversal.js";

// The impact of a pull request (proposal 0005), computed from the graph before and after its
// commits, without writing anything: the endpoints it touches, the modules consuming them, the
// knowledge that may no longer hold, and the teams owning it.
//
// The report is meant to be posted where every reader of the repository sees it, a pull request
// comment: it lists only what `reader` may read, and says nothing, not even a count, of the rest.

export interface Impact {
  readonly endpoints: readonly Node[];
  // Modules consuming a touched endpoint, with the endpoints each one consumes.
  readonly consumers: readonly { readonly module: Node; readonly endpoints: readonly string[] }[];
  readonly knowledge: readonly Node[];
  readonly teams: readonly string[];
}

export function computeImpact(before: Graph, after: Graph, changed: readonly string[], removed: readonly string[], reader: Principal): Impact {
  const at = (id: string) => after.nodes.get(id) ?? before.nodes.get(id);
  const visible = (node: Node | undefined): node is Node => node !== undefined && canRead(reader, node.scope);
  const related = new Set([...findRelated(after, changed).depth.keys(), ...findRelated(before, removed).depth.keys()]);
  const all = [...new Set([...changed, ...removed, ...related])].map(at).filter((node): node is Node => node !== undefined);

  const touched = new Set(all.filter((node) => node.type === "Endpoint").map((node) => node.id));
  const consumed = new Map<string, Set<string>>();
  for (const edge of [...before.edges, ...after.edges]) {
    if (edge.type !== "CONSUMES" || !touched.has(edge.to)) continue;
    if (!visible(at(edge.to))) continue;
    consumed.set(edge.from, (consumed.get(edge.from) ?? new Set()).add(edge.to));
  }

  const byId = (a: Node, b: Node) => a.id.localeCompare(b.id);
  const endpoints = [...touched].map(at).filter(visible).sort(byId);
  const consumers = [...consumed.entries()]
    .map(([id, ids]) => ({ module: at(id), endpoints: [...ids].sort() }))
    .filter((entry): entry is { module: Node; endpoints: string[] } => visible(entry.module))
    .sort((a, b) => byId(a.module, b.module));
  const knowledge = [...related].map(at).filter(visible).filter(isKnowledge).sort(byId);
  const teams = [...new Set([...endpoints, ...consumers.map((c) => c.module), ...knowledge].flatMap((node) => requiredTeams(node.scope)))].sort();
  return { endpoints, consumers, knowledge, teams };
}
