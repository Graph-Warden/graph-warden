import { formatScope as coreFormatScope, NodeTypeSchema, type Delta, type Node, type Scope } from "@graph-warden/core";
import { describe, expect, it } from "vitest";
import { applyDelta, empty, filterNodes, formatScope, incoming, neighbourhood, NODE_TYPES, outgoing } from "../src/graph.js";

const node = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  type: "Concept",
  scope: { kind: "shared" },
  provenance: { source: "docs", path: `${id}.md` },
  ...extra,
});

const delta = (cursor: number, part: Partial<Delta>): Delta => ({ cursor, nodes: [], edges: [], removed: [], ...part });

describe("the web copy of the readable graph", () => {
  const start = applyDelta(
    empty,
    delta(3, {
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        { type: "REFERENCES", from: "a", to: "b" },
        { type: "DERIVED_FROM", from: "c", to: "a" },
      ],
    }),
  );

  it("holds what a full pull sent", () => {
    expect([...start.nodes.keys()]).toEqual(["a", "b", "c"]);
    expect(outgoing(start, "a").map((r) => r.node.id)).toEqual(["b"]);
    expect(incoming(start, "a")).toEqual([{ type: "DERIVED_FROM", node: start.nodes.get("c") }]);
    expect(start.cursor).toBe(3);
  });

  it("drops removed nodes with their edges", () => {
    const next = applyDelta(start, delta(4, { removed: ["b"] }));
    expect(next.nodes.has("b")).toBe(false);
    expect(outgoing(next, "a")).toEqual([]);
    expect(next.edges).toHaveLength(1);
  });

  it("replaces the edges of the nodes a delta sends", () => {
    const next = applyDelta(start, delta(5, { nodes: [node("a", { title: "A" })], edges: [{ type: "DERIVED_FROM", from: "c", to: "a" }] }));
    expect(next.nodes.get("a")?.title).toBe("A");
    expect(outgoing(next, "a")).toEqual([]);
    expect(incoming(next, "a")).toHaveLength(1);
  });

  it("ignores edges to nodes it does not hold", () => {
    expect(applyDelta(empty, delta(1, { nodes: [node("a")], edges: [{ type: "REFERENCES", from: "a", to: "hidden" }] })).edges).toEqual([]);
  });

  it("finds nodes by every word, names first", () => {
    const store = applyDelta(empty, delta(1, { nodes: [node("x", { body: "about retries" }), node("retry-policy", { title: "Retries" })] }));
    expect(filterNodes(store, "retr").map((n) => n.id)).toEqual(["retry-policy", "x"]);
    expect(filterNodes(store, "retries about").map((n) => n.id)).toEqual(["x"]);
  });

  it("draws the nodes within a few hops of a focus, either way", () => {
    const chain = applyDelta(
      empty,
      delta(1, {
        nodes: ["a", "b", "c", "d"].map((id) => node(id)),
        edges: [
          { type: "REFERENCES", from: "a", to: "b" },
          { type: "DERIVED_FROM", from: "c", to: "b" },
          { type: "REFERENCES", from: "c", to: "d" },
        ],
      }),
    );
    expect(neighbourhood(chain, "a", 2).nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(neighbourhood(chain, "a", 2).edges).toHaveLength(2);
    expect(neighbourhood(chain, undefined).nodes).toHaveLength(4);
    expect(neighbourhood(chain, "unknown")).toEqual({ nodes: [], edges: [] });
  });

  it("agrees with core on node types and scope names", () => {
    expect([...NODE_TYPES]).toEqual(NodeTypeSchema.options);
    const scopes: Scope[] = [{ kind: "shared" }, { kind: "team", team: "a" }, { kind: "teams", teams: ["a", "b"] }, { kind: "private", user: "u" }];
    for (const scope of scopes) expect(formatScope(scope)).toBe(coreFormatScope(scope));
  });
});
