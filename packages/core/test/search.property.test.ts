import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canRead, createGraph, fitContext, retrieve, scanIndex, searchGraph, type Edge, type Graph, type Node, type Principal, type Scope } from "../src/index.js";
import { memoryStore } from "./memory.js";

// Non-interference of retrieval (proposal 0002, 0013): what a principal gets depends only on what
// they can read. The whole answer counts, order included: an unreadable node must not move a
// readable one up or down, through a word count, a link, or a cut at the limit.

const users = ["alice", "bob", "carol"];
const teams = ["bff", "front-a", "front-b"];
const words = ["orders", "cursor", "pagination", "refund", "falcon", "merger", "consent", "profile"];

const scope: fc.Arbitrary<Scope> = fc.oneof(
  fc.constant({ kind: "shared" } as const),
  fc.constantFrom(...teams).map((team) => ({ kind: "team", team }) as const),
  fc.uniqueArray(fc.constantFrom(...teams), { minLength: 2 }).map((names) => ({ kind: "teams", teams: names.sort() }) as const),
  fc.constantFrom(...users).map((user) => ({ kind: "private", user }) as const),
);

const principal: fc.Arbitrary<Principal> = fc.record({ user: fc.constantFrom(...users), teams: fc.subarray(teams) });
const text = fc.array(fc.constantFrom(...words), { maxLength: 12 }).map((list) => list.join(" "));

const graph: fc.Arbitrary<Graph> = fc.integer({ min: 1, max: 14 }).chain((size) =>
  fc
    .tuple(
      fc.array(fc.record({ scope, body: text, title: fc.option(text.filter((t) => t.length > 0), { nil: undefined }) }), { minLength: size, maxLength: size }),
      fc.array(fc.record({ from: fc.nat(size - 1), to: fc.nat(size - 1) }), { maxLength: size * 3 }),
    )
    .map(([nodes, edges]) => {
      const unique = new Map(edges.map((e) => [`${e.from} ${e.to}`, e]));
      return createGraph(
        nodes.map(({ scope: s, body, title }, i): Node => ({ id: `n${i}`, type: "Module", scope: s, provenance: { source: "test", path: `n${i}` }, body, ...(title === undefined ? {} : { title }) })),
        [...unique.values()].map((e): Edge => ({ type: "REFERENCES", from: `n${e.from}`, to: `n${e.to}` })),
      );
    }),
);

function readablePart(g: Graph, p: Principal): Graph {
  const nodes = [...g.nodes.values()].filter((n) => canRead(p, n.scope));
  const kept = new Set(nodes.map((n) => n.id));
  return createGraph(nodes, g.edges.filter((e) => kept.has(e.from) && kept.has(e.to)));
}

const ids = (nodes: readonly Node[]) => nodes.map((n) => n.id);
const query = fc.array(fc.constantFrom(...words), { minLength: 1, maxLength: 4 }).map((list) => list.join(" "));
const options = fc.record({ limit: fc.integer({ min: 1, max: 8 }), anchor: fc.option(fc.nat(13), { nil: undefined }) });

describe("retrieval, for any graph, principal and query", () => {
  const run = (property: (g: Graph, p: Principal, q: string, o: { limit: number; from?: string }) => void | Promise<void>) =>
    fc.assert(
      fc.asyncProperty(graph, principal, query, options, async (g, p, q, { limit, anchor }) => {
        await property(g, p, q, { limit, ...(anchor === undefined ? {} : { from: `n${anchor % g.nodes.size}` }) });
      }),
      { numRuns: 1500 },
    );
  const SLOW = 120_000;

  it("returns only nodes the principal can read", async () => {
    await run((g, p, q, o) => {
      for (const node of retrieve(g, p, q, o)) expect(canRead(p, node.scope)).toBe(true);
    });
  }, SLOW);

  it("returns the same nodes in the same order once every unreadable node is removed", async () => {
    await run((g, p, q, o) => {
      expect(ids(retrieve(g, p, q, o))).toEqual(ids(retrieve(readablePart(g, p), p, q, o)));
    });
  }, SLOW);

  it("fits the same context once every unreadable node is removed", async () => {
    await run((g, p, q, o) => {
      const fit = (graph: Graph) => fitContext(retrieve(graph, p, q, o), q, 40);
      expect(fit(g)).toEqual(fit(readablePart(g, p)));
    });
  }, SLOW);

  it("gives through a text index what a scan of the graph gives", async () => {
    await run(async (g, p, q, o) => {
      const store = memoryStore();
      await store.upsertNodes([...g.nodes.values()]);
      await store.upsertEdges(g.edges);
      expect(ids(await searchGraph(await store.snapshot(), scanIndex(store), p, q, o))).toEqual(ids(retrieve(g, p, q, o)));
    });
  }, SLOW);

  it("gives the same through a text index that also matches unreadable nodes", async () => {
    await run(async (g, p, q, o) => {
      const whole = memoryStore();
      await whole.upsertNodes([...g.nodes.values()]);
      await whole.upsertEdges(g.edges);
      const part = readablePart(g, p);
      const visible = memoryStore();
      await visible.upsertNodes([...part.nodes.values()]);
      await visible.upsertEdges(part.edges);
      expect(ids(await searchGraph(await whole.snapshot(), scanIndex(whole), p, q, o))).toEqual(ids(await searchGraph(await visible.snapshot(), scanIndex(visible), p, q, o)));
    });
  }, SLOW);
});
