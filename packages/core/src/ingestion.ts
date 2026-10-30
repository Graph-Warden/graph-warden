import { createGraph, type Graph } from "./traversal.js";
import { deriveScopes } from "./derivation.js";
import type { Writer } from "./events.js";
import type { Edge, Node } from "./ontology.js";
import type { Principal, Scope } from "./scope.js";
import type { GraphStore } from "./store.js";

// Ingestion of a git repository (proposal 0004). A job only says "this repository has reached this
// commit". The ingester walks the first-parent history of the branch from the last commit it
// ingested to that one, and ingests each commit in order, from the diff with its parent. So:
// - jobs for one repository may arrive in any order, twice, or late: a commit already behind the
//   last ingested one is a no-op, and every commit in between is ingested exactly once, in git
//   order. Four merges notified out of order and a replayed webhook give the graph of sequential
//   ingestion;
// - writes are idempotent on (repo, path, sha): replaying a commit after a crash, before its sha
//   was recorded, writes the same nodes and edges again;
// - nodes are versioned per commit: a node's provenance names the commit that last wrote it, and a
//   `Change` node per commit `MODIFIES` the nodes of the files it touched.
// Only this pipeline, following the repository's main branch, writes the repository's nodes.

// A file the commit added or modified (`upserted`), or removed. A rename is a removal and an
// addition: the node of the old path goes, the node of the new path comes.
export interface FileChange {
  readonly status: "upserted" | "deleted";
  readonly path: string;
}

// Port for a git repository.
export interface Repository {
  // Whether `ancestor` is `descendant` or one of its ancestors.
  contains(ancestor: string, descendant: string): Promise<boolean>;
  // The first-parent commits after `from` up to and including `to`, oldest first. `from` must be an
  // ancestor of `to`.
  commits(from: string, to: string): Promise<readonly string[]>;
  // Files changed from `from` to `to`; every file of `to` without `from`.
  changes(from: string | undefined, to: string): Promise<readonly FileChange[]>;
  read(sha: string, path: string): Promise<string>;
  // The full commit message.
  message(sha: string): Promise<string>;
}

// Port for the last commit ingested per repository.
export interface IngestionState {
  last(repo: string): Promise<string | undefined>;
  record(repo: string, sha: string): Promise<void>;
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

// What one commit gives to an extractor: the files it changed, and the tree of the commit, for
// extractors that resolve one file against others (imports, generated clients).
export interface Snapshot {
  readonly repo: RepositoryConfig;
  readonly sha: string;
  read(path: string): Promise<string>;
}

// Turns files into nodes and edges. A node's provenance is filled in by the ingester: the
// extractor gives the path of the file it came from. Edges may point to nodes of files the commit
// did not change; edges to nodes that do not exist are dropped.
export interface Extractor {
  matches(path: string): boolean;
  extract(files: readonly SourceFile[], snapshot: Snapshot): Promise<Extraction>;
}

export interface Extraction {
  readonly nodes: readonly (Omit<Node, "provenance"> & { readonly path: string })[];
  readonly edges: readonly Edge[];
}

export interface RepositoryConfig {
  // Name of the repository, and provenance source of its nodes: `github:acme/shop`.
  readonly name: string;
  // Scope of the nodes an extractor gives none, and of the `Change` nodes.
  readonly scope: Scope;
  // The principal the repository's derived nodes are derived for: it must read every source
  // (proposal 0010), like the ingesting user of `gwarden ingest`.
  readonly author: Principal;
}

export interface IngestedCommit {
  readonly sha: string;
  readonly upserted: number;
  readonly deleted: number;
}

export interface Ingester {
  // Brings the repository up to `target`; returns the commits ingested, none if `target` was
  // already ingested.
  ingest(repo: string, target: string): Promise<readonly IngestedCommit[]>;
}

export interface IngesterOptions {
  readonly store: GraphStore;
  readonly writer: Writer;
  readonly state: IngestionState;
  readonly repositories: ReadonlyMap<string, { readonly config: RepositoryConfig; readonly repository: Repository }>;
  readonly extractors: readonly Extractor[];
}

export class Diverged extends Error {
  override readonly name = "Diverged";
}

export const changeId = (repo: string, sha: string): string => `${repo}@${sha}`;

export function createIngester(options: IngesterOptions): Ingester {
  const { store, writer, state, repositories, extractors } = options;
  return {
    async ingest(repo, target) {
      const entry = repositories.get(repo);
      if (entry === undefined) throw new Error(`Unknown repository: ${repo}`);
      const { config, repository } = entry;
      const last = await state.last(repo);
      if (last !== undefined && (await repository.contains(target, last))) return [];
      if (last !== undefined && !(await repository.contains(last, target))) {
        throw new Diverged(`${repo}: ${target} does not descend from ${last}, the last commit ingested`);
      }
      // A first ingestion takes the tree of the target as one commit, not the whole history.
      const commits = last === undefined ? [target] : await repository.commits(last, target);
      const done: IngestedCommit[] = [];
      let parent = last;
      for (const sha of commits) {
        done.push(await ingestCommit(config, repository, parent, sha));
        await state.record(repo, sha);
        parent = sha;
      }
      return done;
    },
  };

  async function ingestCommit(config: RepositoryConfig, repository: Repository, parent: string | undefined, sha: string) {
    const changes = await repository.changes(parent, sha);
    const snapshot: Snapshot = { repo: config, sha, read: (path) => repository.read(sha, path) };
    const upserted = changes.filter((change) => change.status === "upserted").map((change) => change.path);

    const nodes: Node[] = [];
    const extracted: Edge[] = [];
    for (const extractor of extractors) {
      const paths = upserted.filter((path) => extractor.matches(path));
      if (paths.length === 0) continue;
      const files = await Promise.all(paths.map(async (path) => ({ path, text: await snapshot.read(path) })));
      const extraction = await extractor.extract(files, snapshot);
      for (const { path, ...node } of extraction.nodes) {
        nodes.push({ ...node, provenance: { source: config.name, path, sha } });
      }
      extracted.push(...extraction.edges);
    }

    const before = await store.snapshot();
    const changed = new Set(changes.map((change) => change.path));
    const owned = [...before.nodes.values()].filter(
      (node) => node.type !== "Change" && node.provenance.source === config.name && changed.has(node.provenance.path),
    );
    const kept = new Set(nodes.map((node) => node.id));
    const removed = owned.filter((node) => !kept.has(node.id)).map((node) => node.id);
    const gone = new Set(removed);

    const change: Node = {
      id: changeId(config.name, sha),
      type: "Change",
      scope: config.scope,
      provenance: { source: config.name, path: ".", sha },
      ...commitText(await repository.message(sha)),
    };
    const all = [...nodes, change];
    const exists = (id: string) => kept.has(id) || id === change.id || (before.nodes.has(id) && !gone.has(id));
    const key = (edge: Edge) => `${edge.type} ${edge.from} ${edge.to}`;
    const edges = uniqueEdges([
      ...extracted.filter((edge) => kept.has(edge.from) && exists(edge.to)),
      ...nodes.map((node): Edge => ({ type: "MODIFIES", from: change.id, to: node.id })),
    ]);
    // The edges a changed file had and no longer has. Edges into its nodes belong to other files.
    const fresh = new Set(edges.map(key));
    const stale = before.edges.filter((edge) => kept.has(edge.from) && !fresh.has(key(edge)));

    const derived = narrow(before, all, edges, gone, stale, config.author);
    await writer.upsertNodes(derived);
    await writer.deleteEdges(stale);
    await writer.upsertEdges(edges);
    for (const id of removed) await writer.deleteNode(id);
    return { sha, upserted: nodes.length, deleted: removed.length };
  }
}

// Nodes of the commit derived from others (`DERIVED_FROM`) take the scope of the readers of all
// their sources, as in `gwarden ingest`, with the graph as it will be after the commit.
function narrow(before: Graph, nodes: readonly Node[], edges: readonly Edge[], gone: ReadonlySet<string>, stale: readonly Edge[], author: Principal): Node[] {
  const ids = new Set(nodes.map((node) => node.id));
  const dropped = new Set(stale.map((edge) => `${edge.type} ${edge.from} ${edge.to}`));
  const after = createGraph(
    [...[...before.nodes.values()].filter((node) => !ids.has(node.id) && !gone.has(node.id)), ...nodes],
    uniqueEdges([
      ...before.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to) && !dropped.has(`${edge.type} ${edge.from} ${edge.to}`)),
      ...edges,
    ]),
  );
  return deriveScopes(after, author, nodes.map((node) => node.id));
}

function uniqueEdges(edges: readonly Edge[]): Edge[] {
  return [...new Map(edges.map((edge) => [`${edge.type} ${edge.from} ${edge.to}`, edge])).values()];
}

// The subject line as title, the rest as body.
function commitText(message: string): { title?: string; body?: string } {
  const [subject = "", ...rest] = message.trim().split("\n");
  const body = rest.join("\n").trim();
  return { ...(subject.trim() === "" ? {} : { title: subject.trim() }), ...(body === "" ? {} : { body }) };
}

// Port for the queue of ingestion jobs. Jobs of one repository are handled one at a time, across
// every worker; jobs of different repositories in parallel. A job stays queued until its handler
// succeeds, so a crash leaves it to the next worker; a job that fails is retried with the next job
// of its repository, or when a worker starts. Jobs need no order: the ingester orders commits.
export interface IngestionQueue {
  enqueue(repo: string, sha: string): Promise<void>;
  // Handles jobs until stopped. `stop` waits for the jobs in progress.
  start(handler: (repo: string, sha: string) => Promise<void>, onError?: (error: unknown, repo: string, sha: string) => void): Promise<{ stop(): Promise<void> }>;
}
