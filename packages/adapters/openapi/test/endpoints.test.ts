import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIngester, createWriter, type GraphStore, type RepositoryConfig } from "@graph-warden/core";
import { createGitRepository } from "@graph-warden/git";
import { createMemoryEventLog, createMemoryIngestionState, createMemoryStore } from "@graph-warden/memory";
import { createTypeScriptExtractor, moduleId } from "@graph-warden/typescript";
import { createOpenApiExtractor, endpointId } from "../src/index.js";

// Issue #7: the demo's three front-ends are linked to exactly the endpoints they call, whether
// through the generated client (front-a, front-b) or fetch (front-c).

const demo = fileURLToPath(new URL("../../../../examples/shop/repo", import.meta.url));
const config: RepositoryConfig = { name: "github:acme/shop", scope: { kind: "shared" }, author: { user: "ci", teams: [] } };
const endpoint = (method: string, path: string) => endpointId(config.name, method, path);
const module_ = (path: string) => moduleId(config.name, path);

let dir: string;
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const commit = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

function setup(): { store: GraphStore; ingest: (sha: string) => Promise<unknown> } {
  const store = createMemoryStore();
  const ingester = createIngester({
    store,
    writer: createWriter(store, createMemoryEventLog()),
    state: createMemoryIngestionState(),
    repositories: new Map([[config.name, { config, repository: createGitRepository(dir) }]]),
    extractors: [createTypeScriptExtractor(), createOpenApiExtractor()],
  });
  return { store, ingest: (sha) => ingester.ingest(config.name, sha) };
}

const edges = async (store: GraphStore, type: string) =>
  (await store.snapshot()).edges
    .filter((edge) => edge.type === type)
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .sort();

// What each front-end calls, per app.
const consumed = async (store: GraphStore) => {
  const byApp: Record<string, string[]> = {};
  for (const edge of (await store.snapshot()).edges.filter((e) => e.type === "CONSUMES")) {
    const app = /:apps\/([^/]+)\//.exec(edge.from)?.[1] ?? edge.from;
    byApp[app] = [...(byApp[app] ?? []), edge.to.slice(config.name.length + 1)].sort();
  }
  return byApp;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gwarden-openapi-"));
  cpSync(demo, dir, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.com");
  git("config", "user.name", "CI");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("OpenAPI endpoints", () => {
  it("links each front-end to exactly the endpoints it calls", async () => {
    const { store, ingest } = setup();
    await ingest(commit("demo"));
    const graph = await store.snapshot();
    expect([...graph.nodes.values()].filter((n) => n.type === "Endpoint").map((n) => n.title).sort()).toEqual([
      "GET /orders",
      "GET /orders/{id}",
      "GET /profile",
      "GET /recommendations",
      "POST /orders/{id}/refund",
    ]);
    expect(await consumed(store)).toEqual({
      "front-a": ["GET /orders", "GET /profile"],
      "front-b": ["GET /orders/{id}", "POST /orders/{id}/refund"],
      "front-c": ["GET /profile", "GET /recommendations"],
    });
    expect(await edges(store, "EXPOSES")).toEqual(
      [
        `${module_("apps/bff/src/routes/orders.ts")} -> ${endpoint("get", "/orders")}`,
        `${module_("apps/bff/src/routes/orders.ts")} -> ${endpoint("get", "/orders/{id}")}`,
        `${module_("apps/bff/src/routes/orders.ts")} -> ${endpoint("post", "/orders/{id}/refund")}`,
        `${module_("apps/bff/src/routes/profile.ts")} -> ${endpoint("get", "/profile")}`,
        `${module_("apps/bff/src/routes/recommendations.ts")} -> ${endpoint("get", "/recommendations")}`,
      ].sort(),
    );
    // The imports are still there: the two extractors own different edges of the same modules.
    expect(await edges(store, "IMPORTS")).toContain(`${module_("apps/front-a/src/checkout.ts")} -> ${module_("packages/api-client/src/index.ts")}`);
  });

  it("follows a changed call, and a removed operation", async () => {
    const { store, ingest } = setup();
    await ingest(commit("demo"));
    writeFileSync(
      join(dir, "apps/front-c/src/home-screen.ts"),
      'import { BFF } from "./api";\nexport const refund = (id: string) => fetch(`${BFF}/orders/${id}/refund?force=1`, { method: "POST" });\n',
    );
    await ingest(commit("front-c: refunds"));
    expect((await consumed(store))["front-c"]).toEqual(["POST /orders/{id}/refund"]);
    expect(await edges(store, "IMPORTS")).toContain(`${module_("apps/front-c/src/home-screen.ts")} -> ${module_("apps/front-c/src/api.ts")}`);

    const spec = execFileSync("cat", [join(dir, "apps/bff/openapi.yaml")], { encoding: "utf8" });
    writeFileSync(join(dir, "apps/bff/openapi.yaml"), spec.replace(/ {2}\/orders\/\{id\}\/refund:\n(?: {4}.*\n)+/, ""));
    await ingest(commit("bff: no more refunds"));
    const graph = await store.snapshot();
    expect(graph.nodes.has(endpoint("post", "/orders/{id}/refund"))).toBe(false);
    expect((await consumed(store))["front-c"]).toBeUndefined();
    expect((await consumed(store))["front-b"]).toEqual(["GET /orders/{id}"]);
    // Imports of modules re-read for the spec are untouched.
    expect(await edges(store, "IMPORTS")).toContain(`${module_("apps/front-a/src/checkout.ts")} -> ${module_("apps/front-a/src/format.ts")}`);
  });
});
