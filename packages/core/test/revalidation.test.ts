import { describe, expect, it } from "vitest";
import {
  createReader,
  createRevalidator,
  createWriter,
  findRelated,
  isKnowledge,
  parseVerdict,
  type Edge,
  type LLMProvider,
  type Node,
  type Scope,
  type StaleMark,
  type StaleMarks,
} from "../src/index.js";
import { memoryAudit, memoryEvents, memoryStore } from "./memory.js";

const repo = "github:acme/shop";
const node = (id: string, type: string, scope: Scope = { kind: "shared" }, body?: string): Node => ({
  id,
  type,
  scope,
  provenance: { source: repo, path: `${id}.ts` },
  ...(body === undefined ? {} : { body }),
});

// A chain of imports app -> c -> b -> leaf, an endpoint exposed by b and consumed by a front-end,
// decisions on each, a summary derived from a decision, and knowledge unrelated to the leaf.
const nodes: Node[] = [
  node("leaf", "Module"),
  node("b", "Module"),
  node("c", "Module"),
  node("app", "Module"),
  node("orders", "Endpoint", { kind: "shared" }, "GET /orders"),
  node("front", "Module"),
  node("adr-leaf", "Decision", { kind: "team", team: "bff" }, "The leaf rounds to cents."),
  node("adr-b", "Decision", { kind: "shared" }, "b paginates by cursor."),
  node("summary", "Concept", { kind: "team", team: "front-a" }, "Front-a relies on cursor pagination."),
  node("adr-front", "Decision", { kind: "shared" }, "front retries GET /orders."),
  node("adr-app", "Decision", { kind: "shared" }, "app boots last."),
  node("unrelated", "Module"),
  node("adr-unrelated", "Decision", { kind: "shared" }, "Unrelated."),
  node("change", "Change", { kind: "team", team: "bff" }),
];
const edges: Edge[] = [
  { type: "IMPORTS", from: "b", to: "leaf" },
  { type: "IMPORTS", from: "c", to: "b" },
  { type: "IMPORTS", from: "app", to: "c" },
  { type: "EXPOSES", from: "b", to: "orders" },
  { type: "CONSUMES", from: "front", to: "orders" },
  { type: "DECIDES", from: "adr-leaf", to: "leaf" },
  { type: "DECIDES", from: "adr-b", to: "b" },
  { type: "DERIVED_FROM", from: "summary", to: "adr-b" },
  { type: "DECIDES", from: "adr-front", to: "front" },
  { type: "DECIDES", from: "adr-app", to: "app" },
  { type: "DECIDES", from: "adr-unrelated", to: "unrelated" },
  { type: "MODIFIES", from: "change", to: "leaf" },
];

function memoryMarks(): StaleMarks & { readonly all: Map<string, StaleMark> } {
  const all = new Map<string, StaleMark>();
  return {
    all,
    mark: async (list) => void list.forEach((m) => all.set(m.id, m)),
    get: async (id) => all.get(id),
    clear: async (id) => void all.delete(id),
    clearSource: async () => {},
  };
}

// A model that answers from a table, counting its calls.
function scriptedModel(verdicts: Record<string, string> = {}): LLMProvider & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async complete({ prompt }) {
      const id = /<document id="([^"]+)"/.exec(prompt)?.[1] ?? "";
      asked.push(id);
      return verdicts[id] ?? '{"verdict": "valid", "reason": "Nothing changed for it."}';
    },
  };
}

async function setup(llm: LLMProvider, maxDepth?: number) {
  const store = memoryStore();
  const writer = createWriter(store, memoryEvents());
  await writer.upsertNodes(nodes);
  await writer.upsertEdges(edges);
  const marks = memoryMarks();
  const revalidator = createRevalidator({ store, writer, llm, marks, ...(maxDepth === undefined ? {} : { maxDepth }) });
  return { store, writer, marks, revalidator };
}

const context = { change: "change", changed: ["leaf"], evidence: "leaf.ts: round to the euro", author: { user: "pipeline", teams: ["bff", "front-a"] } };

describe("findRelated", () => {
  it("follows each edge type towards what depends on the change", async () => {
    const { store } = await setup(scriptedModel());
    const { depth } = findRelated(await store.snapshot(), ["leaf"]);
    expect(Object.fromEntries(depth)).toEqual({
      "adr-leaf": 1,
      b: 1,
      c: 2,
      "adr-b": 2,
      orders: 2,
      app: 3,
      summary: 3,
      front: 3,
      "adr-app": 4,
      "adr-front": 4,
    });
  });
});

describe("Revalidator", () => {
  it("sends only the knowledge related to a leaf change, fewer calls than a full recompile", async () => {
    const llm = scriptedModel();
    const { store, revalidator, marks } = await setup(llm, 3);
    const report = await revalidator.revalidate(context);
    expect(llm.asked.sort()).toEqual(["adr-b", "adr-leaf", "summary"]);
    expect(report.stale.sort()).toEqual(["adr-app", "adr-front"]);
    expect([...marks.all.keys()].sort()).toEqual(["adr-app", "adr-front"]);

    // A full recompile asks about every piece of knowledge in the graph.
    const full = [...(await store.snapshot()).nodes.values()].filter(isKnowledge).length;
    expect(full).toBe(6);
    expect(llm.asked.length + report.stale.length).toBeLessThan(full);
  });

  it("revalidates a stale node on its first read only, for a reader who may read it", async () => {
    const llm = scriptedModel();
    const { store, revalidator } = await setup(llm, 1);
    await revalidator.revalidate(context);
    llm.asked.length = 0;
    const reader = createReader(store, memoryAudit(), { refresh: revalidator.refresh });
    await expect(reader.node({ user: "eve", teams: [] }, "summary")).rejects.toThrow();
    expect(llm.asked).toEqual([]);
    await reader.node({ user: "lea", teams: ["front-a"] }, "summary");
    await reader.node({ user: "lea", teams: ["front-a"] }, "summary");
    expect(llm.asked).toEqual(["summary"]);
  });

  it("rewrites a derived node and narrows it to the readers of the code", async () => {
    const llm = scriptedModel({ summary: '{"verdict": "updated", "reason": "Rounding changed.", "body": "Front-a gets euros."}' });
    const { store, revalidator } = await setup(llm);
    const report = await revalidator.revalidate(context);
    const summary = (await store.snapshot()).nodes.get("summary");
    expect(summary?.body).toBe("Front-a gets euros.");
    // Rewritten from bff's code: front-a alone may no longer read it.
    expect(summary?.scope).toEqual({ kind: "teams", teams: ["bff", "front-a"] });
    expect(report.alerts).toEqual([]);
  });

  it("flags a contradicted node, and an ingested one it was asked to update", async () => {
    const alerts: unknown[] = [];
    const llm = scriptedModel({
      "adr-leaf": '```json\n{"verdict": "updated", "reason": "No longer cents.", "body": "Euros."}\n```',
      "adr-b": '{"verdict": "contradicted", "reason": "b no longer paginates."}',
    });
    const store = memoryStore();
    const writer = createWriter(store, memoryEvents());
    await writer.upsertNodes(nodes);
    await writer.upsertEdges(edges);
    const revalidator = createRevalidator({ store, writer, llm, marks: memoryMarks(), onAlert: (alert) => alerts.push(alert) });
    const report = await revalidator.revalidate(context);
    const graph = await store.snapshot();
    expect(graph.nodes.get("adr-leaf")?.body).toBe("The leaf rounds to cents.");
    expect(graph.edges.filter((e) => e.type === "CONTRADICTS").map((e) => `${e.from} -> ${e.to}`).sort()).toEqual(["change -> adr-b", "change -> adr-leaf"]);
    expect(report.alerts.map((a) => a.node).sort()).toEqual(["adr-b", "adr-leaf"]);
    expect(alerts).toHaveLength(2);
  });

  it("reads a verdict as models write it", () => {
    expect(parseVerdict('{"verdict": "valid", "reason": "ok", "body": null}', "x")).toEqual({ verdict: "valid", reason: "ok" });
    expect(parseVerdict('```json\n{"verdict": "valid", "reason": "a } in {text}", "body": ""}\n```\nAgain: {"verdict": "updated"}', "x")).toEqual({
      verdict: "valid",
      reason: "a } in {text}",
    });
  });

  it("refuses a verdict that is not one", () => {
    expect(() => parseVerdict("I think it is fine.", "x")).toThrow(/not JSON/);
    expect(() => parseVerdict('{"verdict": "updated", "reason": "r"}', "x")).toThrow(/body/);
    expect(() => parseVerdict('{"verdict": "maybe", "reason": "r"}', "x")).toThrow(/invalid verdict/);
  });
});
