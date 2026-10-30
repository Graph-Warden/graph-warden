import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIngester, createWriter, type GraphStore, type Node, type RepositoryConfig } from "@graph-warden/core";
import { createDocumentExtractor } from "@graph-warden/documents";
import { createGitRepository } from "@graph-warden/git";
import { createMemoryEventLog, createMemoryIngestionState, createMemoryStore } from "@graph-warden/memory";
import { createOpenApiExtractor } from "@graph-warden/openapi";
import { createTypeScriptExtractor } from "@graph-warden/typescript";
import { formatImpact, MARKER, packageNames, postComment, pullRequestImpact } from "../src/impact.js";

// Issue #9: a BFF pull request changing an endpoint lists exactly the front-ends consuming it, and
// the graph is left as it was.

const demo = fileURLToPath(new URL("../../../examples/shop/repo", import.meta.url));
const config: RepositoryConfig = { name: "github:acme/shop", scope: { kind: "shared" }, author: { user: "ci", teams: ["bff"] } };
const extractors = () => [createDocumentExtractor(), createTypeScriptExtractor(), createOpenApiExtractor()];

let dir: string;
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const commit = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

// The graph with main ingested, and a decision of the BFF team on the orders routes.
async function database(sha: string): Promise<GraphStore> {
  const store = createMemoryStore();
  const writer = createWriter(store, createMemoryEventLog());
  await createIngester({
    store,
    writer,
    state: createMemoryIngestionState(),
    repositories: new Map([[config.name, { config, repository: createGitRepository(dir) }]]),
    extractors: extractors(),
  }).ingest(config.name, sha);
  const decision: Node = {
    id: "adr-0007",
    type: "Decision",
    scope: { kind: "team", team: "bff" },
    provenance: { source: "docs:shop", path: "bff/adr-0007.md" },
    title: "Cursor pagination",
    body: "Orders are paginated by cursor.",
  };
  await writer.upsertNodes([decision]);
  await writer.upsertEdges([{ type: "DECIDES", from: "adr-0007", to: `${config.name}:apps/bff/src/routes/orders.ts` }]);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gwarden-impact-"));
  cpSync(demo, dir, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.com");
  git("config", "user.name", "CI");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("gwarden impact", () => {
  it("lists exactly the front-ends consuming the endpoints a BFF change touches, writing nothing", async () => {
    const base = commit("demo");
    const store = await database(base);
    const before = await store.snapshot();

    git("checkout", "-q", "-b", "orders-v2");
    const orders = join(dir, "apps/bff/src/routes/orders.ts");
    writeFileSync(orders, readFileSync(orders, "utf8").replace("total: 42", "total: 42, currency: 'EUR'"));
    const head = commit("bff: orders carry their currency");

    const repository = createGitRepository(dir);
    const impact = await pullRequestImpact({ graph: before, repository, config, extractors: extractors(), base, head, reader: { user: "pr", teams: [] } });
    const report = formatImpact(impact, await packageNames(repository, head));

    expect(impact.endpoints.map((node) => node.title)).toEqual(["GET /orders", "GET /orders/{id}", "POST /orders/{id}/refund"]);
    expect([...new Set(impact.consumers.map((c) => c.module.provenance.path.split("/")[1]))]).toEqual(["front-a", "front-b"]);
    expect(report).toContain("**@shop/front-a**");
    expect(report).toContain("**@shop/front-b**");
    expect(report).not.toContain("front-c");
    // The BFF's decision is not readable by everyone who reads the pull request: not even counted.
    expect(impact.knowledge).toEqual([]);
    expect(report).not.toContain("adr-0007");

    const asBff = await pullRequestImpact({ graph: before, repository, config, extractors: extractors(), base, head, reader: { user: "pr", teams: ["bff"] } });
    expect(asBff.knowledge.map((node) => node.id)).toEqual(["adr-0007"]);
    expect(asBff.teams).toEqual(["bff"]);

    expect(await store.snapshot()).toEqual(before);
    // Ingests the demo three times.
  }, 30_000);

  it("posts the report, replacing the previous one", async () => {
    const calls: { url: string; method: string }[] = [];
    const send = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      const body = init?.method === undefined ? [{ id: 1, body: "LGTM" }, { id: 7, body: `${MARKER}\nold` }] : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    await postComment("acme/shop", 12, `${MARKER}\nnew`, "token", send);
    expect(calls).toEqual([
      { url: "https://api.github.com/repos/acme/shop/issues/12/comments?per_page=100", method: "GET" },
      { url: "https://api.github.com/repos/acme/shop/issues/comments/7", method: "PATCH" },
    ]);
  });
});
