import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAsker, createEditor, createPages, createReader, createRouter, createSensitivityPolicy, createWriter, type LLMProvider, type Node, type Scope } from "@graph-warden/core";
import { createDemoIdentity } from "@graph-warden/identity";
import { createMemoryAuditLog, createMemoryEventLog, createMemoryStore } from "@graph-warden/memory";
import { buildApi, loadConfig } from "../src/index.js";

const node = (id: string, scope: Scope): Node => ({ id, type: "Concept", scope, provenance: { source: "docs", path: id } });

const tokens = { lea: "lea-token-0123456789", bob: "bob-token-0123456789", dpo: "dpo-token-0123456789" };

async function setup(stream?: { intervalMs: number; maxSeconds: number }) {
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
  const app = buildApi({ reader: createReader(store, audit, { events, auditors: ["auditors"] }), identity, ...(stream === undefined ? {} : { stream }) });
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
    expect(Object.keys(spec.paths)).toEqual([
      "/healthz",
      "/v1/me",
      "/v1/ontology",
      "/v1/nodes/{id}",
      "/v1/pages/{id}",
      "/v1/search",
      "/v1/nodes/{id}/neighbours",
      "/v1/pull",
      "/v1/stream",
      "/v1/audit",
      "/v1/nodes/{id}/deletion",
      "/v1/ask",
    ]);
  });

  it("gives each caller only what their groups allow", async () => {
    const { get } = await setup();
    const ids = async (token: string) =>
      ((await get("/v1/nodes/contract/neighbours?direction=both", token)).json().nodes as Node[]).map((n) => n.id);
    expect(await ids(tokens.lea)).toEqual(["app", "summary"]);
    expect(await ids(tokens.bob)).toEqual(["app"]);
    expect(await ids(tokens.dpo)).toEqual([]);
  });

  it("serves one readable node, and the same 404 for an unknown or unreadable one", async () => {
    const { get } = await setup();
    expect((await get("/v1/nodes/contract", tokens.bob)).json()).toMatchObject({ id: "contract" });
    const hidden = await get("/v1/nodes/summary", tokens.bob);
    const unknown = await get("/v1/nodes/nothing", tokens.bob);
    expect([hidden.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(hidden.body).toBe(unknown.body);
  });

  it("searches what the caller may read", async () => {
    const { get } = await setup();
    expect(((await get("/v1/search?q=summary", tokens.lea)).json().nodes as Node[]).map((n) => n.id)).toEqual(["summary"]);
    expect((await get("/v1/search?q=summary", tokens.bob)).json().nodes).toEqual([]);
    expect((await get("/v1/search", tokens.bob)).statusCode).toBe(400);
  });

  it("filters by edge type and depth", async () => {
    const { get } = await setup();
    const response = await get("/v1/nodes/contract/neighbours?direction=both&edge=DERIVED_FROM&edge=CONSUMES&depth=1", tokens.lea);
    expect((response.json().nodes as Node[]).map((n) => n.id)).toEqual(["summary"]);
  });

  it("rejects invalid parameters", async () => {
    const { get } = await setup();
    expect((await get("/v1/nodes/app/neighbours?direction=up", tokens.lea)).statusCode).toBe(400);
    expect((await get("/v1/nodes/app/neighbours?edge=likes", tokens.lea)).statusCode).toBe(400);
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

describe("API stream", () => {
  const events = (body: string) =>
    body
      .split("\n\n")
      .filter((block) => block.includes("event: "))
      .map((block) => Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)])));

  it("sends each change the caller may read as a delta event, and nothing else", async () => {
    const { app, writer, audit } = await setup({ intervalMs: 20, maxSeconds: 0.3 });
    const start = (await app.inject({ method: "GET", url: "/v1/pull", headers: { authorization: `Bearer ${tokens.bob}` } })).json().delta.cursor;
    const recorded = audit.written.length;
    setTimeout(() => {
      void writer
        .upsertNodes([node("hidden", { kind: "team", team: "front" })])
        .then(() => writer.upsertNodes([node("news", { kind: "shared" })]));
    }, 60);
    const response = await app.inject({ method: "GET", url: `/v1/stream?after=${start}`, headers: { authorization: `Bearer ${tokens.bob}` } });
    expect(response.headers["content-type"]).toBe("text/event-stream");
    const sent = events(response.body);
    expect(sent.map((e) => [e.event, JSON.parse(e.data).delta.nodes.map((n: Node) => n.id)])).toEqual([["delta", ["news"]]]);
    expect(Number(sent[0]?.id)).toBe(start + 2);
    // The delta with nothing for bob is not in his audit trail.
    expect(audit.written.slice(recorded).map((e) => e.returned)).toEqual([["news"]]);
  });

  it("resumes from Last-Event-ID and refuses a caller without a token", async () => {
    const { app, get, writer } = await setup({ intervalMs: 20, maxSeconds: 0.1 });
    const { cursor } = (await get("/v1/pull", tokens.bob)).json().delta;
    await writer.upsertNodes([node("news", { kind: "shared" })]);
    const response = await app.inject({ method: "GET", url: "/v1/stream", headers: { authorization: `Bearer ${tokens.bob}`, "last-event-id": String(cursor) } });
    expect(events(response.body).map((e) => JSON.parse(e.data).delta.nodes.map((n: Node) => n.id))).toEqual([["news"]]);
    expect((await get("/v1/stream")).statusCode).toBe(401);
  });
});

describe("API stream across a merge", () => {
  const blocks = (body: string) =>
    body
      .split("\n\n")
      .filter((block) => block.includes("event: delta"))
      .map((block) => ({
        id: Number(/^id: (\d+)$/m.exec(block)?.[1]),
        delta: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "{}").delta as { nodes: Node[]; removed: string[] },
      }));

  it("resumes a reconnect mid-merge without gap or duplicate, and never names a foreign node", async () => {
    const { app, get, writer } = await setup({ intervalMs: 15, maxSeconds: 0.12 });
    const { cursor: start } = (await get("/v1/pull", tokens.bob)).json().delta;
    // A merge written in batches, some of it for front only, including a deletion.
    const merge = (async () => {
      const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
      await writer.upsertNodes([node("m1", { kind: "shared" }), node("f1", { kind: "team", team: "front" })]);
      await pause();
      await writer.upsertNodes([node("m2", { kind: "team", team: "bff" }), node("f2", { kind: "team", team: "front" })]);
      await pause();
      await writer.deleteNode("f1");
      await writer.upsertNodes([node("m3", { kind: "shared" })]);
      await pause();
      await writer.deleteNode("m1");
      await pause();
      await writer.upsertNodes([node("m4", { kind: "shared" })]);
    })();

    const received: { id: number; delta: { nodes: Node[]; removed: string[] } }[] = [];
    let last = start;
    // Each connection lasts 120 ms: the client reconnects several times during the merge.
    for (let i = 0; i < 6; i++) {
      const response = await app.inject({ method: "GET", url: "/v1/stream", headers: { authorization: `Bearer ${tokens.bob}`, "last-event-id": String(last) } });
      for (const block of blocks(response.body)) {
        received.push(block);
        last = block.id;
      }
    }
    await merge;

    const ids = received.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // Applying the deltas in order gives what a pull from the start gives.
    const cache = new Map<string, Node>();
    for (const { delta } of received) {
      for (const n of delta.nodes) cache.set(n.id, n);
      for (const id of delta.removed) cache.delete(id);
    }
    const { delta: full } = (await get(`/v1/pull?after=${start}`, tokens.bob)).json();
    expect([...cache.keys()].sort()).toEqual(["m2", "m3", "m4"]);
    expect([...cache.keys()].sort()).toEqual(full.nodes.map((n: Node) => n.id).sort());
    const named = received.flatMap(({ delta }) => [...delta.nodes.map((n) => n.id), ...delta.removed]);
    expect(named.filter((id) => id.startsWith("f"))).toEqual([]);
    expect(Math.max(...ids)).toBe((await get("/v1/pull?after=0", tokens.lea)).json().delta.cursor);
  });
});

describe("API writes", () => {
  const writerTokens = { lea: "lea-writer-0123456789", bob: "bob-writer-0123456789", carl: "carl-reader-0123456789" };

  async function writes(options: { llm?: LLMProvider } = {}) {
    const store = createMemoryStore();
    const events = createMemoryEventLog();
    const audit = createMemoryAuditLog();
    const writer = createWriter(store, events);
    await writer.upsertNodes([
      { ...node("adr", { kind: "team", team: "bff" }), body: "Orders pagination moves to cursors." },
      node("checkout", { kind: "team", team: "front" }),
      node("summary", { kind: "team", team: "bff" }),
      node("impact", { kind: "teams", teams: ["bff", "front"] }),
    ]);
    await writer.upsertEdges([
      { type: "DERIVED_FROM", from: "summary", to: "adr" },
      { type: "DERIVED_FROM", from: "impact", to: "adr" },
      { type: "DERIVED_FROM", from: "impact", to: "checkout" },
    ]);
    const identity = createDemoIdentity([
      { token: writerTokens.lea, user: "lea", teams: ["bff", "front", "writers"] },
      { token: writerTokens.bob, user: "bob", teams: ["bff", "writers"] },
      { token: writerTokens.carl, user: "carl", teams: ["bff", "front"] },
    ]);
    const editor = createEditor(store, writer, audit, { writers: ["writers"] });
    const asker = options.llm === undefined ? undefined : createAsker(store, writer, audit, options.llm, { writers: ["writers"] });
    const pages = createPages(store, writer, audit, { writers: ["writers"] });
    const app = buildApi({ reader: createReader(store, audit, { events }), editor, pages, ...(asker === undefined ? {} : { asker }), identity });
    const call = (method: "GET" | "DELETE" | "POST" | "PUT", url: string, token: string, payload?: object, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, ...(payload === undefined ? {} : { payload }) });
    return { call, store };
  }

  it("creates and edits a wiki page over the version read, and never an ingested node", async () => {
    const { call } = await writes();
    const page = { title: "Runbook", body: "See [[adr]] and [[checkout]].", scope: "team:bff" };
    expect((await call("PUT", "/v1/pages/runbook", writerTokens.bob, page)).statusCode).toBe(428);
    const created = await call("PUT", "/v1/pages/runbook", writerTokens.bob, page, { "if-none-match": "*" });
    expect(created.statusCode).toBe(201);
    expect(created.json().node).toMatchObject({ id: "runbook", title: "Runbook", provenance: { source: "wiki" } });
    const read = await call("GET", "/v1/nodes/runbook", writerTokens.carl);
    expect(read.headers.etag).toBe(created.headers.etag);
    // bob could not read checkout: only adr is referenced.
    expect((await call("GET", "/v1/nodes/runbook/neighbours", writerTokens.carl)).json().nodes.map((n: Node) => n.id)).toEqual(["adr"]);

    const edit = { ...page, body: "Edited." };
    const edited = await call("PUT", "/v1/pages/runbook", writerTokens.lea, edit, { "if-match": String(read.headers.etag) });
    expect(edited.statusCode).toBe(200);
    expect((await call("PUT", "/v1/pages/runbook", writerTokens.bob, edit, { "if-match": String(read.headers.etag) })).statusCode).toBe(412);
    expect((await call("PUT", "/v1/pages/adr", writerTokens.lea, page, { "if-none-match": "*" })).statusCode).toBe(409);
    expect((await call("PUT", "/v1/pages/other", writerTokens.carl, page, { "if-none-match": "*" })).statusCode).toBe(403);
    expect((await call("PUT", "/v1/pages/other", writerTokens.bob, { ...page, scope: "team:front" }, { "if-none-match": "*" })).statusCode).toBe(400);
  });

  it("shows a deletion, then makes it only with the digest of what was shown", async () => {
    const { call, store } = await writes();
    const plan = (await call("GET", "/v1/nodes/adr/deletion", writerTokens.lea)).json();
    expect(plan.deleted.map((n: Node) => n.id)).toEqual(["adr", "summary"]);
    expect(plan.detached).toEqual([{ type: "DERIVED_FROM", from: "impact", to: "adr" }]);

    expect((await call("DELETE", "/v1/nodes/adr", writerTokens.lea)).statusCode).toBe(400);
    expect((await call("DELETE", "/v1/nodes/adr?confirm=stale", writerTokens.lea)).statusCode).toBe(409);
    const done = await call("DELETE", `/v1/nodes/adr?confirm=${plan.digest}`, writerTokens.lea);
    expect(done.statusCode).toBe(200);
    expect([...(await store.snapshot()).nodes.keys()].sort()).toEqual(["checkout", "impact"]);
  });

  it("refuses readers who are not writers, and writers whose deletion reaches what they may not read", async () => {
    const { call } = await writes();
    expect((await call("GET", "/v1/nodes/adr/deletion", writerTokens.carl)).statusCode).toBe(403);
    const reach = await call("GET", "/v1/nodes/adr/deletion", writerTokens.bob);
    expect(reach.statusCode).toBe(403);
    expect(reach.body).not.toMatch(/impact/);
    expect((await call("GET", "/v1/nodes/checkout/deletion", writerTokens.bob)).statusCode).toBe(404);
  });

  it("answers a question from what the caller may read, and files it on request", async () => {
    const llm: LLMProvider = { complete: async ({ prompt }) => (prompt.includes('id="adr"') ? "Cursors, see [[adr]]." : "No idea.") };
    const { call } = await writes({ llm });
    const answer = (await call("POST", "/v1/ask", writerTokens.carl, { question: "How is pagination done?" })).json();
    expect(answer).toMatchObject({ answer: "Cursors, see [[adr]].", sources: [{ id: "adr" }] });
    expect(answer).not.toHaveProperty("saved");

    expect((await call("POST", "/v1/ask", writerTokens.carl, { question: "pagination", save: true })).statusCode).toBe(403);
    const filed = (await call("POST", "/v1/ask", writerTokens.lea, { question: "pagination", save: true, scope: "shared" })).json();
    expect(filed.saved.scope).toEqual({ kind: "team", team: "bff" });
    expect((await call("POST", "/v1/ask", writerTokens.lea, { question: "x", scope: "nope:" })).statusCode).toBe(400);
  });

  it("answers 501 when no model is configured", async () => {
    const { call } = await writes();
    expect((await call("POST", "/v1/ask", writerTokens.lea, { question: "pagination" })).statusCode).toBe(501);
  });

  it("answers 501 when the question reads confidential sources and no local model is configured", async () => {
    const remote: LLMProvider = { complete: async () => "sent out" };
    const llm = createRouter({ remote, policy: createSensitivityPolicy({ confidential: ["docs"] }), audit: createMemoryAuditLog() });
    const { call } = await writes({ llm });
    const response = await call("POST", "/v1/ask", writerTokens.lea, { question: "pagination" });
    expect(response.statusCode).toBe(501);
    expect(response.body).not.toMatch(/sent out/);
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

  it("needs the settings of the Google platform the model runs on", async () => {
    const users = join(tmpdir(), `gw-users-llm-${process.pid}.yaml`);
    await writeFile(users, `- { token: ${tokens.lea}, user: lea, teams: [bff] }\n`);
    const demo = { ...base, GWARDEN_IDENTITY: "demo", GWARDEN_DEMO_USERS: users, GWARDEN_DEMO: "i-understand-anyone-with-a-token-is-that-user", GWARDEN_LLM: "claude" };
    await expect(loadConfig({ ...demo, GWARDEN_LLM_PLATFORM: "google-cloud" })).rejects.toThrow(/WORKSPACE_ID/);
    await expect(loadConfig({ ...demo, GWARDEN_LLM_PLATFORM: "vertex", CLOUD_ML_REGION: "" })).rejects.toThrow(/CLOUD_ML_REGION/);
    await expect(loadConfig({ ...demo, GWARDEN_LLM_PLATFORM: "copilot" })).rejects.toThrow();
    const config = await loadConfig({ ...demo, GWARDEN_LLM_PLATFORM: "vertex", CLOUD_ML_REGION: "global" });
    expect(config.GWARDEN_LLM_PLATFORM).toBe("vertex");
  });

  it("reads the organisation's ontology from GWARDEN_ONTOLOGY, and serves it", async () => {
    const users = join(tmpdir(), `gw-users-ontology-${process.pid}.yaml`);
    await writeFile(users, `- { token: ${tokens.lea}, user: lea, teams: [bff] }\n`);
    const demo = { ...base, GWARDEN_IDENTITY: "demo", GWARDEN_DEMO_USERS: users, GWARDEN_DEMO: "i-understand-anyone-with-a-token-is-that-user" };
    expect((await loadConfig(demo)).ontology.nodeTypes).not.toContain("Microservice");
    const file = join(tmpdir(), `gw-ontology-${process.pid}.yaml`);
    await writeFile(file, "nodeTypes: [Microservice]\nedgeTypes: [OWNS]\n");
    const config = await loadConfig({ ...demo, GWARDEN_ONTOLOGY: file });
    expect(config.ontology.nodeTypes).toContain("Microservice");
    await writeFile(file, "nodeTypes: [micro service]\n");
    await expect(loadConfig({ ...demo, GWARDEN_ONTOLOGY: file })).rejects.toThrow();

    const app = buildApi({ reader: createReader(createMemoryStore(), createMemoryAuditLog()), identity: config.identity, ontology: config.ontology });
    const response = await app.inject({ method: "GET", url: "/v1/ontology", headers: { authorization: `Bearer ${tokens.lea}` } });
    expect(response.json()).toMatchObject({ nodeTypes: expect.arrayContaining(["Decision", "Microservice"]), edgeTypes: expect.arrayContaining(["OWNS"]) });
    expect((await app.inject({ method: "GET", url: "/v1/ontology" })).statusCode).toBe(401);
  });

  it("needs a model, and a key or a server, for an OpenAI-compatible API", async () => {
    const users = join(tmpdir(), `gw-users-openai-${process.pid}.yaml`);
    await writeFile(users, `- { token: ${tokens.lea}, user: lea, teams: [bff] }\n`);
    const demo = { ...base, GWARDEN_IDENTITY: "demo", GWARDEN_DEMO_USERS: users, GWARDEN_DEMO: "i-understand-anyone-with-a-token-is-that-user", GWARDEN_LLM: "openai" };
    await expect(loadConfig({ ...demo, OPENAI_API_KEY: "sk-test" })).rejects.toThrow(/GWARDEN_LLM_MODEL/);
    await expect(loadConfig({ ...demo, GWARDEN_LLM_MODEL: "gpt-5", OPENAI_API_KEY: "" })).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(loadConfig({ ...demo, GWARDEN_LLM_MODEL: "llama3.3", GWARDEN_LLM_BASE_URL: "localhost:11434" })).rejects.toThrow();
    const config = await loadConfig({ ...demo, GWARDEN_LLM_MODEL: "llama3.3", GWARDEN_LLM_BASE_URL: "http://ollama:11434/v1", OPENAI_API_KEY: "" });
    expect(config).toMatchObject({ GWARDEN_LLM: "openai", GWARDEN_LLM_BASE_URL: "http://ollama:11434/v1" });
    expect(config.OPENAI_API_KEY).toBeUndefined();
  });

  it("needs an issuer and an audience for OIDC", async () => {
    await expect(loadConfig({ ...base, GWARDEN_IDENTITY: "oidc", OIDC_ISSUER: "https://login.example.com" })).rejects.toThrow();
  });
});
