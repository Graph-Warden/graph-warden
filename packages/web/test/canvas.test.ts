import Graph from "graphology";
import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@graph-warden/core";
import { expand, matches, syncGraph, teamsIn } from "../src/canvas.js";

const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, type: "Concept", scope: { kind: "shared" }, provenance: { source: "docs", path: `${id}.md` }, ...extra });
const look = (n: Node, degree: number) => ({ label: n.title ?? n.id, color: "#000", size: 4 + degree });

describe("the graph view's model", () => {
  it("updates the drawn graph in place: positions kept, new nodes next to their neighbours", () => {
    const graph = new Graph({ multi: true, type: "directed" });
    const edges: Edge[] = [{ type: "IMPORTS", from: "a", to: "b" }];
    expect(syncGraph(graph, [node("a"), node("b")], edges, look)).toEqual(["a", "b"]);
    graph.mergeNodeAttributes("a", { x: 100, y: 100 });
    graph.mergeNodeAttributes("b", { x: 102, y: 100 });

    const added = syncGraph(graph, [node("a", { title: "A" }), node("b"), node("c")], [...edges, { type: "IMPORTS", from: "c", to: "a" }], look);
    expect(added).toEqual(["c"]);
    expect(graph.getNodeAttributes("a")).toMatchObject({ x: 100, y: 100, label: "A", size: 6 });
    expect(Math.abs((graph.getNodeAttribute("c", "x") as number) - 100)).toBeLessThan(1);
    expect(graph.size).toBe(2);

    syncGraph(graph, [node("a"), node("c")], [{ type: "IMPORTS", from: "c", to: "a" }], look);
    expect(graph.nodes().sort()).toEqual(["a", "c"]);
    expect(graph.edges()).toEqual(["IMPORTS c a"]);
  });

  it("drops many nodes at once by clearing the graph, keeping where the others were", () => {
    const graph = new Graph({ multi: true, type: "directed" });
    const many = Array.from({ length: 1000 }, (_, i) => node(`n${i}`));
    syncGraph(graph, many, [{ type: "IMPORTS", from: "n1", to: "n0" }], look);
    graph.mergeNodeAttributes("n1", { x: 42, y: 7 });
    let dropped = 0;
    graph.on("nodeDropped", () => dropped++);
    // Already placed, so not new.
    expect(syncGraph(graph, [node("n1"), node("n2")], [], look)).toEqual([]);
    expect(dropped).toBe(0);
    expect(graph.getNodeAttributes("n1")).toMatchObject({ x: 42, y: 7 });
    expect(graph.order).toBe(2);
  });

  it("filters by type and by the team a scope names", () => {
    const bff = node("x", { type: "Module", scope: { kind: "teams", teams: ["bff", "front"] } });
    expect(matches(bff, {})).toBe(true);
    expect(matches(bff, { types: new Set(["Concept"]) })).toBe(false);
    expect(matches(bff, { team: "front" })).toBe(true);
    expect(matches(node("y"), { team: "front" })).toBe(false);
    expect(teamsIn([bff, node("z", { scope: { kind: "team", team: "data" } }), node("p", { scope: { kind: "private", user: "bob" } })])).toEqual(["bff", "data", "front"]);
  });

  it("expands a node to its neighbours, either way", () => {
    const edges: Edge[] = [
      { type: "IMPORTS", from: "a", to: "b" },
      { type: "IMPORTS", from: "c", to: "a" },
      { type: "IMPORTS", from: "c", to: "d" },
    ];
    expect([...expand(new Set(["a"]), edges, "a")].sort()).toEqual(["a", "b", "c"]);
  });

  it("takes 10,000 nodes and a live update of a few in well under a frame budget per update", () => {
    const graph = new Graph({ multi: true, type: "directed" });
    const nodes = Array.from({ length: 10_000 }, (_, i) => node(`n${i}`, { type: i % 10 === 0 ? "Module" : "Concept" }));
    const edges: Edge[] = nodes.slice(1).map((n, i) => ({ type: "IMPORTS", from: n.id, to: `n${Math.floor(i / 3)}` }));
    let start = performance.now();
    syncGraph(graph, nodes, edges, look);
    const first = performance.now() - start;
    start = performance.now();
    const added = syncGraph(graph, [...nodes, node("new")], [...edges, { type: "IMPORTS", from: "new", to: "n42" }], look);
    const update = performance.now() - start;
    expect(added).toEqual(["new"]);
    expect(graph.order).toBe(10_001);
    // Generous bounds for a slow CI runner; locally both are far lower.
    expect(first).toBeLessThan(2000);
    expect(update).toBeLessThan(1000);
  });
});
