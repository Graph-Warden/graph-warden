import { describe, expect, it } from "vitest";
import type { Delta, Node } from "@graph-warden/core";
import { openCache } from "../src/cache.js";

const node = (id: string): Node => ({ id, type: "Concept", scope: { kind: "shared" }, provenance: { source: "docs", path: id } });
const bob = { user: "bob", teams: ["bff", "dev"] };
const api = "https://gw.example.com";

describe("cache", () => {
  it("applies deltas and remembers the cursor for its API and principal", () => {
    const cache = openCache(":memory:");
    expect(cache.cursor(api)).toBe(0);
    const first: Delta = { cursor: 4, nodes: [node("a"), node("b")], edges: [{ type: "IMPORTS", from: "a", to: "b" }], removed: [] };
    cache.apply(api, bob, first);
    expect(cache.cursor(api)).toBe(4);
    expect(cache.cursor("https://other.example.com")).toBe(0);
    expect(cache.ownedBy(api, { user: "bob", teams: ["dev", "bff"] })).toBe(true);
    expect(cache.ownedBy(api, { user: "bob", teams: ["dev"] })).toBe(false);

    cache.apply(api, bob, { cursor: 6, nodes: [], edges: [], removed: ["b"] });
    expect(cache.nodes().map((n) => n.id)).toEqual(["a"]);
    expect(cache.edgeCount()).toBe(0);
    cache.close();
  });

  it("drops the edges of a sent node that the delta no longer carries", () => {
    const cache = openCache(":memory:");
    const edge = (to: string) => ({ type: "DERIVED_FROM" as const, from: "summary", to });
    cache.apply(api, bob, { cursor: 3, nodes: [node("summary"), node("a"), node("b")], edges: [edge("a"), edge("b")], removed: [] });
    cache.apply(api, bob, { cursor: 5, nodes: [node("summary")], edges: [edge("b")], removed: [] });
    expect(cache.edgeCount()).toBe(1);
    cache.close();
  });

  it("empties on clear", () => {
    const cache = openCache(":memory:");
    cache.apply(api, bob, { cursor: 1, nodes: [node("a")], edges: [], removed: [] });
    cache.clear();
    expect(cache.nodes()).toEqual([]);
    expect(cache.cursor(api)).toBe(0);
    cache.close();
  });
});
