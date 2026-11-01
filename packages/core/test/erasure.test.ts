import { describe, expect, it } from "vitest";
import { computeDelta, createEraser, createWriter, ErasureConflict, SourceErased, type LLMProvider, type Node, type Scope, type StaleMark, type StaleMarks } from "../src/index.js";
import { memoryAudit, memoryEvents, memoryStore } from "./memory.js";

// Issue #17: after forget, no node in the graph, no cache brought up to date and no event of the
// log carries content from the source.

const SECRET = "Patient 4711 was admitted on 2026-03-02";
const node = (id: string, source: string, body: string, scope: Scope = { kind: "shared" }): Node => ({
  id,
  type: "Concept",
  scope,
  provenance: { source, path: id },
  title: `About ${id}`,
  body,
});

// `crm` is to be forgotten. `report` is derived from crm and from wiki; `crm-summary` from crm only;
// `digest` from crm-summary only; `other` from wiki only.
const nodes = [
  node("crm-1", "crm", SECRET),
  node("crm-2", "crm", `Follow-up: ${SECRET}`),
  node("wiki-1", "wiki", "Admissions are handled by the front desk."),
  node("report", "ask:lea", `Admissions: ${SECRET}; the front desk handles them.`, { kind: "team", team: "care" }),
  node("crm-summary", "ask:lea", `Summary: ${SECRET}`),
  node("digest", "ask:lea", `Digest of: ${SECRET}`),
  node("other", "ask:lea", "The front desk handles admissions."),
];
const edges = [
  { type: "DERIVED_FROM", from: "report", to: "crm-1" },
  { type: "DERIVED_FROM", from: "report", to: "wiki-1" },
  { type: "DERIVED_FROM", from: "crm-summary", to: "crm-2" },
  { type: "DERIVED_FROM", from: "digest", to: "crm-summary" },
  { type: "DERIVED_FROM", from: "other", to: "wiki-1" },
  { type: "REFERENCES", from: "wiki-1", to: "crm-1" },
];

const dpo = { user: "dpo", teams: ["auditors"] };

function marks(): StaleMarks & { readonly all: Map<string, StaleMark> } {
  const all = new Map<string, StaleMark>();
  return {
    all,
    mark: async (list) => void list.forEach((m) => all.set(m.id, m)),
    get: async (id) => all.get(id),
    clear: async (id) => void all.delete(id),
    clearSource: async (source) => {
      for (const [id, m] of all) if (m.change.startsWith(`${source}@`)) all.delete(id);
    },
  };
}

async function setup(llm?: LLMProvider) {
  const store = memoryStore();
  const events = memoryEvents();
  const writer = createWriter(store, events);
  await writer.upsertNodes(nodes);
  await writer.upsertEdges(edges);
  const audit = memoryAudit();
  const stale = marks();
  // Marked stale by a change of crm: its evidence holds crm's content.
  await stale.mark([{ id: "other", change: "crm@5a03dc8", evidence: SECRET, author: dpo }]);
  const eraser = createEraser(store, writer, audit, { ...(llm === undefined ? {} : { llm }), marks: stale });
  return { store, events, audit, stale, eraser };
}

describe("forget", () => {
  it("without a model, deletes every node that holds content from the source", async () => {
    const { store, events, audit, stale, eraser } = await setup();
    const cursor = (await events.since(0)).at(-1)?.seq ?? 0;
    const plan = await eraser.plan(dpo, "crm");
    expect(plan.deleted.map((n) => n.id).sort()).toEqual(["crm-1", "crm-2", "crm-summary", "digest", "report"]);
    expect(plan.recompiled).toEqual([]);
    await eraser.forget(dpo, "crm", plan.digest);

    const graph = await store.snapshot();
    expect([...graph.nodes.keys()].sort()).toEqual(["other", "wiki-1"]);
    expect(JSON.stringify([...graph.nodes.values()])).not.toContain("4711");
    expect(JSON.stringify(await events.since(0))).not.toContain("4711");
    expect(stale.all.size).toBe(0);
    // A cache up to date before the erasure drops it all on its next pull.
    const delta = await computeDelta(graph, events, { user: "lea", teams: ["care"] }, cursor);
    expect([...delta.removed].sort()).toEqual(["crm-1", "crm-2", "crm-summary", "digest", "report"]);
    expect(audit.written.map((e) => `${e.action} ${"planned" in e && e.planned === true ? "planned" : "done"}`)).toEqual(["forget planned", "forget done"]);
  });

  it("with a model, recompiles a node that keeps other sources, from them only, in its scope", async () => {
    const prompts: string[] = [];
    const llm: LLMProvider = {
      async complete({ prompt }) {
        prompts.push(prompt);
        return "Admissions are handled by the front desk.";
      },
    };
    const { store, events, eraser } = await setup(llm);
    const cursor = (await events.since(0)).at(-1)?.seq ?? 0;
    const plan = await eraser.plan(dpo, "crm");
    expect(plan.recompiled.map((n) => n.id)).toEqual(["report"]);
    expect(plan.deleted.map((n) => n.id).sort()).toEqual(["crm-1", "crm-2", "crm-summary", "digest"]);
    await eraser.forget(dpo, "crm", plan.digest);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("wiki-1");
    expect(prompts[0]).not.toContain("4711");
    const graph = await store.snapshot();
    expect(graph.nodes.get("report")).toMatchObject({ body: "Admissions are handled by the front desk.", scope: { kind: "team", team: "care" } });
    expect(graph.edges.filter((e) => e.from === "report").map((e) => e.to)).toEqual(["wiki-1"]);
    expect(JSON.stringify([...graph.nodes.values()])).not.toContain("4711");
    const delta = await computeDelta(graph, events, { user: "lea", teams: ["care"] }, cursor);
    expect(delta.nodes.find((n) => n.id === "report")?.body).toBe("Admissions are handled by the front desk.");
  });

  it("refuses a confirmation of a plan the graph no longer matches", async () => {
    const { store, eraser } = await setup();
    const plan = await eraser.plan(dpo, "crm");
    await createWriter(store, memoryEvents()).upsertNodes([node("crm-3", "crm", "late")]);
    await expect(eraser.forget(dpo, "crm", plan.digest)).rejects.toThrow(ErasureConflict);
    expect((await store.snapshot()).nodes.has("crm-1")).toBe(true);
  });
});

// A source that still holds the text would bring it back: nothing keeps the text to recognise it,
// so the source itself stays out until an operator says it was cleaned.
describe("an erased source", () => {
  const erase = async () => {
    const context = await setup();
    const plan = await context.eraser.plan(dpo, "crm");
    await context.eraser.forget(dpo, "crm", plan.digest);
    return { ...context, writer: createWriter(context.store, context.events) };
  };

  it("cannot be written again", async () => {
    const { store, writer } = await erase();
    await expect(writer.upsertNodes([node("crm-1", "crm", SECRET)])).rejects.toBeInstanceOf(SourceErased);
    expect(await store.getNode("crm-1")).toBeUndefined();
  });

  it("does not stop other sources", async () => {
    const { writer, store } = await erase();
    await writer.upsertNodes([node("wiki-2", "wiki", "Visiting hours.")]);
    expect(await store.getNode("wiki-2")).toBeDefined();
  });

  it("is remembered by name, never by content", async () => {
    const { store } = await erase();
    expect([...(await store.erasedSources())]).toEqual(["crm"]);
  });

  it("stays out when the model fails before anything is erased", async () => {
    const { store, eraser } = await setup({ complete: async () => { throw new Error("model down"); } });
    const plan = await eraser.plan(dpo, "crm");
    await expect(eraser.forget(dpo, "crm", plan.digest)).rejects.toThrow("model down");
    expect((await store.erasedSources()).size).toBe(0);
  });

  it("comes back when an operator readmits it, and that is audited", async () => {
    const { store, writer, eraser, audit } = await erase();
    await eraser.readmit(dpo, "crm");
    await writer.upsertNodes([node("crm-1", "crm", "Cleaned.")]);
    expect((await store.getNode("crm-1"))?.body).toBe("Cleaned.");
    expect(audit.written.at(-1)).toMatchObject({ action: "readmit", source: "crm", returned: [], principal: dpo });
  });
});
