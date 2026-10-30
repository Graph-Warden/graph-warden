import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createReader, createWriter, type Node, type Scope } from "@graph-warden/core";
import { createDemoIdentity } from "@graph-warden/identity";
import { createMemoryAuditLog, createMemoryEventLog, createMemoryStore } from "@graph-warden/memory";
import { buildApi } from "../src/index.js";

// Issue #12, with the SDK's own client over HTTP, as Claude Code or any MCP client would connect:
// every tool answers as the token's user, and nothing reaches another team's nodes.

const node = (id: string, scope: Scope, body?: string): Node => ({
  id,
  type: "Concept",
  scope,
  provenance: { source: "docs", path: id },
  ...(body === undefined ? {} : { body }),
});
const tokens = { lea: "lea-token-0123456789", bob: "bob-token-0123456789" };
let close: () => Promise<void> = async () => {};
afterEach(() => close());

async function connect(token: string) {
  const store = createMemoryStore();
  const events = createMemoryEventLog();
  const writer = createWriter(store, events);
  const audit = createMemoryAuditLog();
  await writer.upsertNodes([
    node("app", { kind: "shared" }, "The shop's front door."),
    node("contract", { kind: "team", team: "bff" }, "The orders contract."),
    node("summary", { kind: "teams", teams: ["bff", "front"] }, "Front relies on the orders contract."),
    node("front-secret", { kind: "team", team: "front" }, "The secret checkout redesign."),
  ]);
  await writer.upsertEdges([
    { type: "IMPORTS", from: "app", to: "contract" },
    { type: "DERIVED_FROM", from: "summary", to: "contract" },
    { type: "IMPORTS", from: "front-secret", to: "contract" },
    { type: "IMPORTS", from: "app", to: "front-secret" },
  ]);
  const identity = createDemoIdentity([
    { token: tokens.lea, user: "lea", teams: ["bff", "front"] },
    { token: tokens.bob, user: "bob", teams: ["bff"] },
  ]);
  const app = buildApi({ reader: createReader(store, audit, { events }), identity });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  close = async () => {
    await client.close();
    await app.close();
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: result.isError === true, value: JSON.parse(result.content[0]?.text ?? "null") as unknown };
  };
  return { client, call, audit, url };
}

describe("MCP server", () => {
  it("offers the five tools", async () => {
    const { client } = await connect(tokens.bob);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["get_node", "impact", "neighbourhood", "recent_changes", "search"]);
  });

  it("answers as the token's user, and says nothing of another team's nodes", async () => {
    const { call, audit } = await connect(tokens.bob);
    expect(await call("search", { query: "secret checkout" })).toEqual({ isError: false, value: [] });
    const hidden = await call("get_node", { id: "front-secret" });
    const unknown = await call("get_node", { id: "no-such-node" });
    expect(hidden.isError).toBe(true);
    expect(JSON.stringify(hidden.value)).toBe(JSON.stringify(unknown.value).replace("no-such-node", "front-secret"));
    expect((await call("get_node", { id: "contract" })).value).toMatchObject({ id: "contract", body: "The orders contract." });

    const ids = (value: unknown) => (value as { id: string }[]).map((n) => n.id).sort();
    expect(ids((await call("neighbourhood", { id: "app", depth: 3 })).value)).toEqual(["contract"]);
    const impact = (await call("impact", { ids: ["contract"] })).value as { related: { id: string }[]; teams: string[] };
    expect(impact.related.map((n) => n.id)).toEqual(["app"]);
    expect(impact.teams).toEqual([]);
    const recent = (await call("recent_changes", { all: true })).value as { nodes: { id: string }[] };
    expect(recent.nodes.map((n) => n.id).sort()).toEqual(["app", "contract"]);

    // Every call is in bob's audit trail.
    expect(audit.written.map((entry) => `${entry.principal.user} ${entry.action}`)).toEqual(
      ["search", "read", "read", "read", "traverse", "related", "pull"].map((action) => `bob ${action}`),
    );
  });

  it("gives a reader of every team the whole impact", async () => {
    const { call } = await connect(tokens.lea);
    const impact = (await call("impact", { ids: ["contract"] })).value as { related: { id: string; depth: number }[]; teams: string[] };
    expect(impact.related.map((n) => `${n.id} ${n.depth}`)).toEqual(["app 1", "front-secret 1", "summary 1"]);
    expect(impact.teams).toEqual(["bff", "front"]);
  });

  it("refuses a request without a valid token", async () => {
    const { url } = await connect(tokens.bob);
    const response = await fetch(new URL("/mcp", url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});
