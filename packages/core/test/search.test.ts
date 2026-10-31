import { describe, expect, it } from "vitest";
import { checkTextIndex, createAsker, createGraph, createReader, createWriter, fitContext, queryTerms, retrieve, scanIndex, textTerms, type LLMProvider, type Node, type Principal, type Scope } from "../src/index.js";
import { memoryAudit, memoryEvents, memoryStore } from "./memory.js";

const shared: Scope = { kind: "shared" };
const node = (id: string, body: string, scope: Scope = shared, title?: string): Node => ({ id, type: "Concept", scope, provenance: { source: "docs", path: id }, body, ...(title === undefined ? {} : { title }) });
const everyone: Principal = { user: "bob", teams: ["dev"] };
const ids = (nodes: readonly Node[]) => nodes.map((n) => n.id);

describe("terms", () => {
  it("folds case and accents, and drops common words in English and French", () => {
    expect(textTerms("Comment l'Effacement est-il géré ?")).toEqual(textTerms("effacement gere"));
  });

  it("matches the forms of a word", () => {
    expect(textTerms("paginated")).toEqual(textTerms("pagination"));
    expect(textTerms("orders")).toEqual(textTerms("order"));
  });

  it("splits identifiers", () => {
    expect(textTerms("add_to_cart")).toEqual(expect.arrayContaining(textTerms("cart")));
  });

  it("gives the terms of a query once each", () => {
    expect(queryTerms("orders orders")).toEqual(textTerms("orders"));
  });
});

describe("ranking", () => {
  it("weighs a rare word above a common one", () => {
    const graph = createGraph([node("a", "orders orders orders"), node("b", "falcon"), node("c", "orders"), node("d", "orders")], []);
    expect(ids(retrieve(graph, everyone, "orders falcon"))[0]).toBe("b");
  });

  it("brings a node linked to a match, with none of the query's words", () => {
    const graph = createGraph([node("incident", "conversion dropped"), node("release", "renames an event"), node("other", "unrelated")], [{ type: "CAUSES", from: "release", to: "incident" }]);
    expect(ids(retrieve(graph, everyone, "conversion dropped"))).toEqual(["incident", "release"]);
  });

  it("keeps a node matching the words above one that is only linked", () => {
    const graph = createGraph([node("a", "conversion"), node("b", "conversion"), node("c", "linked")], [{ type: "REFERENCES", from: "a", to: "c" }]);
    expect(ids(retrieve(graph, everyone, "conversion")).slice(0, 2).sort()).toEqual(["a", "b"]);
  });

  it("leaves out a linked node refused by `linkable`, not one that matches", () => {
    const graph = createGraph([node("a", "conversion"), node("hr", "linked"), node("pay", "conversion")], [{ type: "REFERENCES", from: "a", to: "hr" }]);
    const linkable = (n: Node) => n.id !== "hr" && n.id !== "pay";
    expect(ids(retrieve(graph, everyone, "conversion", { linkable })).sort()).toEqual(["a", "pay"]);
  });

  it("does not reach a node through an unreadable one", () => {
    const hidden: Scope = { kind: "team", team: "m-and-a" };
    const graph = createGraph([node("a", "conversion"), node("secret", "nothing", hidden), node("behind", "other")], [
      { type: "REFERENCES", from: "a", to: "secret" },
      { type: "REFERENCES", from: "secret", to: "behind" },
    ]);
    expect(ids(retrieve(graph, everyone, "conversion"))).toEqual(["a"]);
  });

  it("finds nothing when no word matches, whatever the links", () => {
    const graph = createGraph([node("a", "conversion"), node("b", "other")], [{ type: "REFERENCES", from: "a", to: "b" }]);
    expect(retrieve(graph, everyone, "falcon")).toEqual([]);
  });
});

describe("a search", () => {
  it("shows what holds the words, without what is only linked to it", async () => {
    const store = memoryStore();
    await store.upsertNodes([node("a", "conversion"), node("b", "other")]);
    await store.upsertEdges([{ type: "REFERENCES", from: "a", to: "b" }]);
    expect(ids(await createReader(store, memoryAudit()).search(everyone, "conversion"))).toEqual(["a"]);
  });
});

describe("the context budget", () => {
  const words = (count: number, word = "filler") => Array.from({ length: count }, () => word).join(" ");
  const size = (nodes: readonly Node[]) => nodes.reduce((sum, n) => sum + (n.body?.length ?? 0), 0) / 4;

  it("leaves a context that fits untouched", () => {
    const nodes = [node("a", "short"), node("b", "short too")];
    expect(fitContext(nodes, "short", 1000)).toEqual(nodes);
  });

  it("never exceeds the budget, whatever the documents", () => {
    const nodes = [node("a", words(4000)), node("b", words(4000)), node("c", words(4000))];
    expect(size(fitContext(nodes, "filler", 500))).toBeLessThanOrEqual(500);
  });

  it("drops the worst ranked nodes first", () => {
    const nodes = [node("a", words(400)), node("b", words(400)), node("c", words(400))];
    expect(ids(fitContext(nodes, "filler", 500))).toEqual(["a", "b"]);
  });

  it("does not let one document take the whole budget", () => {
    const nodes = [node("huge", words(40000)), node("small", "the small one")];
    expect(ids(fitContext(nodes, "filler", 500))).toEqual(["huge", "small"]);
  });

  it("keeps the passage of a long document that holds the query's words", () => {
    const body = `${words(800)}.\n\nThe refund endpoint is POST /orders/{id}/refund.\n\n${words(800)}.`;
    const [fitted] = fitContext([node("a", body)], "refund endpoint", 100);
    expect(fitted?.body).toContain("POST /orders/{id}/refund");
    expect(fitted?.body).toContain("[…]");
  });
});

describe("ask over links", () => {
  async function setup() {
    const store = memoryStore();
    const audit = memoryAudit();
    const writer = createWriter(store, memoryEvents());
    await writer.upsertNodes([node("a", "conversion"), node("b", "other", { kind: "team", team: "front" })]);
    await writer.upsertEdges([{ type: "REFERENCES", from: "a", to: "b" }]);
    return createAsker(store, writer, audit, { complete: async () => "ok" }, { writers: ["writers"] });
  }
  const lea: Principal = { user: "lea", teams: ["front", "writers"] };

  it("reads what is linked to a match", async () => {
    expect(ids((await (await setup()).ask(lea, "conversion")).sources)).toEqual(["a", "b"]);
  });

  it("does not let a linked node narrow an answer being filed", async () => {
    const { saved, sources } = await (await setup()).ask(lea, "conversion", { save: { scope: shared } });
    expect(ids(sources)).toEqual(["a"]);
    expect(saved?.scope).toEqual(shared);
  });
});

describe("ask within a budget", () => {
  function echo(): LLMProvider & { readonly prompts: string[] } {
    const prompts: string[] = [];
    return { prompts, complete: async ({ prompt }) => (prompts.push(prompt), "ok") };
  }
  const long = Array.from({ length: 400 }, () => "orders").join(" ");

  async function setup() {
    const store = memoryStore();
    const audit = memoryAudit();
    const writer = createWriter(store, memoryEvents());
    await writer.upsertNodes([node("a", long, shared), node("b", long, shared), node("c", long, { kind: "team", team: "front" })]);
    const llm = echo();
    return { store, audit, llm, asker: createAsker(store, writer, audit, llm, { writers: ["writers"], budget: 500 }) };
  }
  const lea: Principal = { user: "lea", teams: ["front", "writers"] };

  it("records only the nodes the model read", async () => {
    const { asker, audit, llm } = await setup();
    const { sources } = await asker.ask(lea, "orders");
    expect(ids(sources)).toEqual(["a", "b"]);
    expect(audit.written).toMatchObject([{ action: "ask", returned: ["a", "b"] }]);
    expect(llm.prompts[0]).not.toContain('id="c"');
  });

  it("narrows a filed answer only by what the model read", async () => {
    const { asker } = await setup();
    const { saved } = await asker.ask(lea, "orders", { save: { scope: shared } });
    expect(saved?.scope).toEqual(shared);
  });

  it("gives back the sources whole, not their excerpts", async () => {
    const { asker } = await setup();
    const { sources } = await asker.ask(lea, "orders");
    expect(sources[0]?.body).toBe(long);
  });
});

describe("a text index", () => {
  it("the scan of a store conforms", async () => {
    const make = () => {
      const store = memoryStore();
      return { store, index: scanIndex(store) };
    };
    expect(await checkTextIndex(make)).toEqual([]);
  });

  it("a ranked, cut index does not conform", async () => {
    const make = () => {
      const store = memoryStore();
      const scan = scanIndex(store);
      return { store, index: { matching: async (terms: readonly string[]) => new Set([...(await scan.matching(terms))].slice(0, 10)) } };
    };
    expect((await checkTextIndex(make)).join()).toContain("every match");
  });
});
