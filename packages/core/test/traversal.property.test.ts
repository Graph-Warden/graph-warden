import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canRead, createGraph, traverse, type Edge, type Graph, type Node, type Principal, type Scope, type TraversalOptions } from "../src/index.js";

// Non-interference (proposal 0002): what a principal gets from a traversal depends only on the
// nodes they can read. Removing every unreadable node, with its edges, must leave the result
// unchanged; otherwise an out-of-scope node leaks through an id, a count or a path.

const users = ["alice", "bob", "carol"];
const teams = ["bff", "front-a", "front-b"];
const edgeTypes = ["IMPORTS", "CONSUMES", "DERIVED_FROM"] as const;

const scope: fc.Arbitrary<Scope> = fc.oneof(
  fc.constant({ kind: "shared" } as const),
  fc.constantFrom(...teams).map((team) => ({ kind: "team", team }) as const),
  fc.constantFrom(...users).map((user) => ({ kind: "private", user }) as const),
);

const principal: fc.Arbitrary<Principal> = fc.record({
  user: fc.constantFrom(...users),
  teams: fc.subarray(teams),
});

const graph: fc.Arbitrary<Graph> = fc.integer({ min: 1, max: 12 }).chain((size) =>
  fc
    .tuple(
      fc.array(scope, { minLength: size, maxLength: size }),
      fc.array(
        fc.record({
          type: fc.constantFrom(...edgeTypes),
          from: fc.nat(size - 1),
          to: fc.nat(size - 1),
        }),
        { maxLength: size * 3 },
      ),
    )
    .map(([scopes, edges]) =>
      createGraph(
        scopes.map((s, i): Node => ({ id: `n${i}`, type: "Module", scope: s, provenance: { source: "test", path: `n${i}` } })),
        edges.map((e): Edge => ({ type: e.type, from: `n${e.from}`, to: `n${e.to}` })),
      ),
    ),
);

const options: fc.Arbitrary<TraversalOptions> = fc.record(
  {
    direction: fc.constantFrom("out", "in", "both"),
    edgeTypes: fc.subarray([...edgeTypes]),
    maxDepth: fc.integer({ min: 0, max: 6 }),
  },
  { requiredKeys: [] },
);

function readablePart(g: Graph, p: Principal): Graph {
  const nodes = [...g.nodes.values()].filter((n) => canRead(p, n.scope));
  const kept = new Set(nodes.map((n) => n.id));
  return createGraph(nodes, g.edges.filter((e) => kept.has(e.from) && kept.has(e.to)));
}

describe("traverse, for any graph and principal", () => {
  const run = (property: (g: Graph, p: Principal, start: string, o: TraversalOptions) => void) =>
    fc.assert(
      fc.property(graph, principal, fc.nat(11), options, (g, p, s, o) => property(g, p, `n${s % g.nodes.size}`, o)),
      { numRuns: 2000 },
    );

  it("returns only nodes the principal can read", () => {
    run((g, p, start, o) => {
      for (const node of traverse(g, p, start, o)) expect(canRead(p, node.scope)).toBe(true);
    });
  });

  it("returns the same result once every unreadable node is removed", () => {
    run((g, p, start, o) => {
      expect(traverse(g, p, start, o)).toEqual(traverse(readablePart(g, p), p, start, o));
    });
  });
});
