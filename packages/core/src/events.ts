import { z } from "zod";
import { checkOntology, CORE_ONTOLOGY, EdgeSchema, NodeSchema, type Edge, type Node, type Ontology } from "./ontology.js";
import { narrowed } from "./derivation.js";
import { canRead, ScopeSchema, type Principal } from "./scope.js";
import type { GraphStore } from "./store.js";
import type { Graph } from "./traversal.js";

// The event log (proposal 0006): every write to the graph appends an event with a monotonic
// sequence number. It is the basis of `gwarden pull`, which fetches what changed since a cursor.
//
// A delta is computed from the graph as it is now, never by replaying old events: a node that was
// shared once and is confidential now must not reach a reader through its history. The log only
// says which nodes were touched after the cursor, and what scope each node had at the cursor, so
// that a removal is sent only to a reader who could see the node then. A client therefore never
// receives the id of a node it may not see, deletions included.

const SeqSchema = z.number().int().positive();

export const GraphEventSchema = z.discriminatedUnion("kind", [
  z.object({ seq: SeqSchema, kind: z.literal("node-upserted"), id: z.string().min(1), scope: ScopeSchema }).readonly(),
  z.object({ seq: SeqSchema, kind: z.literal("node-deleted"), id: z.string().min(1) }).readonly(),
  z.object({ seq: SeqSchema, kind: z.literal("edge-upserted"), edge: EdgeSchema }).readonly(),
  z.object({ seq: SeqSchema, kind: z.literal("edge-deleted"), edge: EdgeSchema }).readonly(),
]);

export type GraphEvent = z.infer<typeof GraphEventSchema>;

type Unsequenced<T> = T extends unknown ? Omit<T, "seq"> : never;
export type NewGraphEvent = Unsequenced<GraphEvent>;

// Port for the event log. Append-only; `append` numbers the events in order, after every event
// already in the log.
export interface EventLog {
  append(events: readonly NewGraphEvent[]): Promise<void>;
  // Events with a sequence number above `after`, oldest first.
  since(after: number): Promise<readonly GraphEvent[]>;
  // Events up to and including `upTo`, for one node: what the log knew of it at that cursor.
  history(id: string, upTo: number): Promise<readonly GraphEvent[]>;
}

// Writes go through here so that the graph and the log never disagree on what happened. The log is
// written after the store: a crash in between leaves a write without an event, which the next write
// to the same node repairs, rather than an event for a write that never happened. It is also where
// the ontology is enforced: a node or edge of a type it does not have is refused (`OutsideOntology`).
export interface Writer {
  readonly ontology: Ontology;
  // A node that holds sources with no edge to them keeps them and never widens, whoever writes it:
  // ingesting a document again rewrites it from a file that knows nothing of them. A node of an
  // erased source is refused (`SourceErased`).
  upsertNodes(nodes: readonly Node[]): Promise<void>;
  // Writes the nodes as given, dropping what they held. Only erasure may: it wrote their text again.
  replaceNodes(nodes: readonly Node[]): Promise<void>;
  upsertEdges(edges: readonly Edge[]): Promise<void>;
  deleteNode(id: string): Promise<void>;
  deleteEdges(edges: readonly Edge[]): Promise<void>;
}

export interface WriterOptions {
  readonly ontology?: Ontology;
}

export class SourceErased extends Error {
  override readonly name = "SourceErased";
}

export function createWriter(store: GraphStore, log: EventLog, options: WriterOptions = {}): Writer {
  const { ontology = CORE_ONTOLOGY } = options;
  const write = async (nodes: readonly Node[]) => {
    const parsed = nodes.map((node) => NodeSchema.parse(node));
    checkOntology(ontology, parsed);
    await store.upsertNodes(parsed);
    await log.append(parsed.map((node) => ({ kind: "node-upserted", id: node.id, scope: node.scope })));
  };
  return {
    ontology,
    async upsertNodes(nodes) {
      if (nodes.length === 0) return;
      const erased = await store.erasedSources();
      const refused = nodes.find((node) => erased.has(node.provenance.source));
      if (refused !== undefined) throw new SourceErased(`${refused.provenance.source} was erased: readmit it once it no longer holds what was erased`);
      const current = (await store.snapshot()).nodes;
      await write(nodes.map((node) => keepHeld(node, current.get(node.id))));
    },
    replaceNodes: write,
    async upsertEdges(edges) {
      const parsed = edges.map((edge) => EdgeSchema.parse(edge));
      checkOntology(ontology, [], parsed);
      await store.upsertEdges(parsed);
      await log.append(parsed.map((edge) => ({ kind: "edge-upserted", edge })));
    },
    async deleteNode(id) {
      await store.deleteNode(id);
      await log.append([{ kind: "node-deleted", id }]);
    },
    async deleteEdges(edges) {
      const parsed = edges.map((edge) => EdgeSchema.parse(edge));
      await store.deleteEdges(parsed);
      await log.append(parsed.map((edge) => ({ kind: "edge-deleted", edge })));
    },
  };
}

function keepHeld(node: Node, current: Node | undefined): Node {
  if (current?.heldSources === undefined) return node;
  const heldSources = [...new Set([...current.heldSources, ...(node.heldSources ?? [])])].sort();
  return { ...node, scope: narrowed(current.scope, [node.scope]), heldSources };
}

export const DeltaSchema = z
  .object({
    // The cursor to send next time.
    cursor: z.number().int().nonnegative(),
    nodes: z.array(NodeSchema).readonly(),
    edges: z.array(EdgeSchema).readonly(),
    // Nodes the client may have and must drop: deleted, or no longer readable.
    removed: z.array(z.string().min(1)).readonly(),
  })
  .readonly();

export type Delta = z.infer<typeof DeltaSchema>;

// What the API answers to a pull: the delta, and the principal it was computed for, so that a
// client can tell when its groups changed and its cache must start over.
export const PullResponseSchema = z
  .object({
    principal: z.object({ user: z.string().min(1), teams: z.array(z.string().min(1)).readonly() }).readonly(),
    delta: DeltaSchema,
  })
  .readonly();

export type PullResponse = z.infer<typeof PullResponseSchema>;

// What a principal must apply to a cache that is up to date at `after` to be up to date now.
export async function computeDelta(graph: Graph, log: EventLog, principal: Principal, after: number): Promise<Delta> {
  const events = await log.since(after);
  const touched = new Set<string>();
  for (const event of events) {
    if (event.kind === "edge-upserted" || event.kind === "edge-deleted") {
      touched.add(event.edge.from);
      touched.add(event.edge.to);
    } else {
      touched.add(event.id);
    }
  }

  const readable = (id: string): Node | undefined => {
    const node = graph.nodes.get(id);
    return node !== undefined && canRead(principal, node.scope) ? node : undefined;
  };

  const nodes: Node[] = [];
  const removed: string[] = [];
  for (const id of touched) {
    const node = readable(id);
    if (node !== undefined) nodes.push(node);
    else if (await readableAt(log, principal, id, after)) removed.push(id);
  }
  const sent = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => (sent.has(edge.from) || sent.has(edge.to)) && readable(edge.from) && readable(edge.to),
  );
  const last = events.at(-1);
  return { cursor: last === undefined ? after : last.seq, nodes, edges, removed };
}

// Whether the node existed and was readable by the principal at the cursor, so that a client up to
// date at that cursor holds it.
async function readableAt(log: EventLog, principal: Principal, id: string, cursor: number): Promise<boolean> {
  if (cursor === 0) return false;
  const last = (await log.history(id, cursor)).filter((event) => event.kind === "node-upserted" || event.kind === "node-deleted").at(-1);
  return last?.kind === "node-upserted" && canRead(principal, last.scope);
}
