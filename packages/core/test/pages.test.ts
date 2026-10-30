import { describe, expect, it } from "vitest";
import { Conflict, createOntology, createPages, createWriter, Forbidden, Invalid, pageVersion, Stale, wikilinks, type Node, type Principal, type Scope } from "../src/index.js";
import { memoryAudit, memoryEvents, memoryStore } from "./memory.js";

const lea: Principal = { user: "lea", teams: ["writers", "bff", "front"] };
const bob: Principal = { user: "bob", teams: ["writers", "bff"] };
const reader: Principal = { user: "ann", teams: ["bff"] };
const shared: Scope = { kind: "shared" };
const front: Scope = { kind: "team", team: "front" };
const node = (id: string, scope: Scope, source = "docs"): Node => ({ id, type: "Concept", scope, provenance: { source, path: id } });

async function setup() {
  const store = memoryStore();
  const audit = memoryAudit();
  const writer = createWriter(store, memoryEvents());
  await writer.upsertNodes([node("adr", shared), node("front-plan", front)]);
  const pages = createPages(store, writer, audit, { writers: ["writers"] });
  const edges = async () => (await store.snapshot()).edges.map((e) => `${e.from}>${e.to}`).sort();
  return { store, audit, writer, pages, edges };
}

describe("wiki pages", () => {
  it("creates a page with references to the readable nodes it links", async () => {
    const { pages, edges, audit } = await setup();
    const saved = await pages.save(lea, "onboarding", { title: "Onboarding", body: "Read [[adr]], [[front-plan|the plan]] and [[nowhere]].", scope: shared }, null);
    expect(saved).toMatchObject({ created: true, node: { id: "onboarding", title: "Onboarding", provenance: { source: "wiki" } } });
    expect(saved.version).toBe(pageVersion(saved.node));
    expect(await edges()).toEqual(["onboarding>adr", "onboarding>front-plan"]);
    expect(audit.written.at(-1)).toMatchObject({ action: "edit", target: "onboarding", created: true, returned: ["onboarding"] });
  });

  it("keeps a link its editor cannot read, and links nothing they cannot read", async () => {
    const { pages, edges } = await setup();
    const first = await pages.save(lea, "p", { title: "P", body: "[[front-plan]]", scope: shared }, null);
    const second = await pages.save(bob, "p", { title: "P", body: "[[front-plan]] and [[adr]]", scope: shared }, first.version);
    expect(await edges()).toEqual(["p>adr", "p>front-plan"]);
    await pages.save(bob, "p", { title: "P", body: "only [[adr]]", scope: shared }, second.version);
    expect(await edges()).toEqual(["p>adr"]);
    const third = await pages.save(bob, "q", { title: "Q", body: "[[front-plan]]", scope: shared }, null);
    expect(third.created).toBe(true);
    expect(await edges()).toEqual(["p>adr"]);
  });

  it("refuses a save over a version other than the current one", async () => {
    const { pages } = await setup();
    const first = await pages.save(lea, "p", { title: "P", body: "one", scope: shared }, null);
    await pages.save(lea, "p", { title: "P", body: "two", scope: shared }, first.version);
    await expect(pages.save(bob, "p", { title: "P", body: "three", scope: shared }, first.version)).rejects.toThrow(Stale);
    await expect(pages.save(bob, "p", { title: "P", body: "again", scope: shared }, null)).rejects.toThrow(Stale);
    await expect(pages.save(bob, "new", { title: "N", body: "", scope: shared }, first.version)).rejects.toThrow(Stale);
  });

  it("never edits an ingested node, nor one its editor may not read, and says the same for both", async () => {
    const { pages, audit } = await setup();
    const ingested = pages.save(lea, "adr", { title: "ADR", body: "", scope: shared }, null);
    await expect(ingested).rejects.toThrow(Conflict);
    const hidden = pages.save(bob, "front-plan", { title: "x", body: "", scope: shared }, null);
    await expect(hidden).rejects.toThrow(Conflict);
    await expect(ingested).rejects.toThrow("is taken by a node that is not an editable page");
    await expect(hidden).rejects.toThrow("is taken by a node that is not an editable page");
    expect(audit.written.at(-1)).toMatchObject({ action: "edit", target: "front-plan", denied: true, returned: [] });
  });

  it("lets only writers save, and only into a scope they read", async () => {
    const { pages } = await setup();
    await expect(pages.save(reader, "p", { title: "P", body: "", scope: shared }, null)).rejects.toThrow(Forbidden);
    await expect(pages.save(bob, "p", { title: "P", body: "", scope: front }, null)).rejects.toThrow(Invalid);
    await expect(pages.save(bob, "p", { title: "P", body: "", scope: { kind: "private", user: "lea" } }, null)).rejects.toThrow(Invalid);
  });

  it("keeps the scope of a page others are derived from", async () => {
    const { pages, writer } = await setup();
    const page = await pages.save(lea, "p", { title: "P", body: "", scope: shared }, null);
    await writer.upsertNodes([node("summary", shared, "ask")]);
    await writer.upsertEdges([{ type: "DERIVED_FROM", from: "summary", to: "p" }]);
    await expect(pages.save(lea, "p", { title: "P", body: "", scope: front }, page.version)).rejects.toThrow(Conflict);
    await expect(pages.save(lea, "p", { title: "P2", body: "edited", scope: shared }, page.version)).resolves.toMatchObject({ created: false });
  });

  it("saves a page of a type the organisation added, and of no type outside the ontology", async () => {
    const { pages } = await setup();
    await expect(pages.save(bob, "p", { title: "P", body: "", scope: shared, type: "Microservice" }, null)).rejects.toThrow(Invalid);
    const store = memoryStore();
    const extended = createPages(store, createWriter(store, memoryEvents(), { ontology: createOntology({ nodeTypes: ["Microservice"] }) }), memoryAudit(), {
      writers: ["writers"],
    });
    const saved = await extended.save(bob, "p", { title: "P", body: "", scope: shared, type: "Microservice" }, null);
    expect(saved.node.type).toBe("Microservice");
  });

  it("reads links as the documents adapter does", () => {
    expect(wikilinks("[[a]] [[b|B]] [[c#part]] [[a]] [[ ]]")).toEqual(["a", "b", "c"]);
  });
});
