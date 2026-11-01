import { describe, expect, it } from "vitest";
import { changeId, createGraph, createHistory, UnknownCommit, type Edge, type Graph, type Node, type PastGraphs, type Scope } from "../src/index.js";
import { memoryAudit, memoryStore } from "./memory.js";

const REPO = "github:acme/shop";
const node = (id: string, scope: Scope, extra: Partial<Node> = {}): Node => ({ id, type: "Concept", scope, provenance: { source: REPO, path: `${id}.md` }, ...extra });
const shared: Scope = { kind: "shared" };
const bff: Scope = { kind: "team", team: "bff" };
const bob = { user: "bob", teams: ["bff"] };
const yan = { user: "yan", teams: ["data"] };

function setup(past: { at?: Record<string, Graph>; before?: Graph; after?: Graph; changed?: string[]; commits?: string[] }) {
  const store = memoryStore();
  const audit = memoryAudit();
  const graphs: PastGraphs = {
    repositories: new Map([[REPO, { scope: shared }]]),
    commits: async () => (past.commits ?? []).map((sha) => ({ sha, message: `Commit ${sha}\n\nWhy.` })),
    at: async (_repo, sha) => past.at?.[sha],
    between: async () =>
      past.before === undefined || past.after === undefined ? undefined : { before: past.before, after: past.after, changed: past.changed ?? [], commits: 1 },
  };
  return { store, audit, history: createHistory(store, audit, graphs) };
}

describe("history", () => {
  it("shows a past node only to who may read it both then and now", async () => {
    const then = createGraph(
      [
        node("kept", shared),
        node("narrowed-since", shared),
        node("shared-since", bff, { body: "before it was cleaned up" }),
        node("gone", shared),
        node("gone-private", { kind: "private", user: "alice" }),
      ],
      [
        { type: "IMPORTS", from: "kept", to: "narrowed-since" },
        { type: "IMPORTS", from: "kept", to: "gone" },
      ],
    );
    const { store, audit, history } = setup({ at: { abc1234: then } });
    await store.upsertNodes([node("kept", shared), node("narrowed-since", { kind: "team", team: "data" }), node("shared-since", shared)]);

    const view = await history.at(bob, REPO, "abc1234");
    // Bob left the Data team's node, narrowed since, out; gone ones as git still has them.
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["gone", "kept", "shared-since"]);
    expect(view.edges).toEqual([{ type: "IMPORTS", from: "kept", to: "gone" }]);
    // Yan may read the narrowed node, not the one that was BFF's then.
    expect((await history.at(yan, REPO, "abc1234")).nodes.map((n) => n.id).sort()).toEqual(["gone", "kept", "narrowed-since"]);
    expect(audit.written[0]).toMatchObject({ action: "history", repo: REPO, sha: "abc1234", returned: ["kept", "shared-since", "gone"] });
  });

  it("has no past for an erased repository: git still holds what the graph let go", async () => {
    const graph = createGraph([], []);
    const { store, history } = setup({ at: { abc1234: graph }, before: graph, after: graph, commits: ["abc1234"] });
    await store.markErased(REPO);
    await expect(history.commits(bob, REPO)).rejects.toThrow(UnknownCommit);
    await expect(history.at(bob, REPO, "abc1234")).rejects.toThrow(UnknownCommit);
    await expect(history.impact(bob, REPO, "abc1234", "def5678")).rejects.toThrow(UnknownCommit);
    await store.readmit(REPO);
    expect((await history.commits(bob, REPO)).map((n) => n.id)).toEqual([changeId(REPO, "abc1234")]);
  });

  it("refuses an unknown repository or commit", async () => {
    const { history } = setup({});
    await expect(history.at(bob, REPO, "abc1234")).rejects.toThrow(UnknownCommit);
    await expect(history.at(bob, "github:acme/other", "abc1234")).rejects.toThrow(UnknownCommit);
    await expect(history.impact(bob, REPO, "abc1234", "def5678")).rejects.toThrow(UnknownCommit);
  });

  it("lists the commits as the Change nodes the reader may read, newest first, ingested or not", async () => {
    const { store, history } = setup({ commits: ["c3c3c3c", "c2c2c2c", "c1c1c1c"] });
    const change = (sha: string, scope: Scope): Node => ({ id: changeId(REPO, sha), type: "Change", scope, provenance: { source: REPO, path: ".", sha } });
    await store.upsertNodes([change("c1c1c1c", shared), change("c2c2c2c", { kind: "team", team: "data" })]);
    const commits = await history.commits(bob, REPO);
    expect(commits.map((n) => n.id)).toEqual([changeId(REPO, "c3c3c3c"), changeId(REPO, "c1c1c1c")]);
    // Not ingested: as the ingester would write it, in the repository's scope.
    expect(commits[0]).toEqual({ ...change("c3c3c3c", shared), title: "Commit c3c3c3c", body: "Why." });
  });

  it("draws a pull request's impact around what it changes, without what the reader may not see now", async () => {
    const endpoint = node("orders", shared, { type: "Endpoint" });
    const nodes = [
      endpoint,
      node("front", shared, { type: "Module" }),
      node("data-job", shared, { type: "Module" }),
      node("adr", bff, { body: "We page with cursors." }),
      node("far", shared),
      node("farther", shared),
    ];
    const edges: Edge[] = [
      { type: "CONSUMES", from: "front", to: "orders" },
      { type: "CONSUMES", from: "data-job", to: "orders" },
      { type: "DECIDES", from: "adr", to: "orders" },
      { type: "IMPORTS", from: "far", to: "front" },
      { type: "IMPORTS", from: "farther", to: "far" },
    ];
    const before = createGraph(nodes, edges);
    const after = createGraph([...nodes.filter((n) => n.id !== "orders"), { ...endpoint, title: "GET /orders, paged" }], edges);
    const { store, audit, history } = setup({ before, after, changed: ["orders"] });
    // Since the pull request was opened, the Data team's job became theirs alone.
    await store.upsertNodes([...nodes.filter((n) => n.id !== "data-job"), node("data-job", { kind: "team", team: "data" }, { type: "Module" })]);

    const view = await history.impact(bob, REPO, "abc1234", "def5678");
    expect(view.highlighted).toEqual(["adr", "front", "orders"]);
    // With their neighbours, one hop away.
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["adr", "far", "front", "orders"]);
    expect(view.impact.consumers.map((c) => c.module.id)).toEqual(["front"]);
    expect(view.impact.knowledge.map((n) => n.id)).toEqual(["adr"]);
    expect(view.impact.teams).toEqual(["bff"]);
    expect(audit.written[0]).toMatchObject({ action: "impact", repo: REPO, base: "abc1234", head: "def5678" });

    const yans = await history.impact(yan, REPO, "abc1234", "def5678");
    expect(yans.highlighted).toEqual(["data-job", "front", "orders"]);
    expect(yans.impact.teams).toEqual([]);
  });
});
