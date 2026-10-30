import { describe, expect, it } from "vitest";
import { checkSource, createConnectorSync, createWriter, formatScope, type Node } from "@graph-warden/core";
import { createMemoryEventLog, createMemoryStore } from "@graph-warden/memory";
import { createConfluenceConnector, pageId, storageText } from "../src/index.js";

// Issue #20: Confluence passes the source conformance suite, and its permissions are resynced
// apart from content.

interface Permissions {
  // Space key to the principals that read it.
  spaces: Record<string, { type: string; id?: string }[]>;
  // Page id to the groups and users its read restriction names.
  pages: Record<string, { groups?: string[]; users?: string[] }>;
}

// A Confluence API answering from files `spaces/<KEY>/pages/<id>` (JSON pages), one page of
// results at a time, with permissions apart, counting the requests that read page bodies.
function fakeConfluence(files: ReadonlyMap<string, string>, permissions: Permissions) {
  const counts = { bodies: 0 };
  const groups: Record<string, string> = { g1: "docs-team", g2: "sre" };
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/wiki/, "");
    const json = (body: unknown) => Response.json(body);
    if (path === "/api/v2/spaces") {
      const key = url.searchParams.get("keys") ?? "";
      return json({ results: permissions.spaces[key] === undefined ? [] : [{ id: `id-${key}`, key }] });
    }
    const perms = /^\/api\/v2\/spaces\/id-([^/]+)\/permissions$/.exec(path);
    if (perms !== null) return json({ results: (permissions.spaces[perms[1] ?? ""] ?? []).map((principal) => ({ principal, operation: { key: "read", targetType: "space" } })) });
    const pages = /^\/api\/v2\/spaces\/id-([^/]+)\/pages$/.exec(path);
    if (pages !== null) {
      const withBodies = url.searchParams.get("body-format") === "storage";
      if (withBodies) counts.bodies++;
      const all = [...files].filter(([key]) => key.startsWith(`spaces/${pages[1]}/pages/`)).map(([, text]) => JSON.parse(text));
      const at = Number(url.searchParams.get("cursor") ?? 0);
      const next = at + 1 < all.length ? `${url.origin}/wiki${path}?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), cursor: String(at + 1) })}` : undefined;
      const results = all.slice(at, at + 1).map((page) => (withBodies ? page : { ...page, body: undefined }));
      return json({ results, _links: next === undefined ? {} : { next } });
    }
    const group = /^\/rest\/api\/group\/by-id$/.exec(path);
    if (group !== null) return json({ name: groups[url.searchParams.get("id") ?? ""] ?? "unknown" });
    const restriction = /^\/rest\/api\/content\/([^/]+)\/restriction\/byOperation\/read$/.exec(path);
    if (restriction !== null) {
      const r = permissions.pages[restriction[1] ?? ""] ?? {};
      return json({ restrictions: { group: { results: (r.groups ?? []).map((name) => ({ name })) }, user: { results: (r.users ?? []).map((accountId) => ({ accountId })) } } });
    }
    return new Response("", { status: 404 });
  };
  return { fetch: fetch as typeof globalThis.fetch, counts };
}

const page = (id: string, title: string, xhtml: string, parentId?: string) => JSON.stringify({ id, title, ...(parentId === undefined ? {} : { parentId }), body: { storage: { value: xhtml } } });
const files = new Map([
  ["spaces/ENG/pages/1", page("1", "Architecture", '<h1>Architecture</h1><p>See <ac:link><ri:page ri:content-title="Pagination" /></ac:link>.</p>')],
  ["spaces/ENG/pages/2", page("2", "Pagination", "<p>Cursors &amp; limits.</p>", "1")],
  ["spaces/ENG/pages/3", page("3", "On-call", "<p>Rota.</p>", "1")],
  ["spaces/ENG/pages/4", page("4", "Salaries", "<p>Private.</p>")],
  ["spaces/ENG/pages/5", page("5", "Under salaries", "<p>Also private.</p>", "4")],
  ["spaces/PUB/pages/9", page("9", "Welcome", "<p>Hello.</p>")],
]);
const permissions = (): Permissions => ({
  spaces: { ENG: [{ type: "group", id: "g1" }], PUB: [{ type: "anonymous" }] },
  pages: { "3": { groups: ["sre"] }, "4": { users: ["5b10ac8d82e05b22cc7d4ef5"] } },
});
const connector = (given: ReadonlyMap<string, string>, fake = fakeConfluence(given, permissions())) =>
  createConfluenceConnector({ baseUrl: "https://acme.atlassian.net", email: "ci@acme.example", token: "t", spaces: ["ENG", "PUB"], fetch: fake.fetch });

describe("Confluence connector", () => {
  it("passes the source conformance suite", async () => {
    expect(
      await checkSource({
        source: "confluence:acme.atlassian.net",
        // Pages restricted to users are not read: the suite checks the others.
        files: new Map([...files].filter(([key]) => !/\/pages\/[45]$/.test(key))),
        extract: (given) => connector(given).read(),
        undeclared: [pageId("1"), pageId("2")],
        defaultScope: { kind: "team", team: "docs-team" },
      }),
    ).toEqual([]);
  });

  it("scopes pages by space and restriction, and leaves out pages restricted to users", async () => {
    const { nodes, edges } = await connector(files).read();
    expect(Object.fromEntries(nodes.map((node) => [node.id, formatScope(node.scope)]))).toEqual({
      "confluence:1": "team:docs-team",
      "confluence:2": "team:docs-team",
      "confluence:3": "teams:docs-team,sre",
      "confluence:9": "shared",
    });
    expect(nodes.find((node) => node.id === "confluence:2")?.body).toBe("Cursors & limits.");
    expect(edges.map((edge) => `${edge.from} ${edge.type} ${edge.to}`).sort()).toEqual([
      "confluence:1 REFERENCES confluence:2",
      "confluence:2 BELONGS_TO confluence:1",
      "confluence:3 BELONGS_TO confluence:1",
    ]);
  });

  it("resyncs permissions without reading content, narrowing what is derived from the pages", async () => {
    const store = createMemoryStore();
    const writer = createWriter(store, createMemoryEventLog());
    const sync = createConnectorSync(store, writer);
    await sync.sync(connector(files));
    const answer: Node = { id: "answer", type: "Concept", scope: { kind: "team", team: "docs-team" }, provenance: { source: "ask:lea", path: "answer" } };
    await writer.upsertNodes([answer]);
    await writer.upsertEdges([{ type: "DERIVED_FROM", from: "answer", to: pageId("2") }]);
    const bodyBefore = (await store.getNode(pageId("2")))?.body;

    // The space is now granted to the sre group too (both are required), and page 2 restricted.
    const changed = permissions();
    changed.spaces.ENG = [{ type: "group", id: "g1" }, { type: "group", id: "g2" }];
    changed.pages["2"] = { groups: ["leads"] };
    const fake = fakeConfluence(files, changed);
    const report = await sync.rescope(connector(files, fake));
    expect(fake.counts.bodies).toBe(0);
    // Page 3 already required sre: it does not change.
    expect(report.rescoped.sort()).toEqual([pageId("1"), pageId("2")]);
    expect(formatScope((await store.getNode(pageId("2")))?.scope ?? { kind: "shared" })).toBe("teams:docs-team,leads,sre");
    expect((await store.getNode(pageId("2")))?.body).toBe(bodyBefore);
    expect(report.narrowed).toEqual(["answer"]);
    expect(formatScope((await store.getNode("answer"))?.scope ?? { kind: "shared" })).toBe("teams:docs-team,leads,sre");
  });

  it("refuses a space granted to users or roles, unless given its scope", async () => {
    const odd = permissions();
    odd.spaces.ENG = [{ type: "user", id: "u1" }];
    await expect(connector(files, fakeConfluence(files, odd)).read()).rejects.toThrow(/give the space a scope/);
  });
});

it("reads storage format as text and links", () => {
  expect(storageText('<p>A &lt;b&gt;</p><p><ac:link><ri:page ri:content-title="X &amp; Y"/></ac:link></p>')).toEqual({ text: "A <b>", links: ["X & Y"] });
});
