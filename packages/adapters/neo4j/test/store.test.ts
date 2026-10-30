import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import neo4j, { type Driver } from "neo4j-driver";
import type { AuditEntry, Node } from "@graph-warden/core";
import { createNeo4jAuditLog, createNeo4jEventLog, createNeo4jStore, ensureConstraints } from "../src/index.js";

// Runs against a throwaway database: every test wipes it. Never point NEO4J_TEST_URI at a
// database you care about. `docker compose --profile test up -d --wait neo4j-test` starts one on
// bolt://localhost:7688. Every suite against it lives in this file, so that test files running in
// parallel never wipe each other's data.
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

function entry(user: string, start: string, returned: string[]): AuditEntry {
  return {
    at: "2026-10-29T15:00:00.000Z",
    principal: { user, teams: ["bff"] },
    action: "traverse",
    start,
    options: { direction: "both", edgeTypes: ["IMPORTS"], maxDepth: 2 },
    returned,
  };
}

describe.skipIf(uri === undefined)("Neo4j adapter", () => {
  let driver: Driver;
  const store = () => createNeo4jStore(driver);

  beforeAll(async () => {
    driver = neo4j.driver(uri ?? "", neo4j.auth.basic("neo4j", process.env.NEO4J_TEST_PASSWORD ?? "graph-warden"));
    await ensureConstraints(driver);
  });
  afterAll(() => driver.close());
  beforeEach(() => driver.executeQuery("MATCH (n) DETACH DELETE n"));

  describe("GraphStore", () => {
    it("stores and returns nodes with their scope and provenance", async () => {
      await store().upsertNodes([decision, concept, module_]);
      expect(await store().getNode("adr-0002")).toEqual(decision);
      expect(await store().getNode("scopes")).toEqual(concept);
      expect(await store().getNode("app")).toEqual(module_);
      expect(await store().getNode("missing")).toBeUndefined();
    });

    it("stores a scope shared by several teams", async () => {
      const summary: Node = { ...concept, id: "summary", scope: { kind: "teams", teams: ["bff", "front"] } };
      await store().upsertNodes([summary]);
      expect(await store().getNode("summary")).toEqual(summary);
      await store().upsertNodes([{ ...summary, scope: { kind: "shared" } }]);
      expect(await store().getNode("summary")).toEqual({ ...summary, scope: { kind: "shared" } });
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

    it("deletes edges and keeps their nodes", async () => {
      await store().upsertNodes([decision, module_, concept]);
      await store().upsertEdges([
        { type: "DECIDES", from: "adr-0002", to: "app" },
        { type: "DERIVED_FROM", from: "scopes", to: "app" },
      ]);
      await store().deleteEdges([
        { type: "DERIVED_FROM", from: "scopes", to: "app" },
        { type: "IMPORTS", from: "app", to: "scopes" },
      ]);
      const graph = await store().snapshot();
      expect(graph.nodes.size).toBe(3);
      expect(graph.edges).toEqual([{ type: "DECIDES", from: "adr-0002", to: "app" }]);
    });

    it("keeps a node's body", async () => {
      await store().upsertNodes([{ ...concept, body: "# Scopes\n\nChecked on every hop." }]);
      expect((await store().getNode("scopes"))?.body).toBe("# Scopes\n\nChecked on every hop.");
      await store().upsertNodes([concept]);
      expect(await store().getNode("scopes")).toEqual(concept);
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

  describe("AuditLog", () => {
    const log = () => createNeo4jAuditLog(driver);

    it("returns entries as written, in write order even within one millisecond", async () => {
      const written = [entry("alice", "app", []), entry("bob", "app", ["secret", "client"]), entry("alice", "util", ["client"])];
      for (const e of written) await log().append(e);
      expect(await log().entries()).toEqual(written);
    });

    it("loses no entry to concurrent appends", async () => {
      await Promise.all(Array.from({ length: 20 }, (_, i) => log().append(entry("alice", `n${i}`, []))));
      const { records } = await driver.executeQuery("MATCH (e:AuditEntry) RETURN count(DISTINCT e.seq) AS seqs");
      expect(records[0]?.get("seqs").toNumber()).toBe(20);
      expect(await log().entries()).toHaveLength(20);
    });

    it("keeps what each kind of read asked for", async () => {
      const at = "2026-10-29T15:00:00.000Z";
      const principal = { user: "dpo", teams: ["auditors"] };
      const pull: AuditEntry = { at, principal, action: "pull", after: 12, returned: ["a"] };
      const trail: AuditEntry = { at, principal, action: "audit", user: "bob", returned: [] };
      await log().append(pull);
      await log().append(trail);
      expect(await log().entries({ user: "dpo" })).toEqual([pull, trail]);
    });

    it("filters by user", async () => {
      await log().append(entry("alice", "app", []));
      await log().append(entry("bob", "app", ["secret"]));
      expect((await log().entries({ user: "bob" })).map((e) => e.start)).toEqual(["app"]);
      expect(await log().entries({ user: "carol" })).toEqual([]);
    });

    it("keeps entries out of the graph", async () => {
      await log().append(entry("alice", "app", []));
      const graph = await createNeo4jStore(driver).snapshot();
      expect(graph.nodes.size).toBe(0);
    });

    it("rejects an invalid entry", async () => {
      await expect(log().append({ ...entry("alice", "app", []), at: "yesterday" })).rejects.toThrow();
    });
  });

  describe("EventLog", () => {
    const events = () => createNeo4jEventLog(driver);

    it("numbers events in order, across batches", async () => {
      await events().append([
        { kind: "node-upserted", id: "a", scope: { kind: "shared" } },
        { kind: "node-upserted", id: "b", scope: { kind: "teams", teams: ["bff", "front"] } },
      ]);
      await events().append([{ kind: "edge-upserted", edge: { type: "IMPORTS", from: "a", to: "b" } }]);
      await events().append([{ kind: "node-deleted", id: "a" }]);
      expect(await events().since(0)).toEqual([
        { seq: 1, kind: "node-upserted", id: "a", scope: { kind: "shared" } },
        { seq: 2, kind: "node-upserted", id: "b", scope: { kind: "teams", teams: ["bff", "front"] } },
        { seq: 3, kind: "edge-upserted", edge: { type: "IMPORTS", from: "a", to: "b" } },
        { seq: 4, kind: "node-deleted", id: "a" },
      ]);
      expect((await events().since(2)).map((e) => e.seq)).toEqual([3, 4]);
    });

    it("gives a node's history up to a cursor", async () => {
      await events().append([{ kind: "node-upserted", id: "a", scope: { kind: "shared" } }]);
      await events().append([{ kind: "node-upserted", id: "b", scope: { kind: "shared" } }]);
      await events().append([{ kind: "edge-upserted", edge: { type: "IMPORTS", from: "b", to: "a" } }]);
      await events().append([{ kind: "node-deleted", id: "a" }]);
      expect((await events().history("a", 3)).map((e) => e.seq)).toEqual([1, 3]);
    });

    it("loses no event to concurrent batches", async () => {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          events().append([
            { kind: "node-upserted", id: `n${i}`, scope: { kind: "shared" } },
            { kind: "node-deleted", id: `n${i}` },
          ]),
        ),
      );
      expect((await events().since(0)).map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    });

    it("indexes a deleted edge under both its ends", async () => {
      await events().append([{ kind: "edge-deleted", edge: { type: "DERIVED_FROM", from: "s", to: "a" } }]);
      expect(await events().history("a", 1)).toEqual([{ seq: 1, kind: "edge-deleted", edge: { type: "DERIVED_FROM", from: "s", to: "a" } }]);
      expect(await events().history("s", 1)).toHaveLength(1);
    });

    it("keeps events out of the graph", async () => {
      await events().append([{ kind: "node-deleted", id: "a" }]);
      expect((await store().snapshot()).nodes.size).toBe(0);
    });
  });
});
