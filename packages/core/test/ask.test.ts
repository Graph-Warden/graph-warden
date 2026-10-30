import { describe, expect, it } from "vitest";
import {
  createAsker,
  createGraph,
  createWriter,
  Forbidden,
  NOTHING_FOUND,
  retrieve,
  type LLMProvider,
  type Node,
  type Principal,
  type Scope,
} from "../src/index.js";
import { memoryAudit, memoryEvents, memoryStore } from "./memory.js";

const node = (id: string, scope: Scope, body: string): Node => ({ id, type: "Concept", scope, provenance: { source: "docs", path: id }, body });
const bff: Scope = { kind: "team", team: "bff" };
const front: Scope = { kind: "team", team: "front" };
const bob: Principal = { user: "bob", teams: ["dev", "bff", "writers"] };
const lea: Principal = { user: "lea", teams: ["dev", "bff", "front", "writers"] };

const nodes = [
  node("orders-api", { kind: "shared" }, "GET /orders lists orders, paginated by offset."),
  node("adr-0007", bff, "Orders pagination moves from offset to cursor."),
  node("checkout", front, "Checkout pages through orders with the offset."),
  node("falcon", { kind: "team", team: "m-and-a" }, "Project Falcon: acquire a retailer. Orders volume doubles."),
];

// A model that repeats which documents it was given, so tests can see exactly what it read.
function echo(): LLMProvider & { readonly prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async ({ prompt }) => {
      prompts.push(prompt);
      return [...prompt.matchAll(/<document id="([^"]+)"/g)].map((m) => `[[${m[1]}]]`).join(" ");
    },
  };
}

async function setup() {
  const store = memoryStore();
  const audit = memoryAudit();
  const writer = createWriter(store, memoryEvents());
  await writer.upsertNodes(nodes);
  await writer.upsertEdges([{ type: "DECIDES", from: "adr-0007", to: "orders-api" }]);
  const llm = echo();
  return { store, audit, llm, asker: createAsker(store, writer, audit, llm, { writers: ["writers"] }) };
}

describe("retrieve", () => {
  const graph = createGraph(nodes, [{ type: "DECIDES", from: "adr-0007", to: "orders-api" }]);

  it("picks only nodes the principal may read, best match first", () => {
    expect(retrieve(graph, bob, "How are orders paginated?").map((n) => n.id)).toEqual(["orders-api", "adr-0007"]);
    expect(retrieve(graph, lea, "orders offset").map((n) => n.id)).toEqual(["orders-api", "adr-0007", "checkout"]);
  });

  it("puts an anchor and its readable neighbours first", () => {
    expect(retrieve(graph, bob, "anything", { from: "adr-0007" }).map((n) => n.id)).toEqual(["adr-0007", "orders-api"]);
    expect(retrieve(graph, bob, "anything", { from: "falcon" })).toEqual([]);
  });
});

describe("ask", () => {
  it("hands the model only readable nodes, and records them before it reads", async () => {
    const { asker, llm, audit } = await setup();
    const result = await asker.ask(bob, "What about orders volume?");
    expect(result.sources.map((n) => n.id)).toEqual(["orders-api", "adr-0007"]);
    expect(llm.prompts.join()).not.toMatch(/falcon|Falcon|retailer/);
    expect(audit.written).toMatchObject([{ action: "ask", question: "What about orders volume?", returned: ["orders-api", "adr-0007"] }]);
  });

  it("does not call the model when nothing readable matches", async () => {
    const { asker, llm } = await setup();
    expect((await asker.ask(bob, "acquisition retailer")).answer).toBe(NOTHING_FOUND);
    expect(llm.prompts).toEqual([]);
  });

  it("files the answer private to the asker by default, derived from every node read", async () => {
    const { asker, store } = await setup();
    const { saved } = await asker.ask(bob, "How are orders paginated?", { save: {} });
    expect(saved?.scope).toEqual({ kind: "private", user: "bob" });
    const graph = await store.snapshot();
    expect(graph.edges.filter((e) => e.from === saved?.id).map((e) => [e.type, e.to]).sort()).toEqual([
      ["DERIVED_FROM", "adr-0007"],
      ["DERIVED_FROM", "orders-api"],
    ]);
  });

  it("narrows a shared answer to the readers of all its sources", async () => {
    const { asker } = await setup();
    const { saved } = await asker.ask(lea, "orders offset", { save: { scope: { kind: "shared" } } });
    expect(saved?.scope).toEqual({ kind: "teams", teams: ["bff", "front"] });
  });

  it("lets only writer groups file answers", async () => {
    const { asker, llm, audit } = await setup();
    const reader: Principal = { user: "carl", teams: ["dev"] };
    await expect(asker.ask(reader, "orders", { save: {} })).rejects.toThrow(Forbidden);
    expect(llm.prompts).toEqual([]);
    expect(audit.written).toMatchObject([{ action: "ask", denied: true }]);
  });
});
