import { createIngester, createWriter, type Extractor, type Graph, type Ontology, type PastGraphs, type RepositoryEntry } from "@graph-warden/core";
import { createGitRepository, type GitRepository } from "@graph-warden/git";
import { createMemoryEventLog, createMemoryIngestionState, createMemoryStore } from "@graph-warden/memory";

// `PastGraphs` on the worker's clones, read only (issue #16): a commit's graph is its tree
// ingested into a copy, never into the graph itself, and kept for the next request, since a
// commit never changes.

export interface GitPastOptions {
  readonly repositories: readonly RepositoryEntry[];
  readonly extractors: readonly Extractor[];
  readonly ontology?: Ontology;
  // Commit graphs kept in memory, the least recently used dropped first.
  readonly cacheSize?: number;
}

const SHA = /^[0-9a-f]{7,64}$/;

export function createGitPast(options: GitPastOptions): PastGraphs {
  const { extractors, ontology, cacheSize = 16 } = options;
  const clones = new Map(options.repositories.map((repo) => [repo.name, { entry: repo, git: createGitRepository(repo.dir) }]));
  const cache = new Map<string, Promise<Graph>>();

  // Ingests `head` into a store holding `start`, from `base` on (the whole tree without one).
  const ingest = async (repo: { entry: RepositoryEntry; git: GitRepository }, start: Graph | undefined, base: string | undefined, head: string) => {
    const store = createMemoryStore(start);
    const state = createMemoryIngestionState();
    if (base !== undefined) await state.record(repo.entry.name, base);
    const config = { name: repo.entry.name, scope: repo.entry.scope, author: repo.entry.author };
    const ingester = createIngester({
      store,
      writer: createWriter(store, createMemoryEventLog(), ontology === undefined ? {} : { ontology }),
      state,
      repositories: new Map([[config.name, { config, repository: repo.git }]]),
      extractors,
    });
    const commits = await ingester.ingest(config.name, head);
    return { graph: await store.snapshot(), commits };
  };

  // The full sha of a commit the clone has, so that a short one names the same Change node.
  const resolve = async (repo: { git: GitRepository }, sha: string) => (SHA.test(sha) && (await repo.git.has(sha)) ? repo.git.head(sha) : undefined);

  const at = async (name: string, commit: string): Promise<Graph | undefined> => {
    const repo = clones.get(name);
    const sha = repo === undefined ? undefined : await resolve(repo, commit);
    if (repo === undefined || sha === undefined) return undefined;
    const key = `${name} ${sha}`;
    let graph = cache.get(key);
    if (graph === undefined) {
      graph = ingest(repo, undefined, undefined, sha).then((result) => result.graph);
      // A failed ingestion is not kept.
      graph.catch(() => cache.delete(key));
    } else cache.delete(key);
    cache.set(key, graph);
    for (const oldest of cache.keys()) if (cache.size > cacheSize) cache.delete(oldest);
    return graph;
  };

  return {
    repositories: new Map(options.repositories.map((repo) => [repo.name, { scope: repo.scope }])),
    async commits(name, limit) {
      const repo = clones.get(name);
      if (repo === undefined) return [];
      const shas = await repo.git.log(`origin/${repo.entry.branch}`, limit);
      return Promise.all(shas.map(async (sha) => ({ sha, message: await repo.git.message(sha) })));
    },
    at,
    async between(name, from, to) {
      const repo = clones.get(name);
      if (repo === undefined) return undefined;
      const [base, head] = [await resolve(repo, from), await resolve(repo, to)];
      if (base === undefined || head === undefined) return undefined;
      if (!(await repo.git.contains(base, head))) return undefined;
      const before = await at(name, base);
      if (before === undefined) return undefined;
      const { graph: after, commits } = await ingest(repo, before, base, head);
      return { before, after, changed: [...new Set(commits.flatMap((commit) => commit.changed))], commits: commits.length };
    },
  };
}
