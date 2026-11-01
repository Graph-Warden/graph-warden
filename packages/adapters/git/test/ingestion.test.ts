import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIngester, createWriter, Diverged, type Graph, type Ingester, type RepositoryConfig } from "@graph-warden/core";
import { createDocumentExtractor } from "@graph-warden/documents";
import { createMemoryEventLog, createMemoryIngestionState, createMemoryQueue, createMemoryStore } from "@graph-warden/memory";
import { createGitRepository } from "../src/index.js";

// Proposal 0004 on a real git repository: the ingester follows git order whatever order the jobs
// arrive in, and replays write nothing new.

let dir: string;
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const commit = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

const config: RepositoryConfig = {
  name: "github:acme/shop",
  scope: { kind: "team", team: "bff" },
  author: { user: "pipeline", teams: ["bff", "front-a"] },
};

function setup(): { ingester: Ingester; snapshot: () => Promise<Graph> } {
  const store = createMemoryStore();
  const ingester = createIngester({
    store,
    writer: createWriter(store, createMemoryEventLog()),
    state: createMemoryIngestionState(),
    repositories: new Map([[config.name, { config, repository: createGitRepository(dir) }]]),
    extractors: [createDocumentExtractor()],
  });
  return { ingester, snapshot: () => store.snapshot() };
}

const sorted = (graph: Graph) => ({
  nodes: [...graph.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
  edges: graph.edges.map((e) => `${e.type} ${e.from} ${e.to}`).sort(),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gwarden-git-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.com");
  git("config", "user.name", "CI");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("git ingestion", () => {
  it("leaves out a source that was erased, and takes it from scratch once readmitted", async () => {
    const store = createMemoryStore();
    const state = createMemoryIngestionState();
    const ingester = createIngester({
      store,
      writer: createWriter(store, createMemoryEventLog()),
      state,
      repositories: new Map([[config.name, { config, repository: createGitRepository(dir) }]]),
      extractors: [createDocumentExtractor()],
    });
    write("docs/crm.md", "# Patient 4711\n");
    const first = commit("docs: patient");
    await store.markErased(config.name);

    expect(await ingester.ingest(config.name, first)).toEqual([]);
    expect((await store.snapshot()).nodes.size).toBe(0);
    expect(await state.last(config.name)).toBeUndefined();

    await store.readmit(config.name);
    write("docs/crm.md", "# Cleaned\n");
    const second = commit("docs: clean");
    await ingester.ingest(config.name, second);
    expect([...(await store.snapshot()).nodes.values()].map((node) => node.title)).toContain("Cleaned");
  });

  it("gives the graph of sequential ingestion to four merges notified out of order and a replay", async () => {
    write("docs/orders-api.md", "---\nid: orders-api\ntype: endpoint\n---\n# GET /orders\n");
    const base = commit("feat: orders API");
    write("docs/adr-7.md", "---\nid: adr-7\ntype: decision\nreferences:\n  - { type: DECIDES, to: orders-api }\n---\n# Cursor pagination\n");
    const a = commit("docs: ADR 7");
    write("docs/checkout.md", "---\nid: checkout\nscope: team:front-a\n---\nCalls [[orders-api]].\n");
    const b = commit("docs: checkout");
    write("docs/adr-7.md", "---\nid: adr-7\ntype: decision\n---\n# Cursor pagination, superseded\n");
    const c = commit("docs: ADR 7 no longer decides");
    git("mv", "docs/checkout.md", "docs/checkout-page.md");
    const d = commit("docs: rename checkout");

    const sequential = setup();
    for (const sha of [base, a, b, c, d]) await sequential.ingester.ingest(config.name, sha);

    const concurrent = setup();
    await concurrent.ingester.ingest(config.name, base);
    const queue = createMemoryQueue();
    const errors: unknown[] = [];
    const worker = await queue.start((repo, sha) => concurrent.ingester.ingest(repo, sha).then(() => {}), (error) => errors.push(error));
    await Promise.all([d, b, a, c, b].map((sha) => queue.enqueue(config.name, sha)));
    await worker.stop();

    expect(errors).toEqual([]);
    const graph = await concurrent.snapshot();
    expect(sorted(graph)).toEqual(sorted(await sequential.snapshot()));
    // Versioned per commit: the node carries the commit that last wrote it, and every commit is a
    // Change modifying what it wrote.
    expect(graph.nodes.get("adr-7")?.provenance).toEqual({ source: config.name, path: "docs/adr-7.md", sha: c });
    expect(graph.nodes.get("checkout")?.provenance.path).toBe("docs/checkout-page.md");
    expect([...graph.nodes.values()].filter((n) => n.type === "Change").map((n) => n.title).sort()).toEqual(
      ["docs: ADR 7", "docs: ADR 7 no longer decides", "docs: checkout", "docs: rename checkout", "feat: orders API"],
    );
    expect(sorted(graph).edges).toEqual(
      expect.arrayContaining(["REFERENCES checkout orders-api", `MODIFIES github:acme/shop@${c} adr-7`]),
    );
    expect(sorted(graph).edges).not.toContain("DECIDES adr-7 orders-api");
  });

  it("writes nothing for a commit already ingested", async () => {
    write("docs/a.md", "# A\n");
    const first = commit("a");
    write("docs/b.md", "# B\n");
    const second = commit("b");
    const { ingester } = setup();
    expect(await ingester.ingest(config.name, second)).toHaveLength(1);
    expect(await ingester.ingest(config.name, second)).toEqual([]);
    expect(await ingester.ingest(config.name, first)).toEqual([]);
  });

  it("removes the nodes of a deleted file and their edges", async () => {
    write("docs/a.md", "See [[b]].\n");
    write("docs/b.md", "# B\n");
    commit("a and b");
    git("rm", "-q", "docs/b.md");
    const head = commit("drop b");
    const { ingester, snapshot } = setup();
    await ingester.ingest(config.name, git("rev-parse", "HEAD~1"));
    await ingester.ingest(config.name, head);
    const graph = await snapshot();
    expect(graph.nodes.has("b")).toBe(false);
    expect(graph.edges.filter((e) => e.type !== "MODIFIES")).toEqual([]);
    expect(await createGitRepository(dir).diff(undefined, head)).toContain("-# B");
  });

  it("narrows a derived document to the readers of its sources", async () => {
    write("docs/checkout.md", "---\nscope: team:front-a\n---\n# Checkout\n");
    write("docs/impact.md", "---\nscope: shared\nreferences:\n  - { type: DERIVED_FROM, to: checkout }\n---\n# Impact\n");
    const head = commit("impact");
    const { ingester, snapshot } = setup();
    await ingester.ingest(config.name, head);
    expect((await snapshot()).nodes.get("impact")?.scope).toEqual({ kind: "team", team: "front-a" });
  });

  it("refuses a commit that does not descend from the last one ingested", async () => {
    write("docs/a.md", "# A\n");
    commit("a");
    write("docs/b.md", "# B\n");
    const ingested = commit("b");
    git("checkout", "-q", "-b", "other", "HEAD~1");
    write("docs/c.md", "# C\n");
    const other = commit("c");
    const { ingester } = setup();
    await ingester.ingest(config.name, ingested);
    await expect(ingester.ingest(config.name, other)).rejects.toThrow(Diverged);
  });
});
