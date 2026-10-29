import { z } from "zod";
import { EdgeTypeSchema, type Node } from "./ontology.js";
import type { Principal } from "./scope.js";
import type { GraphStore } from "./store.js";
import { traverse, type TraversalOptions } from "./traversal.js";

// Audit of reads made on behalf of a user (proposal 0003). Every read goes through a `Reader`,
// which records who asked for what and which nodes they got before handing the result over: if the
// entry cannot be written, the read fails. Entries name only nodes the principal could read, but
// together they say who saw what, so the log is itself sensitive and is never exposed through the
// graph.

export const AuditEntrySchema = z
  .object({
    at: z.iso.datetime(),
    principal: z.object({ user: z.string().min(1), teams: z.array(z.string().min(1)).readonly() }).readonly(),
    action: z.literal("traverse"),
    start: z.string().min(1),
    options: z
      .object({
        direction: z.enum(["out", "in", "both"]).optional(),
        edgeTypes: z.array(EdgeTypeSchema).readonly().optional(),
        maxDepth: z.number().int().nonnegative().optional(),
      })
      .readonly(),
    returned: z.array(z.string().min(1)).readonly(),
  })
  .readonly();

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// Port for the audit log. Append-only: there is no way to change or remove an entry.
export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  // Oldest first, optionally for one user only.
  entries(filter?: { readonly user?: string }): Promise<readonly AuditEntry[]>;
}

export interface Reader {
  traverse(principal: Principal, start: string, options?: TraversalOptions): Promise<readonly Node[]>;
}

export function createReader(store: GraphStore, audit: AuditLog, now: () => Date = () => new Date()): Reader {
  return {
    async traverse(principal, start, options = {}) {
      const reached = traverse(await store.snapshot(), principal, start, options);
      await audit.append(
        AuditEntrySchema.parse({
          at: now().toISOString(),
          principal: { user: principal.user, teams: [...principal.teams] },
          action: "traverse",
          start,
          // An unbounded depth is recorded as no depth at all, since Infinity has no JSON form.
          options: options.maxDepth === Infinity ? { ...options, maxDepth: undefined } : options,
          returned: reached.map((node) => node.id),
        }),
      );
      return reached;
    },
  };
}
