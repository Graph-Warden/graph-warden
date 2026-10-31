import type { Delta, Edge, Node, NodeType, Ontology, Principal } from "@graph-warden/core";

// Calls to the API on the app's own origin, with the session cookie. Writes carry the header the
// API requires of cookie-authenticated writes (proposal 0012).

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function send(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const method = init.method ?? "GET";
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(method === "GET" ? {} : { "x-requested-with": "gwarden" }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new HttpError(response.status, detail.detail ?? detail.error ?? response.statusText);
  }
  return response;
}

const call = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => (await send(path, init)).json() as Promise<T>;

const node = (id: string) => `/v1/nodes/${encodeURIComponent(id)}`;

export interface DeletionPlan {
  readonly target: string;
  readonly deleted: readonly Node[];
  readonly detached: readonly Edge[];
  readonly digest: string;
}

export interface Answer {
  readonly answer: string;
  readonly sources: readonly Node[];
  readonly saved?: Node;
}

export interface PageDraft {
  readonly title: string;
  readonly body: string;
  readonly scope: string;
  readonly type: NodeType;
}

export interface PastGraph {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}

export interface ImpactView extends PastGraph {
  readonly impact: {
    readonly endpoints: readonly Node[];
    readonly consumers: readonly { readonly module: Node; readonly endpoints: readonly string[] }[];
    readonly knowledge: readonly Node[];
    readonly teams: readonly string[];
  };
  readonly commits: number;
  readonly highlighted: readonly string[];
}

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const api = {
  config: () => call<{ login: "demo" | "oidc" }>("/auth/config"),
  signInDemo: (token: string) => call<Principal>("/auth/demo", { method: "POST", body: { token } }),
  signOut: () => call<{ ok: true }>("/auth/logout", { method: "POST" }),
  me: () => call<Principal>("/v1/me"),
  ontology: () => call<Ontology>("/v1/ontology"),
  pull: (after: number) => call<{ principal: Principal; delta: Delta }>(`/v1/pull?after=${after}`),
  ask: (question: string, options: { from?: string; save?: boolean; scope?: string } = {}) =>
    call<Answer>("/v1/ask", { method: "POST", body: { question, ...options } }),
  // A node as the API has it now, with the version an edit must name.
  node: async (id: string) => {
    const response = await send(node(id));
    return { node: (await response.json()) as Node, version: response.headers.get("etag") ?? "" };
  },
  // `version` is the ETag of the page edited, or null for a new page.
  savePage: async (id: string, draft: PageDraft, version: string | null) => {
    const headers: Record<string, string> = version === null ? { "if-none-match": "*" } : { "if-match": version };
    const response = await send(`/v1/pages/${encodeURIComponent(id)}`, { method: "PUT", body: draft, headers });
    return { node: ((await response.json()) as { node: Node }).node, version: response.headers.get("etag") ?? "" };
  },
  repositories: () => call<{ repositories: string[] }>("/v1/history"),
  commits: (repo: string) => call<{ nodes: Node[] }>(`/v1/history/commits?${query({ repo })}`),
  graphAt: (repo: string, sha: string) => call<PastGraph>(`/v1/history/graph?${query({ repo, sha })}`),
  impact: (repo: string, base: string, head: string) => call<ImpactView>(`/v1/history/impact?${query({ repo, base, head })}`),
  planDeletion: (id: string) => call<DeletionPlan>(`${node(id)}/deletion`),
  deleteNode: (id: string, digest: string) => call<DeletionPlan>(`${node(id)}?confirm=${encodeURIComponent(digest)}`, { method: "DELETE" }),
};
