import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import neo4j, { type Driver } from "neo4j-driver";
import type { Node } from "@graph-warden/core";
import { createNeo4jStore, ensureConstraints } from "../src/index.js";

// Runs against a throwaway database: every test wipes it. Never point NEO4J_TEST_URI at a
// database you care about. `docker compose --profile test up -d --wait neo4j-test` starts one on
// bolt://localhost:7688.
const uri = process.env.NEO4J_TEST_URI;

const decision: Node = {
  id: "adr-0002",
  type: "Decision",
  scope: { kind: "team", team: "bff" },
  provenance: { source: "github:acme/shop", path: "docs/adr/0002.md", sha: "5a03dc8" },
};
const concept: Node = {
  id: "scopes",
  type: "Concept",
  scope: { kind: "private", user: "alice" },
  provenance: { source: "claude-code", path: "s-42" },
};
const module_: Node = {
  id: "app",
  type: "Module",
  scope: { kind: "shared" },
  provenance: { source: "github:acme/shop", path: "src/app.ts" },
};

describe.skipIf(uri === undefined)("Neo4j GraphStore", () => {
  let driver: Driver;
  const store = () => createNeo4jStore(driver);

  beforeAll(async () => {
    driver = neo4j.driver(uri ?? "", neo4j.auth.basic("neo4j", process.env.NEO4J_TEST_PASSWORD ?? "graph-warden"));
    await ensureConstraints(driver);
  });
  afterAll(() => driver.close());
  beforeEach(() => driver.executeQuery("MATCH (n) DETACH DELETE n"));

  it("stores and returns nodes with their scope and provenance", async () => {
    await store().upsertNodes([decision, concept, module_]);
    expect(await store().getNode("adr-0002")).toEqual(decision);
    expect(await store().getNode("scopes")).toEqual(concept);
    expect(await store().getNode("app")).toEqual(module_);
    expect(await store().getNode("missing")).toBeUndefined();
  });

  it("upserts idempotently", async () => {
    await store().upsertNodes([decision]);
    await store().upsertNodes([{ ...decision, scope: { kind: "shared" } }]);
    await store().upsertEdges([{ type: "DECIDES", from: "adr-0002", to: "adr-0002" }]);
    await store().upsertEdges([{ type: "DECIDES", from: "adr-0002", to: "adr-0002" }]);
    const graph = await store().snapshot();
    expect([...graph.nodes.values()]).toEqual([{ ...decision, scope: { kind: "shared" } }]);
    expect(graph.edges).toHaveLength(1);
  });

  it("returns the whole graph as a snapshot", async () => {
    await store().upsertNodes([decision, module_]);
    await store().upsertEdges([{ type: "DECIDES", from: "adr-0002", to: "app" }]);
    const graph = await store().snapshot();
    expect(graph.nodes.size).toBe(2);
    expect(graph.edges).toEqual([{ type: "DECIDES", from: "adr-0002", to: "app" }]);
  });

  it("deletes a node with its edges", async () => {
    await store().upsertNodes([decision, module_]);
    await store().upsertEdges([{ type: "DECIDES", from: "adr-0002", to: "app" }]);
    await store().deleteNode("app");
    const graph = await store().snapshot();
    expect([...graph.nodes.keys()]).toEqual(["adr-0002"]);
    expect(graph.edges).toEqual([]);
  });

  it("rejects invalid nodes and dangling edges", async () => {
    const unscoped = { ...decision, scope: undefined } as unknown as Node;
    await expect(store().upsertNodes([unscoped])).rejects.toThrow();
    await expect(store().upsertEdges([{ type: "DECIDES", from: "adr-0002", to: "ghost" }])).rejects.toThrow(
      /unknown nodes/,
    );
  });

  it("refuses a duplicate id at the database level", async () => {
    await expect(driver.executeQuery("CREATE (:Node {id: 'x'}), (:Node {id: 'x'})")).rejects.toThrow();
  });
});
