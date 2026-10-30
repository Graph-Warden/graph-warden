import type { Delta, Edge, Node, Principal } from "@graph-warden/core";

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

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(method === "GET" ? {} : { "x-requested-with": "gwarden" }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}) as { error?: string; detail?: string });
    throw new HttpError(response.status, detail.detail ?? detail.error ?? response.statusText);
  }
  return response.json() as Promise<T>;
}

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

export const api = {
  config: () => call<{ login: "demo" | "oidc" }>("/auth/config"),
  signInDemo: (token: string) => call<Principal>("/auth/demo", { method: "POST", body: { token } }),
  signOut: () => call<{ ok: true }>("/auth/logout", { method: "POST" }),
  me: () => call<Principal>("/v1/me"),
  pull: (after: number) => call<{ principal: Principal; delta: Delta }>(`/v1/pull?after=${after}`),
  ask: (question: string, options: { from?: string; save?: boolean; scope?: string } = {}) =>
    call<Answer>("/v1/ask", { method: "POST", body: { question, ...options } }),
  planDeletion: (id: string) => call<DeletionPlan>(`/v1/nodes/${encodeURIComponent(id)}/deletion`),
  deleteNode: (id: string, digest: string) =>
    call<DeletionPlan>(`/v1/nodes/${encodeURIComponent(id)}?confirm=${encodeURIComponent(digest)}`, { method: "DELETE" }),
};
