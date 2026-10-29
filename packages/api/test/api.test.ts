import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReader, createWriter, type Node, type Scope } from "@graph-warden/core";
import { createDemoIdentity } from "@graph-warden/identity";
import { createMemoryAuditLog, createMemoryEventLog, createMemoryStore } from "@graph-warden/memory";
import { buildApi, loadConfig } from "../src/index.js";

const node = (id: string, scope: Scope): Node => ({ id, type: "Concept", scope, provenance: { source: "docs", path: id } });

const tokens = { lea: "lea-token-0123456789", bob: "bob-token-0123456789", dpo: "dpo-token-0123456789" };

async function setup() {
  const store = createMemoryStore();
  const events = createMemoryEventLog();
  const audit = createMemoryAuditLog();
  const writer = createWriter(store, events);
  // app -> contract (bff) ; summary (bff + front) derived from both
  await writer.upsertNodes([
    node("app", { kind: "shared" }),
    node("contract", { kind: "team", team: "bff" }),
    node("summary", { kind: "teams", teams: ["bff", "front"] }),
  ]);
  await writer.upsertEdges([
    { type: "IMPORTS", from: "app", to: "contract" },
    { type: "DERIVED_FROM", from: "summary", to: "contract" },
  ]);
  const identity = createDemoIdentity([
    { token: tokens.lea, user: "lea", teams: ["dev", "bff", "front"] },
    { token: tokens.bob, user: "bob", teams: ["dev", "bff"] },
    { token: tokens.dpo, user: "dpo", teams: ["auditors"] },
  ]);
  const app = buildApi({ reader: createReader(store, audit, { events, auditors: ["auditors"] }), identity });
  const get = (url: string, token?: string) =>
    app.inject({ method: "GET", url, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  return { app, get, writer, audit };
}

describe("API", () => {
  it("refuses a missing or unknown token, saying only that it is unauthenticated", async () => {
    const { get } = await setup();
    for (const response of [await get("/v1/me"), await get("/v1/me", "nope"), await get("/v1/pull", "nope")]) {
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
      expect(response.json()).toEqual({ error: "unauthenticated" });
    }
  });

  it("serves health and the OpenAPI document without a token", async () => {
    const { get } = await setup();
    expect((await get("/healthz")).json()).toEqual({ ok: true });
    const spec = (await get("/openapi.json")).json();
    expect(Object.keys(spec.paths)).toEqual(["/healthz", "/v1/me", "/v1/nodes/{id}/neighbours", "/v1/pull", "/v1/audit"]);
  });

  it("gives each caller only what their groups allow", async () => {
    const { get } = await setup();
    const ids = async (token: string) =>
      ((await get("/v1/nodes/contract/neighbours?direction=both", token)).json().nodes as Node[]).map((n) => n.id);
    expect(await ids(tokens.lea)).toEqual(["app", "summary"]);
    expect(await ids(tokens.bob)).toEqual(["app"]);
    expect(await ids(tokens.dpo)).toEqual([]);
  });

  it("filters by edge type and depth", async () => {
    const { get } = await setup();
    const response = await get("/v1/nodes/contract/neighbours?direction=both&edge=DERIVED_FROM&edge=CONSUMES&depth=1", tokens.lea);
    expect((response.json().nodes as Node[]).map((n) => n.id)).toEqual(["summary"]);
  });

  it("rejects invalid parameters", async () => {
    const { get } = await setup();
    expect((await get("/v1/nodes/app/neighbours?direction=up", tokens.lea)).statusCode).toBe(400);
    expect((await get("/v1/nodes/app/neighbours?edge=LIKES", tokens.lea)).statusCode).toBe(400);
    expect((await get("/v1/pull?after=-1", tokens.lea)).statusCode).toBe(400);
  });

  it("pulls what changed since a cursor, with the principal it was computed for", async () => {
    const { get, writer } = await setup();
    const first = (await get("/v1/pull", tokens.bob)).json();
    expect(first.principal).toEqual({ user: "bob", teams: ["dev", "bff"] });
    expect((first.delta.nodes as Node[]).map((n) => n.id).sort()).toEqual(["app", "contract"]);

    await writer.upsertNodes([node("contract", { kind: "team", team: "front" })]);
    const next = (await get(`/v1/pull?after=${first.delta.cursor}`, tokens.bob)).json();
    expect(next.delta).toMatchObject({ nodes: [], edges: [], removed: ["contract"] });
  });

  it("opens the audit log to auditors only, and records every read", async () => {
    const { get } = await setup();
    await get("/v1/nodes/app/neighbours", tokens.bob);
    expect((await get("/v1/audit", tokens.lea)).statusCode).toBe(403);

    const response = await get("/v1/audit?user=bob", tokens.dpo);
    expect(response.statusCode).toBe(200);
    expect(response.json().entries).toMatchObject([{ action: "traverse", principal: { user: "bob" }, start: "app", returned: ["contract"] }]);
    const all = (await get("/v1/audit", tokens.dpo)).json().entries as object[];
    expect(all).toMatchObject([
      { action: "traverse" },
      { action: "audit", principal: { user: "lea" }, denied: true },
      { action: "audit", principal: { user: "dpo" }, user: "bob" },
    ]);
    expect(all[2]).not.toHaveProperty("denied");
  });
});

describe("loadConfig", () => {
  const base = { NEO4J_PASSWORD: "secret" };

  it("refuses to start without an identity provider", async () => {
    await expect(loadConfig(base)).rejects.toThrow();
  });

  it("refuses demo tokens unless they are asked for twice", async () => {
    const users = join(tmpdir(), `gw-users-${process.pid}.yaml`);
    await writeFile(users, `- { token: ${tokens.lea}, user: lea, teams: [bff] }\n`);
    await expect(loadConfig({ ...base, GWARDEN_IDENTITY: "demo", GWARDEN_DEMO_USERS: users })).rejects.toThrow(/i-understand/);
    const config = await loadConfig({
      ...base,
      GWARDEN_IDENTITY: "demo",
      GWARDEN_DEMO_USERS: users,
      GWARDEN_DEMO: "i-understand-anyone-with-a-token-is-that-user",
      GWARDEN_AUDITORS: "auditors, dpo",
    });
    expect(config.GWARDEN_AUDITORS).toEqual(["auditors", "dpo"]);
    expect(await config.identity.principalFor(tokens.lea)).toEqual({ user: "lea", teams: ["bff"] });
  });

  it("needs an issuer and an audience for OIDC", async () => {
    await expect(loadConfig({ ...base, GWARDEN_IDENTITY: "oidc", OIDC_ISSUER: "https://login.example.com" })).rejects.toThrow();
  });
});
