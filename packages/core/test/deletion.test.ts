import { describe, expect, it } from "vitest";
import {
  Conflict,
  createEditor,
  createGraph,
  createReader,
  createWriter,
  Forbidden,
  NotFound,
  planDeletion,
  Unreachable,
  type Edge,
  type Node,
  type Principal,
  type Scope,
} from "../src/index.js";
import { memoryAudit, memoryEvents, memoryStore } from "./memory.js";

const node = (id: string, scope: Scope = { kind: "shared" }): Node => ({ id, type: "Concept", scope, provenance: { source: "docs", path: id } });
const derived = (from: string, to: string): Edge => ({ type: "DERIVED_FROM", from, to });
const bff: Scope = { kind: "team", team: "bff" };
const lea: Principal = { user: "lea", teams: ["dev", "bff", "writers"] };
const bob: Principal = { user: "bob", teams: ["dev"] };

// adr <- summary (adr only) <- digest (summary only)
// adr <- impact (adr + checkout)
// module -> adr (IMPORTS: not a derivation)
const graph = createGraph(
  [node("adr"), node("checkout"), node("summary"), node("digest"), node("impact"), node("module")],
  [
    derived("summary", "adr"),
    derived("digest", "summary"),
    derived("impact", "adr"),
    derived("impact", "checkout"),
    { type: "IMPORTS", from: "module", to: "adr" },
  ],
);

describe("planDeletion", () => {
  it("deletes the derived nodes left without a source, down the chain", () => {
    const plan = planDeletion(graph, lea, "adr");
    expect(plan.deleted.map((n) => n.id)).toEqual(["adr", "summary", "digest"]);
  });

  it("only detaches a derived node that has other sources", () => {
    const plan = planDeletion(graph, lea, "adr");
    expect(plan.detached).toEqual([derived("impact", "adr")]);
  });

  it("never deletes what the node points to, nor what merely references it", () => {
    expect(planDeletion(graph, lea, "summary").deleted.map((n) => n.id)).toEqual(["summary", "digest"]);
    expect(planDeletion(graph, lea, "adr").deleted.map((n) => n.id)).not.toContain("module");
    expect(planDeletion(graph, lea, "impact").deleted.map((n) => n.id)).toEqual(["impact"]);
  });

  it("deletes a node derived from several sources once all of them are gone", () => {
    const g = createGraph([node("a"), node("b"), node("ab")], [derived("ab", "a"), derived("ab", "b")]);
    expect(planDeletion(g, lea, "a").deleted.map((n) => n.id)).toEqual(["a"]);
    const withoutA = createGraph([node("b"), node("ab")], [derived("ab", "b")]);
    expect(planDeletion(withoutA, lea, "b").deleted.map((n) => n.id)).toEqual(["b", "ab"]);
  });

  it("treats an unreadable node like an unknown one", () => {
    const g = createGraph([node("secret", bff)], []);
    expect(() => planDeletion(g, bob, "secret")).toThrow(NotFound);
    expect(() => planDeletion(g, bob, "nothing")).toThrow(NotFound);
  });

  it("refuses a deletion that reaches a node the principal may not read, naming none", () => {
    const g = createGraph([node("adr"), node("hidden", bff)], [derived("hidden", "adr")]);
    expect(() => planDeletion(g, bob, "adr")).toThrow(Unreachable);
    expect(() => planDeletion(g, bob, "adr")).not.toThrow(/hidden/);
    const detachOnly = createGraph([node("adr"), node("x"), node("hidden", bff)], [derived("hidden", "adr"), derived("hidden", "x")]);
    expect(() => planDeletion(detachOnly, bob, "adr")).toThrow(Unreachable);
  });

  it("gives the same plan the same digest, and a different plan another", () => {
    expect(planDeletion(graph, lea, "adr").digest).toBe(planDeletion(graph, lea, "adr").digest);
    expect(planDeletion(graph, lea, "adr").digest).not.toBe(planDeletion(graph, lea, "summary").digest);
  });
});

async function setup() {
  const store = memoryStore();
  const events = memoryEvents();
  const audit = memoryAudit();
  const writer = createWriter(store, events);
  await writer.upsertNodes([...graph.nodes.values()].map((n) => (n.id === "impact" ? { ...n, scope: { kind: "teams", teams: ["bff", "front"] } as Scope } : n)));
  await writer.upsertEdges(graph.edges);
  const editor = createEditor(store, writer, audit, { writers: ["writers"] });
  return { store, events, audit, writer, editor, reader: createReader(store, audit, { events }) };
}

describe("editor", () => {
  const leadAll: Principal = { ...lea, teams: [...lea.teams, "front"] };

  it("deletes what the confirmed plan shows, and records it before writing", async () => {
    const { store, editor, audit } = await setup();
    const plan = await editor.planDeletion(leadAll, "adr");
    await editor.deleteNode(leadAll, "adr", plan.digest);
    const after = await store.snapshot();
    expect([...after.nodes.keys()].sort()).toEqual(["checkout", "impact", "module"]);
    expect(after.edges).toEqual([derived("impact", "checkout")]);
    expect(audit.written.map((e) => e.action === "delete" && { planned: e.planned, returned: e.returned, detached: e.detached })).toEqual([
      { planned: true, returned: ["adr", "summary", "digest"], detached: ["impact>adr"] },
      { planned: undefined, returned: ["adr", "summary", "digest"], detached: ["impact>adr"] },
    ]);
  });

  it("keeps the scope of a node that loses a source", async () => {
    const { store, editor } = await setup();
    await editor.deleteNode(leadAll, "adr", (await editor.planDeletion(leadAll, "adr")).digest);
    expect((await store.getNode("impact"))?.scope).toEqual({ kind: "teams", teams: ["bff", "front"] });
  });

  it("refuses a digest that no longer matches the graph", async () => {
    const { editor, writer, store } = await setup();
    const plan = await editor.planDeletion(leadAll, "adr");
    await writer.upsertNodes([node("late")]);
    await writer.upsertEdges([derived("late", "adr")]);
    await expect(editor.deleteNode(leadAll, "adr", plan.digest)).rejects.toThrow(Conflict);
    expect(await store.getNode("adr")).toBeDefined();
  });

  it("lets only writer groups delete, and records the refusal", async () => {
    const { editor, audit, store } = await setup();
    const reader: Principal = { user: "carl", teams: ["dev", "bff", "front"] };
    await expect(editor.planDeletion(reader, "adr")).rejects.toThrow(Forbidden);
    await expect(editor.deleteNode(reader, "adr", "anything")).rejects.toThrow(Forbidden);
    expect(audit.written.map((e) => e.action === "delete" && e.denied)).toEqual([true, true]);
    expect(await store.getNode("adr")).toBeDefined();
  });

  it("records a refused preview of an unknown or unreadable node like any refusal", async () => {
    const { editor, audit } = await setup();
    await expect(editor.planDeletion(lea, "nothing")).rejects.toThrow(NotFound);
    expect(audit.written).toMatchObject([{ action: "delete", target: "nothing", planned: true, denied: true, returned: [] }]);
  });

  it("tells pulling clients to drop what was deleted and the edges detached", async () => {
    const { editor, reader } = await setup();
    const before = await reader.pull(leadAll, 0);
    await editor.deleteNode(leadAll, "adr", (await editor.planDeletion(leadAll, "adr")).digest);
    const delta = await reader.pull(leadAll, before.cursor);
    expect([...delta.removed].sort()).toEqual(["adr", "digest", "summary"]);
    expect(delta.nodes.map((n) => n.id)).toContain("impact");
    expect(delta.edges).toEqual([derived("impact", "checkout")]);
  });
});
