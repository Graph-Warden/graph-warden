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

// The scope of a node derived from sources whose scopes are `sources`, narrowed from `current`:
// what deriveScope gives, without an author to check. Sources private to different users leave
// nobody who reads them all: the node goes private to the user of its own private scope, or of
// its first private source. Its content stays with someone who read part of it, never wider.
export function narrowed(current: Scope, sources: readonly Scope[]): Scope {
  const all = [current, ...sources];
  const privateTo = all.filter((scope) => scope.kind === "private").map((scope) => (scope as { user: string }).user);
  if (privateTo.length > 0) return { kind: "private", user: current.kind === "private" ? current.user : (privateTo[0] ?? "") };
  const teams = all.flatMap(requiredTeams);
  return teams.length === 0 ? { kind: "shared" } : teamsScope(teams);
}

// After the scopes of `changed` nodes were written, the nodes derived from them, directly or
// through others, narrowed to what their sources allow now: a source made narrower must not leave
// a summary of it readable by those who lost access. Returns only the nodes whose scope changes.
// Derivation never widens: a source made wider leaves its derived nodes as they are.
export function narrowDependents(graph: Graph, changed: readonly string[]): Node[] {
  const dependents = new Map<string, string[]>();
  for (const edge of graph.edges) if (edge.type === "DERIVED_FROM") dependents.set(edge.to, [...(dependents.get(edge.to) ?? []), edge.from]);
  const scopes = new Map<string, Scope>();
  const scopeOf = (id: string) => scopes.get(id) ?? graph.nodes.get(id)?.scope;
  const updated = new Map<string, Node>();
  const queue = [...changed];
  for (let steps = 0; queue.length > 0; steps++) {
    // Each pass can only narrow, and scopes are finite: a cycle settles.
    if (steps > 10 * (graph.nodes.size + 1)) throw new Error("DERIVED_FROM forms a cycle that does not settle");
    const id = queue.shift() as string;
    for (const dependent of dependents.get(id) ?? []) {
      const node = graph.nodes.get(dependent);
      const current = scopeOf(dependent);
      if (node === undefined || current === undefined) continue;
      const sources = graph.edges
        .filter((edge) => edge.type === "DERIVED_FROM" && edge.from === dependent)
        .map((edge) => scopeOf(edge.to))
        .filter((scope): scope is Scope => scope !== undefined);
      const next = narrowed(current, sources);
      if (formatScope(next) === formatScope(current)) continue;
      scopes.set(dependent, next);
      updated.set(dependent, { ...node, scope: next });
      queue.push(dependent);
    }
  }
  return [...updated.values()];
}

// The sources of what a node's text holds: its own and those of everything it derives from, at any
// distance (issue #28). A filed answer's provenance is the asker, yet its text comes from the
// documents read: routing by the node's own source alone would send them out through it.
export function contentSources(graph: Graph, nodes: readonly Node[]): readonly string[] {
  const seen = new Set(nodes.map((node) => node.id));
  const sources = new Set(nodes.flatMap((node) => [node.provenance.source, ...(node.heldSources ?? [])]));
  const pending = [...seen];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const edge of graph.edges) {
      if (edge.type !== "DERIVED_FROM" || edge.from !== id || seen.has(edge.to)) continue;
      seen.add(edge.to);
      pending.push(edge.to);
      const source = graph.nodes.get(edge.to);
      if (source !== undefined) for (const name of [source.provenance.source, ...(source.heldSources ?? [])]) sources.add(name);
    }
  }
  return [...sources];
}
