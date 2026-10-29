import type { Node } from "./ontology.js";
import { canRead, formatScope, requiredTeams, teamsScope, type Principal, type Scope } from "./scope.js";
import type { Graph } from "./traversal.js";

// The scope of a node derived from others (`DERIVED_FROM`, proposal 0010): only someone who reads
// every source reads the result.
// - `shared` adds no restriction.
// - Teams add up: a summary of a `bff` page and a `front` page is `teams:bff,front`, read by
//   whoever is in both groups. Who that is (team leads added to both groups, typically) is decided
//   in the identity provider, not here.
// - Anything private gives `private:<author>`.
// The node's declared scope counts as one more source, so derivation never widens it. The author,
// the principal the node is derived for, must read every source: nobody derives from what they
// cannot see. The node's own content is the author's, so a declared scope private to someone else
// is refused.

export function deriveScope(author: Principal, declared: Scope, sources: readonly Scope[]): Scope {
  for (const source of sources) {
    if (!canRead(author, source)) throw new Error(`${author.user} cannot read a source scoped ${formatScope(source)}`);
  }
  if (declared.kind === "private" && declared.user !== author.user) {
    throw new Error(`${author.user} cannot derive into ${formatScope(declared)}`);
  }
  const all = [declared, ...sources];
  if (all.some((scope) => scope.kind === "private")) return { kind: "private", user: author.user };
  const teams = all.flatMap(requiredTeams);
  return teams.length === 0 ? { kind: "shared" } : teamsScope(teams);
}

// The nodes `ids` with the scope derived from their `DERIVED_FROM` targets, following chains of
// derivation. Nodes without a `DERIVED_FROM` edge are returned unchanged.
export function deriveScopes(graph: Graph, author: Principal, ids: readonly string[]): Node[] {
  const derived = new Map<string, Node>();
  const pending = new Set<string>();
  const resolve = (id: string): Node => {
    const done = derived.get(id);
    if (done !== undefined) return done;
    const node = graph.nodes.get(id);
    if (node === undefined) throw new Error(`Unknown node: ${id}`);
    if (pending.has(id)) throw new Error(`DERIVED_FROM forms a cycle through ${id}`);
    pending.add(id);
    const sources = graph.edges.filter((e) => e.type === "DERIVED_FROM" && e.from === id).map((e) => resolve(e.to));
    pending.delete(id);
    const result =
      sources.length === 0 ? node : { ...node, scope: deriveScope(author, node.scope, sources.map((s) => s.scope)) };
    derived.set(id, result);
    return result;
  };
  return ids.map(resolve);
}
