import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeId, createHistory, createIngester, createReader, createWriter, type Node } from "@graph-warden/core";
import { createDocumentExtractor } from "@graph-warden/documents";
import { createGitRepository } from "@graph-warden/git";
import { createDemoIdentity } from "@graph-warden/identity";
import { createMemoryAuditLog, createMemoryEventLog, createMemoryIngestionState, createMemoryStore } from "@graph-warden/memory";
import { buildApi } from "../src/index.js";
import { createGitPast } from "../src/history.js";

const REPO = "github:acme/shop";
const tokens = { bob: "bob-token-0123456789", yan: "yan-token-0123456789" };

describe("history over git", () => {
  let dir: string;
  const shas: string[] = [];
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const commit = (message: string, files: Record<string, string>) => {
    const origin = join(dir, "origin");
    for (const [path, text] of Object.entries(files)) writeFileSync(join(origin, path), text);
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", message);
    shas.push(git(origin, "rev-parse", "HEAD"));
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gwarden-history-"));
    git(dir, "init", "-q", "-b", "main", "origin");
    git(join(dir, "origin"), "config", "user.email", "ci@example.com");
    git(join(dir, "origin"), "config", "user.name", "CI");
    commit("Orders and payments", { "orders.md": "# Orders\nPaged by offset.\n", "payments.md": "---\nscope: team:bff\n---\n# Payments\n" });
    commit("Page orders with cursors", { "orders.md": "# Orders\nPaged with cursors. See [[payments]].\n" });
    execFileSync("git", ["clone", "-q", join(dir, "origin"), join(dir, "clone")]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const entry = () => ({ name: REPO, dir: join(dir, "clone"), branch: "main", scope: { kind: "shared" as const }, author: { user: "ci", teams: ["bff"] } });

  it("ingests a commit's tree into a copy, a short sha naming the same commit", async () => {
    const past = createGitPast({ repositories: [entry()], extractors: [createDocumentExtractor()] });
    const first = await past.at(REPO, shas[0] ?? "");
    expect([...(first?.nodes.keys() ?? [])].sort()).toEqual([changeId(REPO, shas[0] ?? ""), "orders", "payments"]);
    expect(first?.nodes.get("orders")?.body).toContain("offset");
    expect((await past.at(REPO, (shas[0] ?? "").slice(0, 8)))?.nodes.has(changeId(REPO, shas[0] ?? ""))).toBe(true);
    expect(await past.at(REPO, "f".repeat(40))).toBeUndefined();
    expect(await past.at(REPO, "HEAD")).toBeUndefined();
    expect(await past.commits(REPO, 10)).toEqual([
      { sha: shas[1], message: expect.stringMatching(/^Page orders with cursors\s*$/) },
      { sha: shas[0], message: expect.stringMatching(/^Orders and payments\s*$/) },
    ]);

    const between = await past.between(REPO, shas[0] ?? "", shas[1] ?? "");
    expect(between?.changed).toEqual(["orders"]);
    expect(between?.after.nodes.get("orders")?.body).toContain("cursors");
    expect(between?.before.nodes.get("orders")?.body).toContain("offset");
    expect(await past.between(REPO, shas[1] ?? "", shas[0] ?? "")).toBeUndefined();
  });

  it("serves the past at /v1/history, as each caller may see it", async () => {
    const store = createMemoryStore();
    const audit = createMemoryAuditLog();
    const writer = createWriter(store, createMemoryEventLog());
    const config = { name: REPO, scope: { kind: "shared" as const }, author: { user: "ci", teams: ["bff"] } };
    // The graph now: the worker ingested both commits.
    const ingester = createIngester({
      store,
      writer,
      state: createMemoryIngestionState(),
      repositories: new Map([[REPO, { config, repository: createGitRepository(join(dir, "clone")) }]]),
      extractors: [createDocumentExtractor()],
    });
    await ingester.ingest(REPO, shas[0] ?? "");
    await ingester.ingest(REPO, shas[1] ?? "");
    const history = createHistory(store, audit, createGitPast({ repositories: [entry()], extractors: [createDocumentExtractor()] }));
    const identity = createDemoIdentity([
      { token: tokens.bob, user: "bob", teams: ["bff"] },
      { token: tokens.yan, user: "yan", teams: ["data"] },
    ]);
    const app = buildApi({ reader: createReader(store, audit), identity, history });
    const get = async (url: string, token: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
    const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

    expect((await get("/v1/history", tokens.bob)).json()).toEqual({ repositories: [REPO] });
    expect(((await get(`/v1/history/commits?${q({ repo: REPO })}`, tokens.bob)).json().nodes as Node[]).map((n) => n.title)).toEqual([
      "Page orders with cursors",
      "Orders and payments",
    ]);
    const at = async (token: string) => ((await get(`/v1/history/graph?${q({ repo: REPO, sha: shas[0] ?? "" })}`, token)).json().nodes as Node[]).map((n) => n.id).sort();
    expect(await at(tokens.bob)).toEqual([changeId(REPO, shas[0] ?? ""), "orders", "payments"]);
    expect(await at(tokens.yan)).toEqual([changeId(REPO, shas[0] ?? ""), "orders"]);

    const impact = (await get(`/v1/history/impact?${q({ repo: REPO, base: shas[0] ?? "", head: shas[1] ?? "" })}`, tokens.yan)).json();
    expect(impact.highlighted).toEqual(["orders"]);
    expect((impact.nodes as Node[]).map((n) => n.id)).not.toContain("payments");

    expect((await get(`/v1/history/graph?${q({ repo: REPO, sha: "f".repeat(40) })}`, tokens.bob)).statusCode).toBe(404);
    expect((await get(`/v1/history/graph?${q({ repo: "github:acme/other", sha: shas[0] ?? "" })}`, tokens.bob)).statusCode).toBe(404);
    expect((await get("/v1/history/graph", tokens.bob)).statusCode).toBe(400);
    const off = buildApi({ reader: createReader(store, audit), identity });
    expect((await off.inject({ method: "GET", url: "/v1/history", headers: { authorization: `Bearer ${tokens.bob}` } })).statusCode).toBe(501);
  });
});
