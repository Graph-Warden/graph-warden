import { describe, expect, it } from "vitest";
import { checkSource, formatScope, type Node } from "@graph-warden/core";
import { adfText, changeLinks, createJiraConnector, issueId, schemeScope, UnmappedPermissions } from "../src/index.js";

// Issue #21: Jira passes the source conformance suite; project permissions become scopes.

// A Jira API answering from files (`issues/<KEY>`), two issues a page, with permission schemes.
function fakeJira(files: ReadonlyMap<string, string>, schemes: Record<string, object>) {
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.replace(/^\/rest\/api\/3\//, ""));
    const scheme = /^project\/([^/]+)\/permissionscheme$/.exec(path);
    if (scheme !== null) return schemes[scheme[1] ?? ""] === undefined ? new Response("", { status: 404 }) : Response.json(schemes[scheme[1] ?? ""]);
    if (path === "search/jql") {
      const project = /project = "([^"]+)"/.exec(url.searchParams.get("jql") ?? "")?.[1] ?? "";
      const all = [...files].filter(([key]) => key.startsWith(`issues/${project}-`)).map(([, text]) => JSON.parse(text));
      const at = Number(url.searchParams.get("nextPageToken") ?? 0);
      const last = at + 2 >= all.length;
      return Response.json({ issues: all.slice(at, at + 2), isLast: last, ...(last ? {} : { nextPageToken: String(at + 2) }) });
    }
    return new Response("", { status: 404 });
  };
  return fetch as typeof globalThis.fetch;
}

const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const issue = (key: string, type: string, summary: string, links: object[] = [], description: unknown = adf(`About ${summary}.`)) =>
  JSON.stringify({ key, fields: { summary, description, issuetype: { name: type }, issuelinks: links } });
const causes = { outward: "causes", inward: "is caused by" };
const files = new Map([
  ["issues/SHOP-1", issue("SHOP-1", "Story", "Cursor pagination")],
  ["issues/SHOP-2", issue("SHOP-2", "Bug", "Last page skipped", [{ type: { outward: "fixes", inward: "is fixed by" }, inwardIssue: { key: "SHOP-3" } }])],
  ["issues/SHOP-3", issue("SHOP-3", "Task", "Fix the cursor", [{ type: { outward: "fixes", inward: "is fixed by" }, outwardIssue: { key: "SHOP-2" } }], null)],
  ["issues/OPS-7", issue("OPS-7", "Incident", "Orders down", [{ type: causes, inwardIssue: { key: "SHOP-2" } }, { type: { outward: "relates to", inward: "relates to" }, outwardIssue: { key: "OPS-8" } }])],
  ["issues/OPS-8", issue("OPS-8", "Task", "Postmortem")],
]);
const schemes = {
  SHOP: { permissions: [{ permission: "BROWSE_PROJECTS", holder: { type: "applicationRole" } }, { permission: "EDIT_ISSUES", holder: { type: "group", parameter: "bff" } }] },
  OPS: { permissions: [{ permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "sre" } }, { permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "bff" } }] },
};
const connector = (given: ReadonlyMap<string, string>, overrides: object = {}) =>
  createJiraConnector({ baseUrl: "https://acme.atlassian.net", email: "ci@acme.example", token: "t", projects: ["SHOP", "OPS"], fetch: fakeJira(given, schemes), ...overrides });

describe("Jira connector", () => {
  it("passes the source conformance suite", async () => {
    expect(
      await checkSource({ source: "jira:acme.atlassian.net", files, extract: (given) => connector(given).read(), undeclared: [issueId("SHOP-1")], defaultScope: { kind: "shared" } }),
    ).toEqual([]);
  });

  it("maps permission schemes to scopes and issue links to edges", async () => {
    const { nodes, edges } = await connector(files).read();
    expect(Object.fromEntries(nodes.map((node) => [node.id, `${node.type} ${formatScope(node.scope)}`]))).toEqual({
      "jira:OPS-7": "Incident teams:bff,sre",
      "jira:OPS-8": "Concept teams:bff,sre",
      "jira:SHOP-1": "Concept shared",
      "jira:SHOP-2": "Incident shared",
      "jira:SHOP-3": "Concept shared",
    });
    expect(nodes.find((node) => node.id === "jira:SHOP-1")?.body).toBe("About Cursor pagination.");
    expect(edges.map((edge) => `${edge.from} ${edge.type} ${edge.to}`).sort()).toEqual([
      "jira:OPS-7 REFERENCES jira:OPS-8",
      "jira:SHOP-2 CAUSES jira:OPS-7",
      "jira:SHOP-3 FIXES jira:SHOP-2",
    ]);
  });

  it("refuses a project whose permissions it cannot map, unless given its scope", async () => {
    const roles = { permissions: [{ permission: "BROWSE_PROJECTS", holder: { type: "projectRole", parameter: "10002" } }] };
    expect(() => schemeScope("HR", roles)).toThrow(UnmappedPermissions);
    await expect(connector(files, { projects: ["HR"] }).read()).rejects.toThrow();
    const { nodes } = await connector(new Map([["issues/HR-1", issue("HR-1", "Task", "Payroll")]]), { projects: ["HR"], scopes: { HR: { kind: "team", team: "hr" } } }).read();
    expect(formatScope(nodes[0]?.scope ?? { kind: "shared" })).toBe("team:hr");
  });
});

describe("adfText and changeLinks", () => {
  it("reads a description as text", () => {
    expect(adfText({ type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Why" }] }, { type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] }] })).toBe("Why\na\nb");
  });

  it("links a commit to the issues its message fixes or names", () => {
    const change: Node = { id: "github:acme/shop@5a03dc8", type: "Change", scope: { kind: "shared" }, provenance: { source: "github:acme/shop", path: "." }, title: "Fix the cursor (fixes SHOP-2)", body: "See SHOP-1 and OPS-7, closes: SHOP-2. Not NOPE-1." };
    const known = new Set(["jira:SHOP-1", "jira:SHOP-2", "jira:OPS-7"]);
    expect(changeLinks(change, (id) => known.has(id)).map((edge) => `${edge.type} ${edge.to}`).sort()).toEqual(["FIXES jira:SHOP-2", "REFERENCES jira:OPS-7", "REFERENCES jira:SHOP-1"]);
  });
});
