import type { Connector, Edge, Node, Scope } from "@graph-warden/core";
import { z } from "zod";

// GitLab (issue #19). Code comes in through git like any repository: the worker clones and polls
// GitLab remotes as others, and takes GitLab's merge-request and push webhooks (`gitlabEvent`).
// This connector adds what git does not hold, the merged merge requests: why a change was made,
// as `Change` nodes linked to the merge requests they mention (`!12`).
//
// Scopes come from the project's permissions: a public or internal project is readable by every
// signed-in user (`shared`); a private one by the members of its namespace, the group GitLab
// grants it to, as a team (`team:acme/payments`, renamed with `team`). A private project in a
// user's own namespace is private to that user.

export interface GitLabOptions {
  // `https://gitlab.com` or a self-managed instance.
  readonly baseUrl: string;
  readonly token: string;
  // Projects by path: `acme/shop`.
  readonly projects: readonly string[];
  // The team of a GitLab group, as the identity provider names it; the full path by default.
  readonly team?: (group: string) => string;
  readonly fetch?: typeof fetch;
}

const Project = z.object({
  path_with_namespace: z.string().min(1),
  visibility: z.enum(["public", "internal", "private"]),
  namespace: z.object({ full_path: z.string().min(1), kind: z.enum(["group", "user"]) }),
});
const MergeRequest = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.string(),
  merge_commit_sha: z.string().nullable().optional(),
});

export const mergeRequestId = (project: string, iid: number): string => `gitlab:${project}!${iid}`;
export const gitlabSource = (baseUrl: string): string => `gitlab:${new URL(baseUrl).host}`;

export function projectScope(project: z.infer<typeof Project>, team: (group: string) => string = (group) => group): Scope {
  if (project.visibility !== "private") return { kind: "shared" };
  return project.namespace.kind === "user" ? { kind: "private", user: project.namespace.full_path } : { kind: "team", team: team(project.namespace.full_path) };
}

export function createGitLabConnector(options: GitLabOptions): Connector {
  const { baseUrl, token, projects, team, fetch: send = fetch } = options;
  const source = gitlabSource(baseUrl);
  const api = async (path: string): Promise<{ body: unknown; next?: string } | undefined> => {
    const response = await send(`${baseUrl.replace(/\/+$/, "")}/api/v4/${path}`, { headers: { "private-token": token } });
    // A project the token no longer reads is gone for the graph too: its nodes are deleted.
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitLab ${path}: ${response.status}`);
    const next = response.headers.get("x-next-page");
    return { body: await response.json(), ...(next ? { next } : {}) };
  };

  const readProject = async (path: string) => {
    const encoded = encodeURIComponent(path);
    const found = await api(`projects/${encoded}`);
    if (found === undefined) return undefined;
    const project = Project.parse(found.body);
    const requests: z.infer<typeof MergeRequest>[] = [];
    for (let page: string | undefined = "1"; page !== undefined; ) {
      const listed = await api(`projects/${encoded}/merge_requests?state=merged&per_page=100&page=${page}`);
      if (listed === undefined) return undefined;
      requests.push(...z.array(MergeRequest).parse(listed.body));
      page = listed.next;
    }
    return { project, requests };
  };

  return {
    source,
    async read() {
      const nodes: Node[] = [];
      const edges: Edge[] = [];
      for (const path of [...projects].sort()) {
        const read = await readProject(path);
        if (read === undefined) continue;
        const { project, requests } = read;
        const scope = projectScope(project, team);
        const name = project.path_with_namespace;
        const iids = new Set(requests.map((request) => request.iid));
        for (const request of [...requests].sort((a, b) => a.iid - b.iid)) {
          const id = mergeRequestId(name, request.iid);
          const body = request.description?.trim();
          nodes.push({
            id,
            type: "Change",
            scope,
            provenance: { source, path: `projects/${name}/merge_requests/${request.iid}` },
            title: `!${request.iid} ${request.title}`,
            ...(body ? { body } : {}),
          });
          for (const match of (request.description ?? "").matchAll(/(?<![\w/])!(\d+)\b/g)) {
            const other = Number(match[1]);
            if (other !== request.iid && iids.has(other)) edges.push({ type: "REFERENCES", from: id, to: mergeRequestId(name, other) });
          }
        }
      }
      return { nodes, edges: [...new Map(edges.map((edge) => [`${edge.from} ${edge.to}`, edge])).values()] };
    },
    async readScopes() {
      // Visibility and namespace are the project's, not each merge request's: one call per project
      // and a listing of ids.
      const scopes = new Map<string, Scope>();
      for (const path of projects) {
        const read = await readProject(path);
        if (read === undefined) continue;
        const scope = projectScope(read.project, team);
        for (const request of read.requests) scopes.set(mergeRequestId(read.project.path_with_namespace, request.iid), scope);
      }
      return scopes;
    },
  };
}

// A GitLab webhook (merge-request or push hook) as the commit a watched branch reached, if any.
// GitLab signs nothing: the hook carries the shared secret in X-Gitlab-Token, checked by the caller.
const MergeHook = z.object({
  object_kind: z.literal("merge_request"),
  project: z.object({ path_with_namespace: z.string().min(1) }),
  object_attributes: z.object({ action: z.string().optional(), target_branch: z.string(), merge_commit_sha: z.string().nullable().optional() }),
});
const PushHook = z.object({ object_kind: z.literal("push"), ref: z.string(), after: z.string(), project: z.object({ path_with_namespace: z.string().min(1) }) });

export function gitlabEvent(body: unknown): { readonly project: string; readonly branch: string; readonly sha: string } | undefined {
  const merge = MergeHook.safeParse(body);
  if (merge.success) {
    const { action, target_branch, merge_commit_sha } = merge.data.object_attributes;
    if (action !== "merge" || !merge_commit_sha) return undefined;
    return { project: merge.data.project.path_with_namespace, branch: target_branch, sha: merge_commit_sha };
  }
  const push = PushHook.safeParse(body);
  if (push.success && push.data.ref.startsWith("refs/heads/") && !/^0+$/.test(push.data.after)) {
    return { project: push.data.project.path_with_namespace, branch: push.data.ref.slice("refs/heads/".length), sha: push.data.after };
  }
  return undefined;
}
