import { createGraph, type AuditEntry, type AuditLog, type Edge, type EventLog, type GraphEvent, type GraphStore, type Node } from "@graph-warden/core";

// In-memory ports, for tests and demos: nothing survives the process.

export function createMemoryStore(): GraphStore {
  const nodes = new Map<string, Node>();
  let edges: Edge[] = [];
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
        (event) => event.seq <= upTo && (event.kind === "edge-upserted" ? event.edge.from === id || event.edge.to === id : event.id === id),
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
