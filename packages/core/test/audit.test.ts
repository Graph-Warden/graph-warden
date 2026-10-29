import { describe, expect, it } from "vitest";
import {
  createGraph,
  createReader,
  type AuditEntry,
  type AuditLog,
  type Graph,
  type GraphStore,
  type Node,
  type Principal,
  type Scope,
} from "../src/index.js";

function node(id: string, scope: Scope): Node {
  return { id, type: "Module", scope, provenance: { source: "github:acme/shop", path: `${id}.ts` } };
}

// app -> secret (team bff) -> client
const graph = createGraph(
  [node("app", { kind: "shared" }), node("secret", { kind: "team", team: "bff" }), node("client", { kind: "shared" })],
  [
    { type: "IMPORTS", from: "app", to: "secret" },
    { type: "IMPORTS", from: "secret", to: "client" },
  ],
);

function storeOf(g: Graph): GraphStore {
  const unused = () => Promise.reject(new Error("read-only test store"));
  return { upsertNodes: unused, upsertEdges: unused, getNode: unused, deleteNode: unused, snapshot: () => Promise.resolve(g) };
}

function memoryLog(): AuditLog & { readonly written: AuditEntry[] } {
  const written: AuditEntry[] = [];
  return {
    written,
    append: (entry) => Promise.resolve(void written.push(entry)),
    entries: (filter = {}) =>
      Promise.resolve(written.filter((entry) => filter.user === undefined || entry.principal.user === filter.user)),
  };
}

const alice: Principal = { user: "alice", teams: ["front-a"] };
const bob: Principal = { user: "bob", teams: ["bff"] };
const at = new Date("2026-10-29T15:00:00.000Z");

describe("createReader", () => {
  it("records who read what, and which nodes they got", async () => {
    const log = memoryLog();
    const reader = createReader(storeOf(graph), log, { now: () => at });

    const reached = await reader.traverse(bob, "app", { direction: "out", maxDepth: 2 });

    expect(reached.map((n) => n.id)).toEqual(["secret", "client"]);
    expect(log.written).toEqual([
      {
        at: "2026-10-29T15:00:00.000Z",
        principal: { user: "bob", teams: ["bff"] },
        action: "traverse",
        start: "app",
        options: { direction: "out", maxDepth: 2 },
        returned: ["secret", "client"],
      },
    ]);
  });

  it("records only what the principal could read", async () => {
    const log = memoryLog();
    await createReader(storeOf(graph), log, { now: () => at }).traverse(alice, "app");
    expect(log.written[0]?.returned).toEqual([]);
  });

  it("records a read that returned nothing", async () => {
    const log = memoryLog();
    await createReader(storeOf(graph), log, { now: () => at }).traverse(alice, "secret");
    expect(log.written).toHaveLength(1);
    expect(log.written[0]).toMatchObject({ start: "secret", returned: [] });
  });

  it("records an unbounded depth as no depth", async () => {
    const log = memoryLog();
    await createReader(storeOf(graph), log, { now: () => at }).traverse(bob, "app", { maxDepth: Infinity });
    expect(log.written[0]?.options.maxDepth).toBeUndefined();
  });

  it("fails the read when the entry cannot be written", async () => {
    const failing: AuditLog = { append: () => Promise.reject(new Error("disk full")), entries: () => Promise.resolve([]) };
    await expect(createReader(storeOf(graph), failing).traverse(bob, "app")).rejects.toThrow("disk full");
  });
});
