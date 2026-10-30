import type { Connector, Edge, Node, Scope } from "@graph-warden/core";
import { teamsScope } from "@graph-warden/core";
import { z } from "zod";

// Jira (issue #21): issues as nodes (`Incident` for incidents and bugs, `Concept` otherwise), their
// links as edges (`CAUSES` for "causes", `FIXES` for "fixes", `REFERENCES` for any other link), and
// commits linked to the issues their message names (`changeLinks`).
//
// Scopes come from each project's permission scheme: who holds "Browse projects".
// - anyone, or any logged-in user: `shared`;
// - groups: the members of every group (`team:x`, `teams:x,y`). Jira grants to members of any of
//   them, which a scope cannot say; requiring all of them narrows, never widens;
// - anything else (users, project roles, a field of the issue): not something the graph can check,
//   so the project needs a scope in `scopes`, or it is not read at all.

export interface JiraOptions {
  // `https://acme.atlassian.net`.
  readonly baseUrl: string;
  // An Atlassian account email and API token, for basic authentication.
  readonly email: string;
  readonly token: string;
  readonly projects: readonly string[];
  // Scopes set by hand, for projects whose permissions are not groups only.
  readonly scopes?: Readonly<Record<string, Scope>>;
  // The team of a Jira group, as the identity provider names it; the group name by default.
  readonly team?: (group: string) => string;
  readonly fetch?: typeof fetch;
}

export const issueId = (key: string): string => `jira:${key}`;

// Atlassian Document Format, the JSON of a description, as plain text.
type Adf = { readonly type?: string; readonly text?: string; readonly content?: readonly Adf[] };
const BLOCKS = new Set(["paragraph", "heading", "listItem", "codeBlock", "blockquote", "rule", "tableRow"]);
export function adfText(doc: unknown): string {
  if (typeof doc === "string") return doc;
  const walk = (node: Adf): string => {
    const inner = (node.text ?? "") + (node.content ?? []).map(walk).join("");
    return BLOCKS.has(node.type ?? "") ? `${inner}\n` : node.type === "hardBreak" ? "\n" : inner;
  };
  return doc !== null && typeof doc === "object" ? walk(doc as Adf).trim() : "";
}

const Linked = z.object({ key: z.string() });
const Issue = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
  fields: z.object({
    summary: z.string(),
    description: z.unknown().optional(),
    issuetype: z.object({ name: z.string() }),
    issuelinks: z
      .array(
        z.object({
          type: z.object({ outward: z.string(), inward: z.string() }),
          outwardIssue: Linked.optional(),
          inwardIssue: Linked.optional(),
        }),
      )
      .default([]),
  }),
});
const Search = z.object({ issues: z.array(Issue), nextPageToken: z.string().optional(), isLast: z.boolean().optional() });
const Scheme = z.object({
  permissions: z.array(z.object({ permission: z.string(), holder: z.object({ type: z.string(), parameter: z.string().optional(), value: z.string().optional() }) })),
});

const linkType = (description: string): Edge["type"] =>
  /^causes$/i.test(description.trim()) ? "CAUSES" : /^fix(es)?$/i.test(description.trim()) ? "FIXES" : "REFERENCES";

export class UnmappedPermissions extends Error {
  override readonly name = "UnmappedPermissions";
}

export function schemeScope(project: string, scheme: z.infer<typeof Scheme>, team: (group: string) => string = (group) => group): Scope {
  const holders = scheme.permissions.filter((p) => p.permission === "BROWSE_PROJECTS").map((p) => p.holder);
  if (holders.some((holder) => holder.type === "anyone" || (holder.type === "applicationRole" && holder.parameter === undefined))) return { kind: "shared" };
  const groups = holders.filter((holder) => holder.type === "group").map((holder) => holder.parameter ?? holder.value ?? "");
  const other = holders.filter((holder) => holder.type !== "group" && holder.type !== "applicationRole");
  if (other.length > 0 || groups.length === 0 || groups.includes("")) {
    throw new UnmappedPermissions(`${project}: Browse projects is granted to ${holders.map((h) => h.type).join(", ") || "nobody"}; give the project a scope`);
  }
  return teamsScope(groups.map(team));
}

export function createJiraConnector(options: JiraOptions): Connector {
  const { baseUrl, email, token, projects, scopes = {}, team, fetch: send = fetch } = options;
  const host = new URL(baseUrl).host;
  const source = `jira:${host}`;
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  const api = async (path: string): Promise<unknown> => {
    const response = await send(`${baseUrl.replace(/\/+$/, "")}/rest/api/3/${path}`, { headers: { authorization, accept: "application/json" } });
    if (!response.ok) throw new Error(`Jira ${path}: ${response.status}`);
    return response.json();
  };
  const scopeOf = async (project: string) =>
    scopes[project] ?? schemeScope(project, Scheme.parse(await api(`project/${encodeURIComponent(project)}/permissionscheme?expand=permissions`)), team);
  const issuesOf = async (project: string, fields: string) => {
    const issues: z.infer<typeof Issue>[] = [];
    let next: string | undefined;
    do {
      const query = new URLSearchParams({ jql: `project = "${project}" ORDER BY key`, fields, maxResults: "100", ...(next === undefined ? {} : { nextPageToken: next }) });
      const page = Search.parse(await api(`search/jql?${query}`));
      issues.push(...page.issues);
      next = page.isLast === false ? page.nextPageToken : undefined;
    } while (next !== undefined);
    return issues;
  };

  return {
    source,
    async read() {
      const nodes: Node[] = [];
      const links: Edge[] = [];
      for (const project of [...projects].sort()) {
        const scope = await scopeOf(project);
        for (const issue of await issuesOf(project, "summary,description,issuetype,issuelinks")) {
          const id = issueId(issue.key);
          const body = adfText(issue.fields.description);
          nodes.push({
            id,
            type: /incident|bug/i.test(issue.fields.issuetype.name) ? "Incident" : "Concept",
            scope,
            provenance: { source, path: `issues/${issue.key}` },
            title: `${issue.key}: ${issue.fields.summary}`,
            ...(body === "" ? {} : { body }),
          });
          for (const link of issue.fields.issuelinks) {
            // Each link is listed on both issues: read from the side where it points outward.
            if (link.outwardIssue !== undefined) links.push({ type: linkType(link.type.outward), from: id, to: issueId(link.outwardIssue.key) });
            if (link.inwardIssue !== undefined) links.push({ type: linkType(link.type.outward), from: issueId(link.inwardIssue.key), to: id });
          }
        }
      }
      const ids = new Set(nodes.map((node) => node.id));
      const edges = [...new Map(links.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge) => [`${edge.type} ${edge.from} ${edge.to}`, edge])).values()];
      return { nodes, edges };
    },
    async readScopes() {
      const result = new Map<string, Scope>();
      for (const project of projects) {
        const scope = await scopeOf(project);
        for (const issue of await issuesOf(project, "issuetype")) result.set(issueId(issue.key), scope);
      }
      return result;
    },
  };
}

// The issues a commit message names: `FIXES` for "fixes", "closes" or "resolves" before the key,
// `REFERENCES` for a bare mention. For the worker, after each commit is ingested.
export function changeLinks(change: Node, exists: (id: string) => boolean): Edge[] {
  const text = `${change.title ?? ""}\n${change.body ?? ""}`;
  const edges = new Map<string, Edge>();
  for (const match of text.matchAll(/\b(?:(fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s+)?([A-Z][A-Z0-9_]+-\d+)\b/gi)) {
    const key = (match[2] ?? "").toUpperCase();
    const to = issueId(key);
    if (!exists(to)) continue;
    const type = match[1] === undefined ? "REFERENCES" : "FIXES";
    if (type === "REFERENCES" && edges.has(`FIXES ${to}`)) continue;
    if (type === "FIXES") edges.delete(`REFERENCES ${to}`);
    edges.set(`${type} ${to}`, { type, from: change.id, to });
  }
  return [...edges.values()];
}
