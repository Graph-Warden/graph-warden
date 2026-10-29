import { z } from "zod";
import type { Node } from "./ontology.js";
import { canRead, type Principal, type Scope } from "./scope.js";
import type { Graph } from "./traversal.js";

// Teams form a tree, like an organisation chart (proposal 0010). A team reads its own nodes and
// those of every team below it; a team below reads only its own. A team the organisation does not
// list is a top-level team with nothing below it, so an empty organisation is the flat model.

// Each team mapped to its parent, or to null for a top-level team.
export const OrganisationSchema = z.record(z.string().min(1), z.string().min(1).nullable());

export interface Organisation {
  readonly parents: ReadonlyMap<string, string>;
}

export function createOrganisation(parents: z.input<typeof OrganisationSchema> = {}): Organisation {
  const map = new Map<string, string>();
  for (const [team, parent] of Object.entries(OrganisationSchema.parse(parents))) {
    if (parent === null) continue;
    if (!(parent in parents)) throw new Error(`Team ${team} has an unknown parent: ${parent}`);
    map.set(team, parent);
  }
  const org = { parents: map };
  // A cycle would make a team its own ancestor, and every team in it readable by all the others.
  for (const team of map.keys()) ancestry(org, team);
  return org;
}

// The team followed by its parent, grandparent… up to its top-level team.
export function ancestry(org: Organisation, team: string): readonly string[] {
  const chain = [team];
  for (let parent = org.parents.get(team); parent !== undefined; parent = org.parents.get(parent)) {
    if (chain.includes(parent)) throw new Error(`Teams form a cycle: ${[...chain, parent].join(" -> ")}`);
    chain.push(parent);
  }
  return chain;
}

// The principal of a user who belongs to `memberOf`: their teams become every team they may read,
// that is those teams and all the teams below them. Scopes are then checked with plain `canRead`.
export function resolvePrincipal(org: Organisation, user: string, memberOf: readonly string[]): Principal {
  const teams = new Set(memberOf);
  for (const team of org.parents.keys()) {
    if (ancestry(org, team).some((t) => memberOf.includes(t))) teams.add(team);
  }
  return { user, teams: [...teams] };
}

// The scope of a node derived from `sources` on behalf of `author` (proposal 0010): the widest
// scope whose readers can read every source, never wider than the node's own `declared` scope.
// - `shared` adds no restriction.
// - Two teams give their nearest common ancestor: whoever reads it reads both. Teams without a
//   common ancestor give `private:<author>`.
// - Anything private gives `private:<author>`.
// The author must be able to read every source: nobody derives from what they cannot see. The
// node's own content is the author's, so the author may read the result even when the declared
// scope is a team they are not in; a declared scope private to someone else is refused.
export function deriveScope(org: Organisation, author: Principal, declared: Scope, sources: readonly Scope[]): Scope {
  for (const source of sources) {
    if (!canRead(author, source)) throw new Error(`${author.user} cannot read a source scoped ${format(source)}`);
  }
  if (declared.kind === "private" && declared.user !== author.user) {
    throw new Error(`${author.user} cannot derive into ${format(declared)}`);
  }
  return sources.reduce((scope, source) => narrowest(org, author, scope, source), declared);
}

function narrowest(org: Organisation, author: Principal, a: Scope, b: Scope): Scope {
  if (a.kind === "shared") return b;
  if (b.kind === "shared") return a;
  if (a.kind === "team" && b.kind === "team") {
    const above = new Set(ancestry(org, a.team));
    const common = ancestry(org, b.team).find((team) => above.has(team));
    if (common !== undefined) return { kind: "team", team: common };
  }
  return { kind: "private", user: author.user };
}

// The nodes `ids` with the scope derived from their `DERIVED_FROM` targets, following chains of
// derivation. Nodes without a `DERIVED_FROM` edge are returned unchanged.
export function deriveScopes(graph: Graph, org: Organisation, author: Principal, ids: readonly string[]): Node[] {
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
      sources.length === 0
        ? node
        : { ...node, scope: deriveScope(org, author, node.scope, sources.map((s) => s.scope)) };
    derived.set(id, result);
    return result;
  };
  return ids.map(resolve);
}

function format(scope: Scope): string {
  return scope.kind === "team" ? `team:${scope.team}` : scope.kind === "private" ? `private:${scope.user}` : "shared";
}
