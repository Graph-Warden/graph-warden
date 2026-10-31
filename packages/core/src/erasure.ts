import { contentSources } from "./derivation.js";
import { createHash } from "node:crypto";
import { recorder, type AuditLog } from "./audit.js";
import { ASK_SYSTEM, type LLMProvider } from "./ask.js";
import type { Writer } from "./events.js";
import type { IngestionState } from "./ingestion.js";
import type { Edge, Node } from "./ontology.js";
import type { StaleMarks } from "./revalidation.js";
import type { Principal } from "./scope.js";
import type { GraphStore } from "./store.js";
import type { Graph } from "./traversal.js";

// Erasure of a source (`gwarden forget`, issue #17): every node it gave, and everything that
// carries its content. Deletion of one node (proposal 0011) lets a node derived from it and from
// others keep its text; erasure cannot, since that text was written from the source. Such a node
// is either deleted, or, when a model is available, recompiled: written again from its remaining
// sources only. The model never sees its former text.
//
// Afterwards no node holds content from the source: neither its own nodes, nor derived ones, nor
// nodes the worker marked stale with a change of the source as evidence. Pulls send the deleted
// ids as removed and the recompiled nodes anew, so caches drop the content on their next pull.
// The event log and the audit log keep the ids, never text: removals must reach the caches, and
// the erasure itself must stay accountable.
//
// Erasure is an operator's act (the DPO's), made on the store like ingestion, shown then confirmed
// with a digest like a deletion, and audited.

export interface ErasurePlan {
  readonly source: string;
  // Nodes removed: the source's own, then derived nodes left without a source, and, without a
  // model, derived nodes that lose a source.
  readonly deleted: readonly Node[];
  // Derived nodes that keep other sources and are written again from them.
  readonly recompiled: readonly Node[];
  // `DERIVED_FROM` edges from recompiled nodes to deleted ones.
  readonly detached: readonly Edge[];
  readonly digest: string;
}

export function planErasure(graph: Graph, source: string, recompile: boolean): ErasurePlan {
  const sourcesOf = (id: string) => graph.edges.filter((e) => e.type === "DERIVED_FROM" && e.from === id);
  const deleted = new Set([...graph.nodes.values()].filter((node) => node.provenance.source === source).map((node) => node.id));
  // A node can hold the source with no edge to it left: a plain deletion keeps the text.
  const holds = (id: string) => graph.nodes.get(id)?.heldSources?.includes(source) === true;
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of graph.nodes.keys()) {
      if (deleted.has(id)) continue;
      const sources = sourcesOf(id);
      const lost = sources.filter((e) => deleted.has(e.to));
      const carries = lost.length > 0 || holds(id);
      // Every source gone; or one gone and nothing to recompile with.
      if (carries && (lost.length === sources.length || !recompile)) {
        deleted.add(id);
        changed = true;
      }
    }
  }
  const detached = graph.edges.filter((e) => e.type === "DERIVED_FROM" && !deleted.has(e.from) && deleted.has(e.to));
  const holding = [...graph.nodes.keys()].filter((id) => holds(id) && !deleted.has(id));
  const recompiled = [...new Set([...detached.map((e) => e.from), ...holding])].map((id) => graph.nodes.get(id)).filter((n): n is Node => n !== undefined);
  const nodes = [...deleted].map((id) => graph.nodes.get(id)).filter((n): n is Node => n !== undefined);
  const digest = createHash("sha256")
    .update(JSON.stringify({ source, deleted: [...deleted].sort(), recompiled: recompiled.map((n) => n.id).sort() }))
    .digest("hex")
    .slice(0, 16);
  return { source, deleted: nodes, recompiled, detached, digest };
}

function withoutHeldSources(node: Node): Node {
  const copy = { ...node };
  delete (copy as { heldSources?: unknown }).heldSources;
  return copy;
}

export interface Eraser {
  plan(principal: Principal, source: string): Promise<ErasurePlan>;
  // Rejects with `Conflict` when the graph changed since the plan with this digest was made.
  forget(principal: Principal, source: string, digest: string): Promise<ErasurePlan>;
}

export interface EraserOptions {
  // Recompiles derived nodes that keep other sources; without it they are deleted.
  readonly llm?: LLMProvider;
  readonly marks?: StaleMarks;
  readonly state?: IngestionState;
  readonly now?: () => Date;
}

export class ErasureConflict extends Error {
  override readonly name = "ErasureConflict";
}

const RECOMPILE = `${ASK_SYSTEM}
You are asked to write a document of the knowledge graph again, from the given documents only, because one of its former sources was erased. Write the whole document under the given title, from these documents and nothing else.`;

export function createEraser(store: GraphStore, writer: Writer, audit: AuditLog, options: EraserOptions = {}): Eraser {
  const { llm, marks, state, now } = options;
  const record = recorder(audit, now);
  const plan = async (source: string) => planErasure(await store.snapshot(), source, llm !== undefined);

  return {
    async plan(principal, source) {
      const result = await plan(source);
      await record({ action: "forget", source, planned: true, returned: result.deleted.map((n) => n.id), recompiled: result.recompiled.map((n) => n.id) }, principal);
      return result;
    },

    async forget(principal, source, digest) {
      const result = await plan(source);
      if (result.digest !== digest) throw new ErasureConflict(`The graph changed since the erasure of ${source} was shown`);
      // Recorded before the writes: an erasure that cannot be audited does not happen.
      await record({ action: "forget", source, returned: result.deleted.map((n) => n.id), recompiled: result.recompiled.map((n) => n.id) }, principal);

      const graph = await store.snapshot();
      const gone = new Set(result.deleted.map((n) => n.id));
      // Written before anything is removed, so that a failure leaves the source whole rather than
      // a node holding text from a source already half gone.
      const rewritten: Node[] = [];
      for (const node of result.recompiled) {
        const remaining = graph.edges
          .filter((e) => e.type === "DERIVED_FROM" && e.from === node.id && !gone.has(e.to))
          .map((e) => graph.nodes.get(e.to))
          .filter((n): n is Node => n !== undefined);
        const body = await (llm as LLMProvider).complete({
          system: RECOMPILE,
          prompt: recompilePrompt(node, remaining),
          // The title is the node's own.
          sources: contentSources(graph, [node, ...remaining]),
          principal,
        });
        // Written from its remaining sources only: what it held without an edge is gone.
        rewritten.push(withoutHeldSources({ ...node, body }));
      }
      await writer.replaceNodes(rewritten);
      await writer.deleteEdges(result.detached);
      for (const node of result.deleted) await writer.deleteNode(node.id);
      if (marks !== undefined) {
        for (const id of [...gone, ...result.recompiled.map((n) => n.id)]) await marks.clear(id);
        await marks.clearSource(source);
      }
      await state?.forget(source);
      return result;
    },
  };
}

// The node's title and its remaining sources: never its former text.
function recompilePrompt(node: Node, sources: readonly Node[]): string {
  const documents = sources
    .map((s) => `<document id="${s.id}" type="${s.type}"${s.title === undefined ? "" : ` title="${s.title.replace(/"/g, "'")}"`}>\n${s.body ?? "(no text)"}\n</document>`)
    .join("\n\n");
  return `${documents}\n\nWrite the document "${(node.title ?? node.id).replace(/"/g, "'")}" again from these documents only.`;
}
