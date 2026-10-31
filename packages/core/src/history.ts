import { recorder, type AuditLog } from "./audit.js";
import { computeImpact, type Impact } from "./impact.js";
import { changeId, commitText } from "./ingestion.js";
import type { Edge, Node } from "./ontology.js";
import { canRead, requiredTeams, type Principal, type Scope } from "./scope.js";
import type { GraphStore } from "./store.js";
import type { Graph } from "./traversal.js";

// The graph of a repository as it was at a commit, and the impact of a pull request as a subgraph
// (issue #16). Neither is kept anywhere: the event log keeps no content (proposal 0006), so the
// past is ingested again from git, into a copy, as `gwarden impact` does.
//
// A past node is shown only to a reader who may read it both then and now. Then, because a node
// once confidential and shared since was not meant for them at the time, and its old text may say
// what was taken out before sharing it. Now, because a node narrowed since must not reach, through
// its history, a reader it was taken from. A node gone since is judged on the scope it had and on
// the repository's scope, which is what anyone may still read in git.

// Port for the past of the repositories: git, ingested again.
export interface PastGraphs {
  // The repositories whose past may be asked for, with the scope of each.
  readonly repositories: ReadonlyMap<string, { readonly scope: Scope }>;
  // The commits of the repository's branch, newest first, at most `limit`, with their messages.
  commits(repo: string, limit: number): Promise<readonly { readonly sha: string; readonly message: string }[]>;
  // The graph of the repository alone at `sha`; undefined for a commit it does not have.
  at(repo: string, sha: string): Promise<Graph | undefined>;
  // `base`'s graph, and the same with the commits from `base` up to `head` ingested over it, with
  // the nodes they changed or removed. Undefined when either commit is unknown, or when `head`
  // does not descend from `base`.
  between(repo: string, base: string, head: string): Promise<{ readonly before: Graph; readonly after: Graph; readonly changed: readonly string[]; readonly commits: number } | undefined>;
}

export interface PastView {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}

export interface ImpactView extends PastView {
  readonly impact: Impact;
  readonly commits: number;
  // Of `nodes`, those the pull request changes or reaches.
  readonly highlighted: readonly string[];
}

export class UnknownCommit extends Error {
  override readonly name = "UnknownCommit";
}

export interface History {
  readonly repositories: readonly string[];
  // The repository's commits, newest first, as the `Change` nodes the principal may read (those
  // ingested, or as the ingester would write them): what to pick a commit from.
  commits(principal: Principal, repo: string, limit?: number): Promise<readonly Node[]>;
  at(principal: Principal, repo: string, sha: string): Promise<PastView>;
  impact(principal: Principal, repo: string, base: string, head: string): Promise<ImpactView>;
}

// The part of a past graph `reader` may see, given the graph as it is now.
export function visiblePast(past: Graph, now: Graph, reader: Principal, repositoryScope: Scope): PastView {
  const nodes = [...past.nodes.values()].filter(
    (node) => canRead(reader, node.scope) && canRead(reader, now.nodes.get(node.id)?.scope ?? repositoryScope),
  );
  const kept = new Set(nodes.map((node) => node.id));
  return { nodes, edges: past.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)) };
}

export function createHistory(store: GraphStore, audit: AuditLog, past: PastGraphs, options: { readonly now?: () => Date } = {}): History {
  const record = recorder(audit, options.now);
  const scopeOf = (repo: string): Scope => {
    const entry = past.repositories.get(repo);
    if (entry === undefined) throw new UnknownCommit(`Unknown repository: ${repo}`);
    return entry.scope;
  };

  return {
    repositories: [...past.repositories.keys()].sort(),

    async commits(principal, repo, limit = 100) {
      const scope = scopeOf(repo);
      const graph = await store.snapshot();
      const changes = (await past.commits(repo, limit))
        .map(
          ({ sha, message }): Node =>
            graph.nodes.get(changeId(repo, sha)) ?? { id: changeId(repo, sha), type: "Change", scope, provenance: { source: repo, path: ".", sha }, ...commitText(message) },
        )
        .filter((node) => canRead(principal, node.scope));
      await record({ action: "history", repo, returned: changes.map((node) => node.id) }, principal);
      return changes;
    },

    async at(principal, repo, sha) {
      const scope = scopeOf(repo);
      const graph = await past.at(repo, sha);
      if (graph === undefined) throw new UnknownCommit(`${repo} has no commit ${sha}`);
      const view = visiblePast(graph, await store.snapshot(), principal, scope);
      await record({ action: "history", repo, sha, returned: view.nodes.map((node) => node.id) }, principal);
      return view;
    },

    async impact(principal, repo, base, head) {
      const scope = scopeOf(repo);
      const found = await past.between(repo, base, head);
      if (found === undefined) throw new UnknownCommit(`${repo}: no commits from ${base} to ${head}`);
      const { before, after, changed, commits } = found;
      const now = await store.snapshot();
      // The pull request's graph, as the reader may see it: what it reaches is drawn around it.
      const view = visiblePast(after, now, principal, scope);
      const shown = new Set(view.nodes.map((node) => node.id));
      const impact = computeImpact(
        before,
        after,
        changed.filter((id) => after.nodes.has(id)),
        changed.filter((id) => !after.nodes.has(id)),
        principal,
      );
      // computeImpact judges on the pull request's scopes; the graph now may be narrower.
      const keep = <T extends Node>(nodes: readonly T[]) => nodes.filter((node) => shown.has(node.id));
      const consumers = impact.consumers.filter((entry) => shown.has(entry.module.id));
      const endpoints = keep(impact.endpoints);
      const knowledge = keep(impact.knowledge);
      const teams = [...new Set([...endpoints, ...consumers.map((entry) => entry.module), ...knowledge].flatMap((node) => requiredTeams(node.scope)))].sort();
      const reached: Impact = { endpoints, consumers, knowledge, teams };
      const highlighted = [
        ...new Set([...changed, ...reached.endpoints.map((node) => node.id), ...consumers.map((entry) => entry.module.id), ...reached.knowledge.map((node) => node.id)]),
      ].filter((id) => shown.has(id));
      // The highlighted nodes and their neighbours, not the whole repository.
      const centre = new Set(highlighted);
      const around = new Set(view.edges.flatMap((edge) => (centre.has(edge.from) || centre.has(edge.to) ? [edge.from, edge.to] : [])));
      for (const id of centre) around.add(id);
      const nodes = view.nodes.filter((node) => around.has(node.id));
      const edges = view.edges.filter((edge) => around.has(edge.from) && around.has(edge.to));
      await record({ action: "impact", repo, base, head, returned: nodes.map((node) => node.id) }, principal);
      return { nodes, edges, impact: reached, commits, highlighted: highlighted.sort() };
    },
  };
}
