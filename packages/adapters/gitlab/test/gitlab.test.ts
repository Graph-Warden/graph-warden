import { describe, expect, it } from "vitest";
import { checkSource, createConnectorSync, createWriter, formatScope, type Node } from "@graph-warden/core";
import { createMemoryEventLog, createMemoryStore } from "@graph-warden/memory";
import { createGitLabConnector, gitlabEvent, mergeRequestId, projectScope } from "../src/index.js";

// Issue #19: GitLab passes the source conformance suite; project permissions become scopes.

// A GitLab API answering from files: `projects/<path>` is a project, `projects/<path>/merge_requests/<iid>`
// a merge request, listed two by page.
function fakeGitLab(files: ReadonlyMap<string, string>) {
  const calls: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const rest = decodeURIComponent(url.pathname.replace(/^\/api\/v4\//, ""));
    const list = /^projects\/(.+)\/merge_requests$/.exec(rest);
    if (list !== null) {
      if (!files.has(`projects/${list[1]}`)) return new Response("", { status: 404 });
      const all = [...files].filter(([path]) => path.startsWith(`projects/${list[1]}/merge_requests/`)).map(([, text]) => JSON.parse(text));
      const page = Number(url.searchParams.get("page") ?? 1);
      const headers = page * 2 < all.length ? { "x-next-page": String(page + 1) } : {};
      return Response.json(all.slice((page - 1) * 2, page * 2), { headers });
    }
    const text = files.get(rest);
    return text === undefined ? new Response("", { status: 404 }) : new Response(text, { headers: { "content-type": "application/json" } });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const project = (path: string, visibility: string, namespace = path.split("/")[0], kind = "group") =>
  JSON.stringify({ path_with_namespace: path, visibility, namespace: { full_path: namespace, kind } });
const mr = (iid: number, title: string, description: string | null) => JSON.stringify({ iid, title, description, state: "merged", merge_commit_sha: "a".repeat(40) });

const files = new Map([
  ["projects/acme/shop", project("acme/shop", "internal")],
  ["projects/acme/shop/merge_requests/1", mr(1, "Cursor pagination", "Replaces offsets.")],
  ["projects/acme/shop/merge_requests/2", mr(2, "Fix the last page", "Follows !1, see also !99.")],
  ["projects/acme/shop/merge_requests/3", mr(3, "Retry GET /orders", null)],
  ["projects/acme/payments/ledger", project("acme/payments/ledger", "private", "acme/payments")],
  ["projects/acme/payments/ledger/merge_requests/7", mr(7, "Round to cents", "")],
  ["projects/lea/sandbox", project("lea/sandbox", "private", "lea", "user")],
  ["projects/lea/sandbox/merge_requests/1", mr(1, "Try things", "")],
]);
const projects = ["acme/shop", "acme/payments/ledger", "lea/sandbox"];
const connector = (given: ReadonlyMap<string, string>) => createGitLabConnector({ baseUrl: "https://gitlab.example.com", token: "t", projects, fetch: fakeGitLab(given).fetch });

describe("GitLab connector", () => {
  it("passes the source conformance suite", async () => {
    const violations = await checkSource({
      source: "gitlab:gitlab.example.com",
      files,
      extract: (given) => connector(given).read(),
      // Merge requests declare no scope: they take their project's.
      undeclared: [mergeRequestId("acme/shop", 1), mergeRequestId("acme/shop", 3)],
      defaultScope: { kind: "shared" },
    });
    expect(violations).toEqual([]);
  });

  it("maps project permissions to scopes, and links the merge requests a description mentions", async () => {
    const { nodes, edges } = await connector(files).read();
    expect(Object.fromEntries(nodes.map((node) => [node.id, formatScope(node.scope)]))).toEqual({
      "gitlab:acme/shop!1": "shared",
      "gitlab:acme/shop!2": "shared",
      "gitlab:acme/shop!3": "shared",
      "gitlab:acme/payments/ledger!7": "team:acme/payments",
      "gitlab:lea/sandbox!1": "private:lea",
    });
    expect(edges).toEqual([{ type: "REFERENCES", from: "gitlab:acme/shop!2", to: "gitlab:acme/shop!1" }]);
    expect(projectScope(JSON.parse(project("acme/payments/ledger", "private", "acme/payments")), (group) => group.split("/").at(-1) ?? group)).toEqual({ kind: "team", team: "payments" });
  });

  it("narrows the graph when a project becomes private, and removes what the token no longer reads", async () => {
    const store = createMemoryStore();
    const writer = createWriter(store, createMemoryEventLog());
    const sync = createConnectorSync(store, writer);
    await sync.sync(connector(files));
    // An answer filed from a merge request of the shop.
    const answer: Node = { id: "answer", type: "Concept", scope: { kind: "shared" }, provenance: { source: "ask:lea", path: "answer" } };
    await writer.upsertNodes([answer]);
    await writer.upsertEdges([{ type: "DERIVED_FROM", from: "answer", to: "gitlab:acme/shop!1" }]);

    const narrowed = new Map(files);
    narrowed.set("projects/acme/shop", project("acme/shop", "private"));
    narrowed.delete("projects/lea/sandbox");
    const report = await sync.rescope(connector(narrowed));
    expect(report.rescoped.sort()).toEqual(["gitlab:acme/shop!1", "gitlab:acme/shop!2", "gitlab:acme/shop!3"]);
    expect(report.narrowed).toEqual(["answer"]);
    expect(formatScope((await store.getNode("answer"))?.scope ?? { kind: "shared" })).toBe("team:acme");

    expect((await sync.sync(connector(narrowed))).deleted).toEqual(["gitlab:lea/sandbox!1"]);
  });
});

describe("gitlabEvent", () => {
  const sha = "b".repeat(40);
  it("reads a merge and a push to a branch, and nothing else", () => {
    expect(gitlabEvent({ object_kind: "merge_request", project: { path_with_namespace: "acme/shop" }, object_attributes: { action: "merge", target_branch: "main", merge_commit_sha: sha } })).toEqual({ project: "acme/shop", branch: "main", sha });
    expect(gitlabEvent({ object_kind: "merge_request", project: { path_with_namespace: "acme/shop" }, object_attributes: { action: "open", target_branch: "main" } })).toBeUndefined();
    expect(gitlabEvent({ object_kind: "push", ref: "refs/heads/main", after: sha, project: { path_with_namespace: "acme/shop" } })).toEqual({ project: "acme/shop", branch: "main", sha });
    expect(gitlabEvent({ object_kind: "push", ref: "refs/heads/main", after: "0".repeat(40), project: { path_with_namespace: "acme/shop" } })).toBeUndefined();
    expect(gitlabEvent({ object_kind: "tag_push", ref: "refs/tags/v1" })).toBeUndefined();
  });
});
