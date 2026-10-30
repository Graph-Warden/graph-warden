import { describe, expect, it } from "vitest";
import { createReader, createWriter, NotFound, type Node, type Principal, type Scope } from "../src/index.js";
import { memoryAudit, memoryEvents, memoryStore } from "./memory.js";

const node = (id: string, scope: Scope, title?: string, body?: string): Node => ({
  id,
  type: "Concept",
  scope,
  provenance: { source: "docs", path: id },
  ...(title === undefined ? {} : { title }),
  ...(body === undefined ? {} : { body }),
});
const bob: Principal = { user: "bob", teams: ["bff"] };

async function setup() {
  const store = memoryStore();
  const audit = memoryAudit();
  await createWriter(store, memoryEvents()).upsertNodes([
    node("adr-7", { kind: "team", team: "bff" }, "Cursor pagination", "Orders move to cursors."),
    node("glossary", { kind: "shared" }, undefined, "Pagination: splitting a list into pages."),
    node("falcon", { kind: "team", team: "m-and-a" }, "Pagination of the deal room", "Secret."),
  ]);
  return { audit, reader: createReader(store, audit) };
}

describe("reader", () => {
  it("reads one node, and records the read", async () => {
    const { reader, audit } = await setup();
    expect((await reader.node(bob, "adr-7")).title).toBe("Cursor pagination");
    expect(audit.written).toMatchObject([{ action: "read", target: "adr-7", returned: ["adr-7"] }]);
  });

  it("treats an unreadable node like an unknown one, and records both alike", async () => {
    const { reader, audit } = await setup();
    await expect(reader.node(bob, "falcon")).rejects.toThrow(NotFound);
    await expect(reader.node(bob, "nothing")).rejects.toThrow(NotFound);
    expect(audit.written.map((e) => e.returned)).toEqual([[], []]);
  });

  it("searches readable nodes only, a title match first", async () => {
    const { reader, audit } = await setup();
    expect((await reader.search(bob, "pagination")).map((n) => n.id)).toEqual(["adr-7", "glossary"]);
    expect(audit.written).toMatchObject([{ action: "search", query: "pagination", returned: ["adr-7", "glossary"] }]);
  });
});
