import { z } from "zod";
import { EdgeTypeSchema, type Node } from "./ontology.js";
import type { Principal } from "./scope.js";
import { computeDelta, type Delta, type EventLog } from "./events.js";
import type { GraphStore } from "./store.js";
import { traverse, type TraversalOptions } from "./traversal.js";

// Audit of reads made on behalf of a user (proposal 0003). Every read goes through a `Reader`
// (traversal, pull, the audit log itself), which records who asked for what and which nodes they
// got before handing the result over: if the entry cannot be written, the read fails. Entries name
// only nodes the principal could read, but together they say who saw what, so the log is itself
// sensitive: it is never exposed through the graph, and only auditor groups read it.

const PrincipalSchema = z
  .object({ user: z.string().min(1), teams: z.array(z.string().min(1)).readonly() })
  .readonly();

const common = {
  at: z.iso.datetime(),
  principal: PrincipalSchema,
  // Ids of the nodes the principal received (for a pull: sent or removed).
  returned: z.array(z.string().min(1)).readonly(),
};

export const AuditEntrySchema = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("traverse"),
      start: z.string().min(1),
      options: z
        .object({
          direction: z.enum(["out", "in", "both"]).optional(),
          edgeTypes: z.array(EdgeTypeSchema).readonly().optional(),
          maxDepth: z.number().int().nonnegative().optional(),
        })
        .readonly(),
    })
    .readonly(),
  z.object({ ...common, action: z.literal("pull"), after: z.number().int().nonnegative() }).readonly(),
  // Reading the audit log is itself recorded: it says who looked at who saw what. So is a refused
  // attempt, marked `denied`.
  z
    .object({ ...common, action: z.literal("audit"), user: z.string().min(1).optional(), denied: z.literal(true).optional() })
    .readonly(),
]);

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// Port for the audit log. Append-only: there is no way to change or remove an entry.
export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  // Oldest first, optionally for one user only.
  entries(filter?: { readonly user?: string }): Promise<readonly AuditEntry[]>;
}

export interface Reader {
  traverse(principal: Principal, start: string, options?: TraversalOptions): Promise<readonly Node[]>;
  // What changed since the cursor, as the principal may see it. Needs an event log.
  pull(principal: Principal, after: number): Promise<Delta>;
  // The audit log, for members of an auditor group only (`Forbidden` otherwise).
  auditTrail(principal: Principal, filter?: { readonly user?: string }): Promise<readonly AuditEntry[]>;
}

export interface ReaderOptions {
  readonly events?: EventLog;
  // Groups whose members may read the audit log. None by default: nobody reads it through the reader.
  readonly auditors?: readonly string[];
  readonly now?: () => Date;
}

export class Forbidden extends Error {
  override readonly name = "Forbidden";
}

export function createReader(store: GraphStore, audit: AuditLog, options: ReaderOptions = {}): Reader {
  const { events, auditors = [], now = () => new Date() } = options;
  const record = (entry: DistributiveOmit<AuditEntry, "at" | "principal">, principal: Principal) =>
    audit.append(
      AuditEntrySchema.parse({ ...entry, at: now().toISOString(), principal: { user: principal.user, teams: [...principal.teams] } }),
    );

  return {
    async traverse(principal, start, traversal = {}) {
      const reached = traverse(await store.snapshot(), principal, start, traversal);
      await record(
        {
          action: "traverse",
          start,
          // An unbounded depth is recorded as no depth at all, since Infinity has no JSON form.
          options: traversal.maxDepth === Infinity ? { ...traversal, maxDepth: undefined } : traversal,
          returned: reached.map((node) => node.id),
        },
        principal,
      );
      return reached;
    },

    async pull(principal, after) {
      if (events === undefined) throw new Error("This reader has no event log to pull from");
      const delta = await computeDelta(await store.snapshot(), events, principal, after);
      await record({ action: "pull", after, returned: [...delta.nodes.map((node) => node.id), ...delta.removed] }, principal);
      return delta;
    },

    async auditTrail(principal, filter = {}) {
      const asked = { action: "audit", ...(filter.user === undefined ? {} : { user: filter.user }), returned: [] } as const;
      if (!auditors.some((group) => principal.teams.includes(group))) {
        await record({ ...asked, denied: true }, principal);
        throw new Forbidden(`${principal.user} is not in an auditor group`);
      }
      const entries = await audit.entries(filter);
      await record(asked, principal);
      return entries;
    },
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
