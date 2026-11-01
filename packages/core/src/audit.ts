import { z } from "zod";
import { EdgeTypeSchema, type Node } from "./ontology.js";
import { canRead, type Principal } from "./scope.js";
import { NotFound } from "./deletion.js";
import { computeDelta, type Delta, type EventLog } from "./events.js";
import { searchGraph, type RetrieveOptions, type TextIndex } from "./search.js";
import type { GraphStore } from "./store.js";
import { findRelated } from "./revalidation.js";
import { createGraph, traverse, type TraversalOptions } from "./traversal.js";

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
  // One node read by id: `returned` is empty when it is unknown or unreadable.
  z.object({ ...common, action: z.literal("read"), target: z.string().min(1) }).readonly(),
  z.object({ ...common, action: z.literal("search"), query: z.string().min(1) }).readonly(),
  // The erasure of a source (issue #17): `returned` lists the nodes deleted, `recompiled` the
  // derived nodes written again without it. `planned` marks a preview.
  z
    .object({
      ...common,
      action: z.literal("forget"),
      source: z.string().min(1),
      recompiled: z.array(z.string().min(1)).readonly(),
      planned: z.literal(true).optional(),
    })
    .readonly(),
  // An erased source let back in: someone answers for it no longer holding what was erased.
  z.object({ ...common, action: z.literal("readmit"), source: z.string().min(1) }).readonly(),
  // A coding-agent session captured, private to its author (issue #27).
  z.object({ ...common, action: z.literal("capture"), target: z.string().min(1) }).readonly(),
  // A session promoted to `scope` after redaction; `planned` marks the preview, `denied` a scope
  // its author could not read.
  z
    .object({
      ...common,
      action: z.literal("promote"),
      target: z.string().min(1),
      scope: z.string().min(1),
      planned: z.literal(true).optional(),
      denied: z.literal(true).optional(),
    })
    .readonly(),
  // Where a request to a model went (issue #28): `sources` are the provenance sources of its
  // content, `confidential` those that kept it local. `denied` when no model could take it.
  z
    .object({
      ...common,
      action: z.literal("route"),
      model: z.enum(["local", "remote"]),
      sources: z.array(z.string().min(1)).readonly(),
      confidential: z.array(z.string().min(1)).readonly(),
      denied: z.literal(true).optional(),
    })
    .readonly(),
  // A repository as it was at a commit (its list of commits without `sha`), and a pull request's
  // impact (issue #16).
  z.object({ ...common, action: z.literal("history"), repo: z.string().min(1), sha: z.string().min(1).optional() }).readonly(),
  z.object({ ...common, action: z.literal("impact"), repo: z.string().min(1), base: z.string().min(1), head: z.string().min(1) }).readonly(),
  // What depends on some nodes (proposal 0005), through readable nodes only.
  z.object({ ...common, action: z.literal("related"), targets: z.array(z.string().min(1)).min(1).readonly() }).readonly(),
  // Reading the audit log is itself recorded: it says who looked at who saw what. So is a refused
  // attempt, marked `denied`.
  z
    .object({ ...common, action: z.literal("audit"), user: z.string().min(1).optional(), denied: z.literal(true).optional() })
    .readonly(),
  // A deletion (proposal 0011): `returned` lists the nodes deleted, `detached` the `DERIVED_FROM`
  // edges removed, as `from>to`. `planned` marks a preview, which deletes nothing; `denied` an
  // attempt refused for want of rights.
  z
    .object({
      ...common,
      action: z.literal("delete"),
      target: z.string().min(1),
      detached: z.array(z.string().min(1)).readonly(),
      planned: z.literal(true).optional(),
      denied: z.literal(true).optional(),
    })
    .readonly(),
  // A question (proposal 0011): `returned` lists every node handed to the model, cited or not;
  // `saved` the answer filed in the graph, if any.
  z
    .object({
      ...common,
      action: z.literal("ask"),
      question: z.string().min(1),
      saved: z.string().min(1).optional(),
      denied: z.literal(true).optional(),
    })
    .readonly(),
  // A wiki page written through the API (proposal 0012): `returned` is the page when it was saved,
  // `created` marks a new one, `denied` an attempt refused for want of rights.
  z
    .object({
      ...common,
      action: z.literal("edit"),
      target: z.string().min(1),
      created: z.literal(true).optional(),
      denied: z.literal(true).optional(),
    })
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
  // One node; rejects with `NotFound` when it is unknown or unreadable, which look alike.
  node(principal: Principal, id: string): Promise<Node>;
  // The readable nodes matching a query, best first.
  search(principal: Principal, query: string, options?: RetrieveOptions): Promise<readonly Node[]>;
  traverse(principal: Principal, start: string, options?: TraversalOptions): Promise<readonly Node[]>;
  // What depends on these nodes (`findRelated`), nearest first, with the distance of each. Only
  // readable nodes are crossed, as in a traversal: an unreadable node hides what lies behind it.
  related(principal: Principal, ids: readonly string[]): Promise<readonly { readonly node: Node; readonly depth: number }[]>;
  // What changed since the cursor, as the principal may see it. Needs an event log.
  pull(principal: Principal, after: number): Promise<Delta>;
  // `pull` for a client that keeps asking (the web app's stream, proposal 0012): undefined while
  // the log has nothing after the cursor, and recorded only when the delta hands the principal
  // something, so that an idle open tab does not fill the audit log.
  changes(principal: Principal, after: number): Promise<Delta | undefined>;
  // The audit log, for members of an auditor group only (`Forbidden` otherwise).
  auditTrail(principal: Principal, filter?: { readonly user?: string }): Promise<readonly AuditEntry[]>;
}

export interface ReaderOptions {
  readonly events?: EventLog;
  // Groups whose members may read the audit log. None by default: nobody reads it through the reader.
  readonly auditors?: readonly string[];
  // Called before a node is read, to revalidate it if it is stale (proposal 0005).
  readonly refresh?: (id: string) => Promise<unknown>;
  // Finds the nodes holding a query's words; every node is read without one.
  readonly index?: TextIndex;
  readonly now?: () => Date;
}

export class Forbidden extends Error {
  override readonly name = "Forbidden";
}

// Appends an entry for the principal, stamped now.
export function recorder(audit: AuditLog, now: () => Date = () => new Date()) {
  return (entry: DistributiveOmit<AuditEntry, "at" | "principal">, principal: Principal): Promise<void> =>
    audit.append(
      AuditEntrySchema.parse({ ...entry, at: now().toISOString(), principal: { user: principal.user, teams: [...principal.teams] } }),
    );
}

export function createReader(store: GraphStore, audit: AuditLog, options: ReaderOptions = {}): Reader {
  const { events, auditors = [], refresh, index, now = () => new Date() } = options;
  const record = recorder(audit, now);

  return {
    async node(principal, id) {
      // Only for a node the principal may read, so that a read cannot spend model calls on, or
      // time how long it takes to answer for, a node it cannot see.
      const current = await store.getNode(id);
      if (refresh !== undefined && current !== undefined && canRead(principal, current.scope)) await refresh(id);
      const node = await store.getNode(id);
      const readable = node !== undefined && canRead(principal, node.scope) ? node : undefined;
      await record({ action: "read", target: id, returned: readable === undefined ? [] : [id] }, principal);
      if (readable === undefined) throw new NotFound(`No node ${id}`);
      return readable;
    },

    async search(principal, query, options = {}) {
      // A search shows what holds the words: links rank what it finds, and bring nothing in.
      const found = await searchGraph(await store.snapshot(), index, principal, query, { ...options, linkable: () => false });
      await record({ action: "search", query, returned: found.map((node) => node.id) }, principal);
      return found;
    },

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

    async related(principal, ids) {
      const graph = await store.snapshot();
      const readable = [...graph.nodes.values()].filter((node) => canRead(principal, node.scope));
      const visible = new Set(readable.map((node) => node.id));
      const subgraph = createGraph(readable, graph.edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)));
      const { depth } = findRelated(subgraph, ids.filter((id) => visible.has(id)));
      const found = [...depth.entries()]
        .map(([id, d]) => ({ node: subgraph.nodes.get(id), depth: d }))
        .filter((entry): entry is { node: Node; depth: number } => entry.node !== undefined)
        .sort((a, b) => a.depth - b.depth || a.node.id.localeCompare(b.node.id));
      await record({ action: "related", targets: [...ids], returned: found.map((entry) => entry.node.id) }, principal);
      return found;
    },

    async pull(principal, after) {
      if (events === undefined) throw new Error("This reader has no event log to pull from");
      const delta = await computeDelta(await store.snapshot(), events, principal, after);
      await record({ action: "pull", after, returned: [...delta.nodes.map((node) => node.id), ...delta.removed] }, principal);
      return delta;
    },

    async changes(principal, after) {
      if (events === undefined) throw new Error("This reader has no event log to pull from");
      if ((await events.since(after)).length === 0) return undefined;
      const delta = await computeDelta(await store.snapshot(), events, principal, after);
      const returned = [...delta.nodes.map((node) => node.id), ...delta.removed];
      if (returned.length > 0) await record({ action: "pull", after, returned }, principal);
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

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
