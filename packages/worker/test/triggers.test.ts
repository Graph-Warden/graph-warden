import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIngester, createWriter, type IngestionQueue } from "@graph-warden/core";
import { createDocumentExtractor } from "@graph-warden/documents";
import { createMemoryEventLog, createMemoryIngestionState, createMemoryQueue, createMemoryStore } from "@graph-warden/memory";
import { createGitRepository } from "@graph-warden/git";
import { buildTriggers, createPoller } from "../src/triggers.js";

const SECRET = "webhook-secret-for-tests";
const TOKEN = "push-token-for-tests-only";
const SHA = "5a03dc8b2f6c1e0d9a7b4c3e2f1a0b9c8d7e6f5a";

function recordingQueue(): IngestionQueue & { readonly jobs: string[] } {
  const jobs: string[] = [];
  return {
    jobs,
    enqueue: async (repo, sha) => void jobs.push(`${repo} ${sha}`),
    start: async () => ({ stop: async () => {} }),
  };
}

const push = (overrides: object = {}) =>
  JSON.stringify({ ref: "refs/heads/main", after: SHA, repository: { full_name: "acme/shop" }, ...overrides });
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("GitLab webhook", () => {
  const merge = (overrides: object = {}) =>
    JSON.stringify({ object_kind: "merge_request", project: { path_with_namespace: "acme/shop" }, object_attributes: { action: "merge", target_branch: "main", merge_commit_sha: SHA, ...overrides } });
  const send = (app: ReturnType<typeof buildTriggers>, payload: string, token = SECRET) =>
    app.inject({ method: "POST", url: "/webhooks/gitlab", headers: { "content-type": "application/json", "x-gitlab-token": token, "x-gitlab-event": "Merge Request Hook" }, payload });

  it("queues the merge commit of a merge request into the watched branch, with the right token only", async () => {
    const queue = recordingQueue();
    const app = buildTriggers({ queue, repositories: [{ name: "gitlab:acme/shop", branch: "main" }], gitlabSecret: SECRET });
    expect((await send(app, merge(), "wrong-token-of-same-size!")).statusCode).toBe(401);
    expect((await send(app, merge({ action: "open" }))).statusCode).toBe(202);
    expect((await send(app, merge({ target_branch: "dev" }))).statusCode).toBe(202);
    expect((await send(app, merge())).statusCode).toBe(202);
    expect(queue.jobs).toEqual([`gitlab:acme/shop ${SHA}`]);
    const off = buildTriggers({ queue, repositories: [] });
    expect((await send(off, merge())).statusCode).toBe(404);
  });
});

describe("GitHub webhook", () => {
  const setup = () => {
    const queue = recordingQueue();
    const app = buildTriggers({ queue, repositories: [{ name: "github:acme/shop", branch: "main" }], webhookSecret: SECRET });
    const send = (body: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: "/webhooks/github",
        headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": sign(body), ...headers },
        payload: body,
      });
    return { queue, send };
  };

  it("queues a push to the watched branch", async () => {
    const { queue, send } = setup();
    expect((await send(push())).statusCode).toBe(202);
    expect(queue.jobs).toEqual([`github:acme/shop ${SHA}`]);
  });

  it("reads nothing from a request whose signature does not match", async () => {
    const { queue, send } = setup();
    const body = push();
    expect((await send(body, { "x-hub-signature-256": sign(body, "another-secret-entirely") })).statusCode).toBe(401);
    expect((await send(body, { "x-hub-signature-256": sign(push({ after: "f".repeat(40) })) })).statusCode).toBe(401);
    const unsigned = await setup().send(body, { "x-hub-signature-256": "" });
    expect(unsigned.statusCode).toBe(401);
    expect(queue.jobs).toEqual([]);
  });

  it("ignores other branches, other repositories, branch deletions and other events", async () => {
    const { queue, send } = setup();
    await send(push({ ref: "refs/heads/feature" }));
    await send(push({ repository: { full_name: "acme/other" } }));
    await send(push({ after: "0".repeat(40) }));
    await send(push(), { "x-github-event": "pull_request" });
    expect(queue.jobs).toEqual([]);
  });

  it("is off without a secret", async () => {
    const app = buildTriggers({ queue: recordingQueue(), repositories: [] });
    expect((await app.inject({ method: "POST", url: "/webhooks/github", payload: {} })).statusCode).toBe(404);
  });
});

describe("Push from CI", () => {
  const setup = () => {
    const queue = recordingQueue();
    const app = buildTriggers({ queue, repositories: [{ name: "github:acme/shop", branch: "main" }], pushToken: TOKEN });
    const send = (body: object, token = TOKEN) =>
      app.inject({ method: "POST", url: "/v1/jobs", headers: { authorization: `Bearer ${token}` }, payload: body });
    return { queue, send };
  };

  it("queues the commit CI reports", async () => {
    const { queue, send } = setup();
    expect((await send({ repo: "github:acme/shop", sha: SHA, ref: "refs/heads/main" })).statusCode).toBe(202);
    expect(queue.jobs).toEqual([`github:acme/shop ${SHA}`]);
  });

  it("refuses a wrong token, an unknown repository, and ignores another branch", async () => {
    const { queue, send } = setup();
    expect((await send({ repo: "github:acme/shop", sha: SHA }, "not-the-token-at-all-really")).statusCode).toBe(401);
    expect((await send({ repo: "github:acme/other", sha: SHA })).statusCode).toBe(404);
    expect((await send({ repo: "github:acme/shop", sha: "HEAD" })).statusCode).toBe(400);
    expect((await send({ repo: "github:acme/shop", sha: SHA, ref: "refs/heads/feature" })).statusCode).toBe(202);
    expect(queue.jobs).toEqual([]);
  });
});

describe("Polling", () => {
  let dir: string;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gwarden-poll-"));
    git(dir, "init", "-q", "-b", "main", "origin");
    git(join(dir, "origin"), "config", "user.email", "ci@example.com");
    git(join(dir, "origin"), "config", "user.name", "CI");
    writeFileSync(join(dir, "origin", "a.md"), "# A\n");
    git(join(dir, "origin"), "add", "-A");
    git(join(dir, "origin"), "commit", "-q", "-m", "a");
    execFileSync("git", ["clone", "-q", join(dir, "origin"), join(dir, "clone")]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("queues the branch when it moved, once", async () => {
    const queue = recordingQueue();
    const clone = createGitRepository(join(dir, "clone"));
    const poll = createPoller(queue, [{ name: "github:acme/shop", branch: "main", fetch: clone.fetch, head: clone.head }]);
    await poll();
    await poll();
    writeFileSync(join(dir, "origin", "b.md"), "# B\n");
    git(join(dir, "origin"), "add", "-A");
    git(join(dir, "origin"), "commit", "-q", "-m", "b");
    await poll();
    const heads = queue.jobs.map((job) => job.split(" ")[1]);
    expect(heads).toHaveLength(2);
    expect(heads[1]).toBe(git(join(dir, "origin"), "rev-parse", "HEAD"));
    expect(await clone.has(heads[1] ?? "")).toBe(true);
  });

  it("feeds one queue from all three triggers, the ingester resuming from the last commit", async () => {
    const origin = join(dir, "origin");
    const commit = (file: string) => {
      writeFileSync(join(origin, file), `# ${file}\n`);
      git(origin, "add", "-A");
      git(origin, "commit", "-q", "-m", file);
      return git(origin, "rev-parse", "HEAD");
    };
    const clone = createGitRepository(join(dir, "clone"));
    const store = createMemoryStore();
    const name = "github:acme/shop";
    const ingester = createIngester({
      store,
      writer: createWriter(store, createMemoryEventLog()),
      state: createMemoryIngestionState(),
      repositories: new Map([[name, { config: { name, scope: { kind: "shared" }, author: { user: "ci", teams: [] } }, repository: clone }]]),
      extractors: [createDocumentExtractor()],
    });
    const queue = createMemoryQueue();
    const worker = await queue.start(async (repo, sha) => {
      if (!(await clone.has(sha))) await clone.fetch();
      await ingester.ingest(repo, sha);
    });
    const app = buildTriggers({ queue, repositories: [{ name, branch: "main" }], webhookSecret: SECRET, pushToken: TOKEN });

    await createPoller(queue, [{ name, branch: "main", fetch: clone.fetch, head: clone.head }])();
    commit("b.md");
    // Nobody reports c: the webhook for d brings it in, in order.
    commit("c.md");
    const d = commit("d.md");
    const body = push({ after: d });
    await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    const e = commit("e.md");
    await app.inject({ method: "POST", url: "/v1/jobs", headers: { authorization: `Bearer ${TOKEN}` }, payload: { repo: name, sha: e } });
    await worker.stop();
    for (let i = 0; i < 100 && !(await store.snapshot()).nodes.has("e"); i++) await new Promise((r) => setTimeout(r, 20));

    const graph = await store.snapshot();
    expect([...graph.nodes.values()].filter((n) => n.type === "Change").map((n) => n.title).sort()).toEqual(["a", "b.md", "c.md", "d.md", "e.md"]);
    expect([...graph.nodes.keys()].filter((id) => !id.includes("@")).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });
});
