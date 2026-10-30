import { describe, expect, it } from "vitest";
import { createGraph, createIngester, createWriter, formatScope, narrowDependents, type Edge, type Node, type Repository, type Scope } from "../src/index.js";
import { memoryEvents, memoryStore } from "./memory.js";

const node = (id: string, scope: Scope, source = "docs"): Node => ({ id, type: "Concept", scope, provenance: { source, path: `${id}.md` } });
const scopes = (nodes: readonly Node[]) => Object.fromEntries(nodes.map((n) => [n.id, formatScope(n.scope)]));

describe("narrowDependents", () => {
  const derived: Edge[] = [
    { type: "DERIVED_FROM", from: "answer", to: "page" },
    { type: "DERIVED_FROM", from: "answer", to: "other" },
    { type: "DERIVED_FROM", from: "digest", to: "answer" },
  ];

  it("narrows what is derived from a narrowed source, through chains", () => {
    const graph = createGraph(
      [node("page", { kind: "private", user: "lea" }), node("other", { kind: "team", team: "front" }), node("answer", { kind: "teams", teams: ["bff", "front"] }), node("digest", { kind: "teams", teams: ["bff", "front"] })],
      derived,
    );
    expect(scopes(narrowDependents(graph, ["page"]))).toEqual({ answer: "private:lea", digest: "private:lea" });
  });

  it("never widens, and reports only what changes", () => {
    const graph = createGraph(
      [node("page", { kind: "shared" }), node("other", { kind: "team", team: "front" }), node("answer", { kind: "teams", teams: ["bff", "front"] }), node("digest", { kind: "teams", teams: ["bff", "front"] })],
      derived,
    );
    expect(narrowDependents(graph, ["page"])).toEqual([]);
  });
});

// A page narrowed by a commit narrows the answer filed from it, which the commit did not touch.
it("ingestion narrows nodes derived from what a commit narrowed", async () => {
  const store = memoryStore();
  const writer = createWriter(store, memoryEvents());
  await writer.upsertNodes([node("adr", { kind: "team", team: "bff" }, "github:acme/shop"), node("answer", { kind: "team", team: "bff" }, "ask:lea")]);
  await writer.upsertEdges([{ type: "DERIVED_FROM", from: "answer", to: "adr" }]);
  const repository: Repository = {
    contains: async (a, d) => a === d || a === "c1c1c1c",
    commits: async () => ["c2c2c2c"],
    changes: async () => [{ status: "upserted", path: "adr.md" }],
    read: async () => "",
    message: async () => "Make the ADR private",
    diff: async () => "",
  };
  const ingester = createIngester({
    store,
    writer,
    state: { last: async () => "c1c1c1c", record: async () => {}, forget: async () => {} },
    repositories: new Map([["github:acme/shop", { config: { name: "github:acme/shop", scope: { kind: "shared" }, author: { user: "lea", teams: ["bff"] } }, repository }]]),
    extractors: [{ matches: () => true, extract: async () => ({ nodes: [{ id: "adr", type: "Concept", scope: { kind: "private", user: "lea" }, path: "adr.md" }], edges: [] }) }],
  });
  await ingester.ingest("github:acme/shop", "c2c2c2c");
  expect(formatScope((await store.getNode("answer"))?.scope ?? { kind: "shared" })).toBe("private:lea");
});
