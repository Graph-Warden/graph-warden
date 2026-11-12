import { canRead, createGraph, retrieve, type Graph, type Principal, type Scope } from "@graph-warden/core";
import type { RetrievalCases } from "./eval.js";

// Leak measurement (issue #88): the retrieval set read by every principal the corpus's own scopes
// imply. Two things count as a leak. A node outside the reader's scope, returned. And a result
// that moves when the nodes the reader cannot read are taken away, which is how an id, a count or
// an order gives one of them away. The second is the stronger property: the traversal property
// tests check it on random graphs, and this runs it on a corpus the project did not write.

export interface LeakCheck {
  readonly principal: string;
  readonly query: string;
  // Returned nodes the principal cannot read.
  readonly outside: readonly string[];
  // Nodes whose place in the results depends on nodes the principal cannot read.
  readonly drift: readonly string[];
}

export interface LeakReport {
  readonly nodes: number;
  readonly principals: readonly string[];
  readonly queries: number;
  // Only the checks that found something, so that an empty list is the result worth publishing.
  readonly found: readonly LeakCheck[];
}

// What a search returns, by id, already cut to k. It takes the graph, so that the same search runs
// on the readable part: the comparison between the two is the measurement.
export type LeakSearch = (graph: Graph, principal: Principal, query: string) => readonly string[];

// The search `search` and `ask` use, as the harness sees it.
export const retrieveSearch =
  (k: number): LeakSearch =>
  (graph, principal, query) =>
    retrieve(graph, principal, query, { limit: k }).map((node) => node.id);

// The graph as one principal sees it: the nodes they read, and the edges between them.
export function readablePart(graph: Graph, principal: Principal): Graph {
  const nodes = [...graph.nodes.values()].filter((node) => canRead(principal, node.scope));
  const kept = new Set(nodes.map((node) => node.id));
  return createGraph(
    nodes,
    graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
  );
}

const teamsOf = (scope: Scope): readonly string[] => (scope.kind === "team" ? [scope.team] : scope.kind === "teams" ? scope.teams : []);

export const label = (principal: Principal): string => `${principal.user} [${[...principal.teams].sort().join(", ") || "no team"}]`;

// The principals a corpus implies: nobody, each team on its own, each person holding a private
// node, and someone in every team. Every boundary the corpus draws is read from both sides, which
// is what a corpus with real groups has and a corpus without them cannot.
export function principalsOf(graph: Graph): { principals: Principal[]; teams: string[]; users: string[] } {
  const teams = new Set<string>();
  const users = new Set<string>();
  for (const node of graph.nodes.values()) {
    for (const team of teamsOf(node.scope)) teams.add(team);
    if (node.scope.kind === "private") users.add(node.scope.user);
  }
  const sortedTeams = [...teams].sort();
  const sortedUsers = [...users].sort();
  const principals: Principal[] = [
    { user: "outsider", teams: [] },
    ...sortedTeams.map((team) => ({ user: `member-of-${team}`, teams: [team] })),
    ...sortedUsers.map((user) => ({ user, teams: [] })),
  ];
  if (sortedTeams.length > 0) principals.push({ user: "member-of-every-team", teams: sortedTeams });
  return { principals, teams: sortedTeams, users: sortedUsers };
}

export function runLeakEval(graph: Graph, cases: RetrievalCases, principals: readonly Principal[], search: LeakSearch): LeakReport {
  const found: LeakCheck[] = [];
  for (const principal of principals) {
    const view = readablePart(graph, principal);
    for (const { id, query } of cases.queries) {
      const got = search(graph, principal, query);
      const expected = search(view, principal, query);
      const outside = got.filter((node) => {
        const stored = graph.nodes.get(node);
        return stored === undefined || !canRead(principal, stored.scope);
      });
      // Both directions: a result the readable graph would give and the full one does not, and the
      // reverse. Either means a node the reader cannot see has moved their results.
      const drift = [...got.filter((node) => !expected.includes(node)), ...expected.filter((node) => !got.includes(node))];
      if (outside.length > 0 || drift.length > 0) found.push({ principal: label(principal), query: id, outside, drift });
    }
  }
  return { nodes: graph.nodes.size, principals: principals.map(label), queries: cases.queries.length, found };
}
