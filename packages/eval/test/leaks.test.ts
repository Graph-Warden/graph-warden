import { describe, expect, it } from "vitest";
import { createGraph, type Node, type Scope } from "@graph-warden/core";
import type { RetrievalCases } from "../src/eval.js";
import { label, principalsOf, readablePart, retrieveSearch, runLeakEval } from "../src/leaks.js";

// The leak harness itself: it must find nothing on a graph that respects scopes, and find the leak
// when one is planted.

const node = (id: string, scope: Scope, body = id): Node => ({ id, type: "Decision", scope, body, provenance: { source: "test", path: id } });

const graph = createGraph(
  [node("a", { kind: "shared" }, "orders paginate cursor"), node("b", { kind: "team", team: "bff" }, "orders paginate"), node("c", { kind: "private", user: "lea" }, "orders paginate secret")],
  [
    { type: "REFERENCES", from: "a", to: "b" },
    { type: "REFERENCES", from: "b", to: "c" },
  ],
);

const cases: RetrievalCases = { queries: [{ id: "q", kind: "lexical", query: "orders paginate", relevant: ["a"] }] };
const memberOfBff = { user: "member-of-bff", teams: ["bff"] };

describe("leak measurement", () => {
  it("reads every boundary the corpus draws, from both sides", () => {
    const { principals, teams, users } = principalsOf(graph);
    expect(teams).toEqual(["bff"]);
    expect(users).toEqual(["lea"]);
    expect(principals.map(label)).toEqual(["outsider [no team]", "member-of-bff [bff]", "lea [no team]", "member-of-every-team [bff]"]);
  });

  it("takes the unreadable nodes and their edges away", () => {
    const view = readablePart(graph, { user: "outsider", teams: [] });
    expect([...view.nodes.keys()]).toEqual(["a"]);
    expect(view.edges).toEqual([]);
  });

  it("finds nothing when the search respects the scopes", () => {
    expect(runLeakEval(graph, cases, principalsOf(graph).principals, retrieveSearch(8)).found).toEqual([]);
  });

  it("reports a node the reader cannot read", () => {
    const everything = (g: typeof graph) => [...g.nodes.keys()];
    const found = runLeakEval(graph, cases, principalsOf(graph).principals, everything).found;
    expect(found.find((check) => check.principal === "outsider [no team]")).toMatchObject({ outside: ["b", "c"], drift: ["b", "c"] });
  });

  it("reports a readable result that only the unreadable nodes moved", () => {
    // A limit applied before the scope cut: the hidden node takes the place of a readable one, so
    // what the reader gets changes although everything they see is theirs.
    const limitBeforeTheCut = (g: typeof graph) => [...g.nodes.keys()].sort().slice(0, -1).slice(0, 2);
    const found = runLeakEval(graph, cases, principalsOf(graph).principals, limitBeforeTheCut).found;
    expect(found.find((check) => check.principal === label(memberOfBff))).toMatchObject({ outside: [], drift: ["b"] });
  });
});
