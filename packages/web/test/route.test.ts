import { describe, expect, it } from "vitest";
import { askHref, editHref, graphHref, parseRoute, searchHref } from "../src/route.js";
import { pageHref } from "../src/markdown.js";

describe("routes", () => {
  it("round-trip every link the app makes, ids with slashes and spaces included", () => {
    const id = "team/run book";
    expect(parseRoute(pageHref(id))).toEqual({ view: "node", id });
    expect(parseRoute(graphHref(id))).toEqual({ view: "graph", id });
    expect(parseRoute(graphHref())).toEqual({ view: "graph" });
    expect(parseRoute(editHref(id))).toEqual({ view: "edit", id });
    expect(parseRoute(editHref())).toEqual({ view: "edit" });
    expect(parseRoute(askHref(id))).toEqual({ view: "ask", from: id });
    expect(parseRoute(searchHref("a&b c"))).toEqual({ view: "search", query: "a&b c" });
  });

  it("falls back to the home view, and keeps a malformed id as typed", () => {
    expect(parseRoute("")).toEqual({ view: "home" });
    expect(parseRoute("#/nowhere")).toEqual({ view: "home" });
    expect(parseRoute("#/node/%E0%A4%A")).toEqual({ view: "node", id: "%E0%A4%A" });
  });
});
