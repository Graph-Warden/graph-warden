import { posix } from "node:path";
import {
  computeImpact,
  createIngester,
  createWriter,
  formatScope,
  type Extractor,
  type Graph,
  type Impact,
  type Ontology,
  type Principal,
  type Repository,
  type RepositoryConfig,
} from "@graph-warden/core";
import { createMemoryEventLog, createMemoryIngestionState, createMemoryStore } from "@graph-warden/memory";

// `gwarden impact` (issue #9): the commits of a pull request ingested into a copy of the graph, never
// into the graph itself, and what they reach.

export interface ImpactOptions {
  // The graph as it is, the pull request's base ingested.
  readonly graph: Graph;
  readonly repository: Repository;
  readonly config: RepositoryConfig;
  readonly extractors: readonly Extractor[];
  readonly ontology?: Ontology;
  readonly base: string;
  readonly head: string;
  // Who the report is for: the readers of the pull request.
  readonly reader: Principal;
}

export async function pullRequestImpact(options: ImpactOptions): Promise<Impact & { readonly commits: number }> {
  const { graph, repository, config, base, head } = options;
  const store = createMemoryStore(graph);
  const state = createMemoryIngestionState();
  await state.record(config.name, base);
  const ingester = createIngester({
    store,
    writer: createWriter(store, createMemoryEventLog(), options.ontology === undefined ? {} : { ontology: options.ontology }),
    state,
    repositories: new Map([[config.name, { config, repository }]]),
    extractors: options.extractors,
  });
  const commits = await ingester.ingest(config.name, head);
  const after = await store.snapshot();
  const touched = [...new Set(commits.flatMap((commit) => commit.changed))];
  const impact = computeImpact(
    graph,
    after,
    touched.filter((id) => after.nodes.has(id)),
    touched.filter((id) => !after.nodes.has(id)),
    options.reader,
  );
  return { ...impact, commits: commits.length };
}

export const MARKER = "<!-- graph-warden-impact -->";

// The report as Markdown, for a pull request comment. `packageOf` names the package a file belongs
// to, to group consuming modules by front-end.
export function formatImpact(impact: Impact & { readonly commits: number }, packageOf: (path: string) => string | undefined): string {
  const title = (id: string) => impact.endpoints.find((node) => node.id === id)?.title ?? id;
  const lines = [MARKER, "### Graph-Warden impact", ""];
  if (impact.endpoints.length === 0 && impact.consumers.length === 0 && impact.knowledge.length === 0) {
    lines.push("No endpoint, consumer or knowledge you may read depends on this change.");
    return lines.join("\n");
  }
  if (impact.endpoints.length > 0) {
    lines.push(`**Endpoints touched** (${impact.endpoints.length})`, "");
    for (const node of impact.endpoints) lines.push(`- \`${node.title ?? node.id}\``);
    lines.push("");
  }
  if (impact.consumers.length > 0) {
    const groups = new Map<string, string[]>();
    for (const { module, endpoints } of impact.consumers) {
      const name = packageOf(module.provenance.path) ?? posix.dirname(module.provenance.path);
      groups.set(name, [...(groups.get(name) ?? []), `\`${module.provenance.path}\` → ${endpoints.map((id) => `\`${title(id)}\``).join(", ")}`]);
    }
    lines.push(`**Consumers** (${groups.size})`, "");
    for (const [name, modules] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- **${name}**`, ...modules.map((line) => `  - ${line}`));
    }
    lines.push("");
  }
  if (impact.knowledge.length > 0) {
    lines.push(`**Decisions and documents to check** (${impact.knowledge.length})`, "");
    for (const node of impact.knowledge) lines.push(`- ${node.type} \`${node.id}\`${node.title === undefined ? "" : ` ${node.title}`} [${formatScope(node.scope)}]`);
    lines.push("");
  }
  if (impact.teams.length > 0) lines.push(`**Teams**: ${impact.teams.join(", ")}`, "");
  lines.push(`_${impact.commits} commit${impact.commits === 1 ? "" : "s"} analysed without writing to the graph. Only what this pull request's readers may read is listed._`);
  return lines.join("\n");
}

// The nearest package.json's name of each file, from the files of a commit.
export async function packageNames(repository: Repository, sha: string): Promise<(path: string) => string | undefined> {
  const manifests = (await repository.changes(undefined, sha)).map((change) => change.path).filter((path) => path.endsWith("package.json") && !path.includes("node_modules/"));
  const names = new Map<string, string>();
  for (const path of manifests) {
    try {
      const name = (JSON.parse(await repository.read(sha, path)) as { name?: unknown }).name;
      if (typeof name === "string") names.set(posix.dirname(path), name);
    } catch {
      // Not JSON: no name.
    }
  }
  return (path) => {
    for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
      const name = names.get(dir);
      if (name !== undefined && dir !== ".") return name;
      if (dir === "." || dir === "/") return undefined;
    }
  };
}

// Posts the report on the pull request, replacing the previous one.
export async function postComment(repo: string, pull: number, body: string, token: string, send: typeof fetch = fetch): Promise<void> {
  const api = `https://api.github.com/repos/${repo}/issues`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" };
  const listed = await send(`${api}/${pull}/comments?per_page=100`, { headers });
  if (!listed.ok) throw new Error(`GitHub answered ${listed.status} listing comments`);
  const previous = ((await listed.json()) as { id: number; body?: string }[]).find((comment) => comment.body?.startsWith(MARKER));
  const response = await send(previous === undefined ? `${api}/${pull}/comments` : `${api}/comments/${previous.id}`, {
    method: previous === undefined ? "POST" : "PATCH",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
}
