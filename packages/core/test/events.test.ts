import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canRead, createReader, createWriter, type Delta, type Edge, type Node, type Principal, type Scope } from "../src/index.js";
import { memoryAudit, memoryEvents, memoryStore } from "./memory.js";

const node = (id: string, scope: Scope): Node => ({ id, type: "Concept", scope, provenance: { source: "docs", path: id } });
const shared: Scope = { kind: "shared" };
const bff: Scope = { kind: "team", team: "bff" };
const alice: Principal = { user: "alice", teams: ["front"] };

function setup() {
  const store = memoryStore();
  const events = memoryEvents();
  const audit = memoryAudit();
  return { writer: createWriter(store, events), reader: createReader(store, audit, { events }), audit };
}

const ids = (delta: Delta) => ({ nodes: delta.nodes.map((n) => n.id).sort(), edges: delta.edges.length, removed: [...delta.removed].sort() });

describe("pull", () => {
  it("sends the readable part of the graph from cursor 0", async () => {
    const { writer, reader } = setup();
    await writer.upsertNodes([node("app", shared), node("secret", bff), node("util", shared)]);
    await writer.upsertEdges([
      { type: "IMPORTS", from: "app", to: "util" },
      { type: "IMPORTS", from: "app", to: "secret" },
    ]);
    const delta = await reader.pull(alice, 0);
    expect(ids(delta)).toEqual({ nodes: ["app", "util"], edges: 1, removed: [] });
    expect(delta.cursor).toBe(5);
  });

  it("sends nothing new when nothing changed", async () => {
    const { writer, reader } = setup();
    await writer.upsertNodes([node("app", shared)]);
    const { cursor } = await reader.pull(alice, 0);
    expect(await reader.pull(alice, cursor)).toEqual({ cursor, nodes: [], edges: [], removed: [] });
  });

  it("removes a node that became confidential, without its old content", async () => {
    const { writer, reader } = setup();
    await writer.upsertNodes([node("plan", shared)]);
    const { cursor } = await reader.pull(alice, 0);
    await writer.upsertNodes([node("plan", bff)]);
    expect(ids(await reader.pull(alice, cursor))).toEqual({ nodes: [], edges: 0, removed: ["plan"] });
  });

  it("does not replay history to a new client", async () => {
    const { writer, reader } = setup();
    await writer.upsertNodes([node("plan", shared)]);
    await writer.upsertNodes([node("plan", bff)]);
    expect(ids(await reader.pull(alice, 0))).toEqual({ nodes: [], edges: 0, removed: [] });
  });

  it("never names a deleted node the client could not see", async () => {
    const { writer, reader } = setup();
    await writer.upsertNodes([node("secret", bff), node("app", shared)]);
    const { cursor } = await reader.pull(alice, 0);
    await writer.deleteNode("secret");
    await writer.deleteNode("app");
    expect(ids(await reader.pull(alice, cursor))).toEqual({ nodes: [], edges: 0, removed: ["app"] });
  });

  it("is recorded in the audit log", async () => {
    const { writer, reader, audit } = setup();
    await writer.upsertNodes([node("app", shared), node("secret", bff)]);
    await reader.pull(alice, 0);
    expect(audit.written).toMatchObject([{ action: "pull", after: 0, principal: { user: "alice" }, returned: ["app"] }]);
  });
});

// For any sequence of writes and pulls: no delta names a node the principal cannot read now and
// could not read at its cursor, and a cache that applies every delta ends up holding exactly the
// part of the graph the principal may read.
describe("pull, for any sequence of writes", () => {
  const nodeIds = ["n0", "n1", "n2", "n3", "n4"];
  const scope: fc.Arbitrary<Scope> = fc.oneof(
    fc.constant(shared),
    fc.constantFrom("front", "bff").map((team): Scope => ({ kind: "team", team })),
    fc.constantFrom("alice", "bob").map((user): Scope => ({ kind: "private", user })),
  );
  const step = fc.oneof(
    fc.record({ op: fc.constant("node" as const), id: fc.constantFrom(...nodeIds), scope }),
    fc.record({ op: fc.constant("edge" as const), from: fc.constantFrom(...nodeIds), to: fc.constantFrom(...nodeIds) }),
    fc.record({ op: fc.constant("delete" as const), id: fc.constantFrom(...nodeIds) }),
    fc.constant({ op: "pull" as const }),
  );

  it("converges on the readable graph and leaks nothing on the way", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 25 }), async (steps) => {
        const store = memoryStore();
        const events = memoryEvents();
        const writer = createWriter(store, events);
        const reader = createReader(store, memoryAudit(), { events });

        const cache = new Map<string, Node>();
        let cacheEdges: Edge[] = [];
        let cursor = 0;
        const pull = async () => {
          const graph = await store.snapshot();
          const delta = await reader.pull(alice, cursor);
          const allowed = (id: string) => {
            const now = graph.nodes.get(id);
            return (now !== undefined && canRead(alice, now.scope)) || cache.has(id);
          };
          for (const id of [...delta.nodes.map((n) => n.id), ...delta.edges.flatMap((e) => [e.from, e.to]), ...delta.removed]) {
            expect(allowed(id)).toBe(true);
          }
          for (const id of delta.removed) {
            cache.delete(id);
            cacheEdges = cacheEdges.filter((e) => e.from !== id && e.to !== id);
          }
          for (const n of delta.nodes) cache.set(n.id, n);
          for (const e of delta.edges) if (!cacheEdges.some((c) => c.type === e.type && c.from === e.from && c.to === e.to)) cacheEdges.push(e);
          cursor = delta.cursor;
        };

        for (const s of steps) {
          if (s.op === "node") await writer.upsertNodes([node(s.id, s.scope)]);
          else if (s.op === "delete") await writer.deleteNode(s.id);
          else if (s.op === "pull") await pull();
          else if ((await store.getNode(s.from)) && (await store.getNode(s.to))) {
            await writer.upsertEdges([{ type: "IMPORTS", from: s.from, to: s.to }]);
          }
        }
        await pull();

        const graph = await store.snapshot();
        const readable = [...graph.nodes.values()].filter((n) => canRead(alice, n.scope));
        const visible = new Set(readable.map((n) => n.id));
        expect([...cache.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(readable.sort((a, b) => a.id.localeCompare(b.id)));
        const key = (e: Edge) => `${e.from}>${e.to}`;
        expect(cacheEdges.map(key).sort()).toEqual(graph.edges.filter((e) => visible.has(e.from) && visible.has(e.to)).map(key).sort());
      }),
      { numRuns: 1000 },
    );
  });
});
