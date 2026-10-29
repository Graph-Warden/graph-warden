import { describe, expect, it } from "vitest";
import { createGraph, traverse, type Edge, type Node, type Principal, type Scope } from "../src/index.js";

function node(id: string, scope: Scope): Node {
  return { id, type: "Module", scope, provenance: { source: "github:acme/shop", path: `${id}.ts` } };
}

function imports(from: string, to: string): Edge {
  return { type: "IMPORTS", from, to };
}

const shared: Scope = { kind: "shared" };
const alice: Principal = { user: "alice", teams: ["front-a"] };
const ids = (nodes: readonly Node[]) => nodes.map((n) => n.id);

describe("traverse", () => {
  // app -> bff-secret (team bff) -> client (shared); app -> util (shared) -> client
  const graph = createGraph(
    [
      node("app", shared),
      node("bff-secret", { kind: "team", team: "bff" }),
      node("util", shared),
      node("client", shared),
      node("behind-secret", shared),
    ],
    [
      imports("app", "bff-secret"),
      imports("app", "util"),
      imports("util", "client"),
      imports("bff-secret", "client"),
      imports("bff-secret", "behind-secret"),
    ],
  );

  it("returns reachable nodes nearest first, without the start", () => {
    const bff: Principal = { user: "bob", teams: ["bff"] };
    expect(ids(traverse(graph, bff, "app"))).toEqual(["bff-secret", "util", "client", "behind-secret"]);
  });

  it("never returns a node outside the reader's scopes", () => {
    expect(ids(traverse(graph, alice, "app"))).not.toContain("bff-secret");
  });

  it("does not cross an unreadable node, even to reach a readable one", () => {
    expect(ids(traverse(graph, alice, "app"))).toEqual(["util", "client"]);
  });

  it("treats an unreadable start like an unknown one", () => {
    expect(traverse(graph, alice, "bff-secret")).toEqual([]);
    expect(traverse(graph, alice, "missing")).toEqual([]);
  });

  it("follows inbound edges", () => {
    expect(ids(traverse(graph, alice, "client", { direction: "in" }))).toEqual(["util", "app"]);
  });

  it("stops at maxDepth", () => {
    expect(ids(traverse(graph, alice, "app", { maxDepth: 1 }))).toEqual(["util"]);
  });

  it("follows only the requested edge types", () => {
    expect(traverse(graph, alice, "app", { edgeTypes: ["CONSUMES"] })).toEqual([]);
  });

  it("terminates on cycles", () => {
    const cyclic = createGraph([node("a", shared), node("b", shared)], [imports("a", "b"), imports("b", "a")]);
    expect(ids(traverse(cyclic, alice, "a"))).toEqual(["b"]);
  });
});

describe("createGraph", () => {
  it("rejects duplicate node ids", () => {
    expect(() => createGraph([node("a", shared), node("a", shared)], [])).toThrow(/Duplicate/);
  });

  it("rejects an edge to an unknown node", () => {
    expect(() => createGraph([node("a", shared)], [imports("a", "ghost")])).toThrow(/unknown node/);
  });
});
