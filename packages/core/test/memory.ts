import { createMemoryStore } from "@graph-warden/memory";
import { type AuditEntry, type AuditLog, type EventLog, type GraphEvent, type GraphStore } from "../src/index.js";

// In-memory ports for the domain tests. The store is `@graph-warden/memory`'s, which vitest resolves
// to its sources (core cannot depend on it outside tests), so that the domain tests also run with
// GWARDEN_TEST_STORE=rdf.

export const memoryStore = (): GraphStore => createMemoryStore();

export function memoryEvents(): EventLog {
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

export function memoryAudit(): AuditLog & { readonly written: AuditEntry[] } {
  const written: AuditEntry[] = [];
  return {
    written,
    append: async (entry) => void written.push(entry),
    entries: async (filter = {}) => written.filter((entry) => filter.user === undefined || entry.principal.user === filter.user),
  };
}
