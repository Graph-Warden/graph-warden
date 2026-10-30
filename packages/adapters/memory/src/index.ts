import {
  createGraph,
  type AuditEntry,
  type AuditLog,
  type Edge,
  type EventLog,
  type GraphEvent,
  type GraphStore,
  type IngestionQueue,
  type IngestionState,
  type Node,
  type StaleMark,
  type StaleMarks,
} from "@graph-warden/core";

// In-memory ports, for tests and demos: nothing survives the process.

// Starts from `initial` when given: a copy, so that writes never reach the graph it came from (a
// dry run over a snapshot of the real store).
export function createMemoryStore(initial?: { readonly nodes: ReadonlyMap<string, Node>; readonly edges: readonly Edge[] }): GraphStore {
  const nodes = new Map<string, Node>(initial?.nodes ?? []);
  let edges: Edge[] = [...(initial?.edges ?? [])];
  const key = (e: Edge) => `${e.type} ${e.from} ${e.to}`;
  return {
    upsertNodes: async (list) => void list.forEach((node) => nodes.set(node.id, node)),
    upsertEdges: async (list) => {
      for (const edge of list) {
        if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new Error("unknown node");
        if (!edges.some((e) => key(e) === key(edge))) edges.push(edge);
      }
    },
    getNode: async (id) => nodes.get(id),
    deleteNode: async (id) => {
      nodes.delete(id);
      edges = edges.filter((e) => e.from !== id && e.to !== id);
    },
    deleteEdges: async (list) => {
      const gone = new Set(list.map(key));
      edges = edges.filter((e) => !gone.has(key(e)));
    },
    snapshot: async () => createGraph([...nodes.values()], edges),
  };
}

export function createMemoryEventLog(): EventLog {
  const events: GraphEvent[] = [];
  return {
    append: async (list) => void list.forEach((event) => events.push({ ...event, seq: events.length + 1 } as GraphEvent)),
    since: async (after) => events.filter((event) => event.seq > after),
    history: async (id, upTo) =>
      events.filter(
        (event) => event.seq <= upTo && ("edge" in event ? event.edge.from === id || event.edge.to === id : event.id === id),
      ),
  };
}

export function createMemoryAuditLog(): AuditLog & { readonly written: AuditEntry[] } {
  const written: AuditEntry[] = [];
  return {
    written,
    append: async (entry) => void written.push(entry),
    entries: async (filter = {}) => written.filter((entry) => filter.user === undefined || entry.principal.user === filter.user),
  };
}

export function createMemoryIngestionState(): IngestionState {
  const last = new Map<string, string>();
  return {
    last: async (repo) => last.get(repo),
    record: async (repo, sha) => void last.set(repo, sha),
    forget: async (repo) => void last.delete(repo),
  };
}

// One process only: jobs of a repository run one at a time, in this process.
export function createMemoryQueue(): IngestionQueue {
  const pending = new Map<string, Set<string>>();
  const running = new Map<string, Promise<void>>();
  let handler: ((repo: string, sha: string) => Promise<void>) | undefined;
  let report: (error: unknown, repo: string, sha: string) => void = () => {};

  // Tries every pending job once; a job that fails stays pending until the next drain.
  const drain = (repo: string): void => {
    const handle = handler;
    if (handle === undefined || running.has(repo)) return;
    const jobs = pending.get(repo) ?? new Set<string>();
    const tried = new Set<string>();
    const untried = () => [...jobs].find((sha) => !tried.has(sha));
    const run = (async () => {
      for (let sha = untried(); sha !== undefined; sha = untried()) {
        tried.add(sha);
        try {
          await handle(repo, sha);
          jobs.delete(sha);
        } catch (error) {
          report(error, repo, sha);
        }
      }
    })().finally(() => {
      running.delete(repo);
      // A job enqueued after the last check, while the drain was finishing.
      if (untried() !== undefined) drain(repo);
    });
    running.set(repo, run);
  };

  return {
    async enqueue(repo, sha) {
      pending.set(repo, (pending.get(repo) ?? new Set()).add(sha));
      drain(repo);
    },
    async start(handle, onError) {
      handler = handle;
      if (onError !== undefined) report = onError;
      for (const repo of pending.keys()) drain(repo);
      return {
        async stop() {
          handler = undefined;
          await Promise.all(running.values());
        },
      };
    },
  };
}

export function createMemoryStaleMarks(): StaleMarks {
  const marks = new Map<string, StaleMark>();
  return {
    mark: async (list) => void list.forEach((mark) => marks.set(mark.id, mark)),
    get: async (id) => marks.get(id),
    clear: async (id) => void marks.delete(id),
    clearSource: async (source) => {
      for (const [id, mark] of marks) if (mark.change.startsWith(`${source}@`)) marks.delete(id);
    },
  };
}
