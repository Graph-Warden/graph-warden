import { createHash } from "node:crypto";
import { contentSources } from "./derivation.js";
import type { Edge, Node } from "./ontology.js";
import { canRead, type Principal } from "./scope.js";
import type { Graph } from "./traversal.js";

// What deleting a node does to what was derived from it (proposal 0011). Deleting a node never
// deletes the nodes it points to, nor the nodes that merely reference it. Only `DERIVED_FROM`
// propagates:
// - a node derived from the deleted one and from others keeps its other sources and loses only
//   its edge to the deleted one;
// - a node whose every source is deleted is deleted too, and so on down the chain.
// A node that loses a source keeps its scope: its text was written from that source too, and
// widening the scope to its remaining sources would show that text to people who could never read
// the deleted one. For the same reason it keeps the source's sensitivity: the edge is gone but the
// text is not, so the sources it held are written on the node (`heldSources`).

export interface DeletionPlan {
  // The node asked for.
  readonly target: Node;
  // Every node removed, the target first, then the derived nodes left without a source.
  readonly deleted: readonly Node[];
  // `DERIVED_FROM` edges removed from nodes that survive because they have other sources.
  readonly detached: readonly Edge[];
  // The nodes that lose an edge, recording the sources their text keeps from it.
  readonly marked: readonly Node[];
  // Fingerprint of the plan. A deletion carries the digest of the plan its user confirmed, and is
  // refused if the graph changed since, so a confirmation never covers more than was shown.
  readonly digest: string;
}

// Raised when the node is unknown or unreadable: the two are indistinguishable to the caller.
export class NotFound extends Error {
  override readonly name = "NotFound";
}

// Raised when a deletion would touch a node the principal may not read. The message names no node:
// the caller learns only that the deletion reaches beyond what they see.
export class Unreachable extends Error {
  override readonly name = "Unreachable";
}

export function planDeletion(graph: Graph, principal: Principal, id: string): DeletionPlan {
  const target = graph.nodes.get(id);
  if (target === undefined || !canRead(principal, target.scope)) throw new NotFound(`No node ${id}`);

  const sourcesOf = (node: string) => graph.edges.filter((e) => e.type === "DERIVED_FROM" && e.from === node);
  const deleted = new Set([id]);
  // Fixed point: deleting a node can orphan a node derived from it, which can orphan another.
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of graph.nodes.keys()) {
      if (deleted.has(node)) continue;
      const sources = sourcesOf(node);
      if (sources.length > 0 && sources.every((e) => deleted.has(e.to))) {
        deleted.add(node);
        changed = true;
      }
    }
  }
  const detached = graph.edges.filter((e) => e.type === "DERIVED_FROM" && !deleted.has(e.from) && deleted.has(e.to));

  const touched = [...deleted, ...detached.map((e) => e.from)];
  if (touched.some((node) => !canRead(principal, graph.nodes.get(node)?.scope ?? { kind: "shared" }))) {
    throw new Unreachable(`Deleting ${id} would change nodes ${principal.user} may not read`);
  }

  const nodes = [...deleted].map((node) => graph.nodes.get(node)).filter((node): node is Node => node !== undefined);
  const digest = createHash("sha256")
    .update(JSON.stringify({ deleted: [...deleted].sort(), detached: detached.map((e) => `${e.from}>${e.to}`).sort() }))
    .digest("hex")
    .slice(0, 16);
  const marked = [...new Set(detached.map((e) => e.from))].flatMap((id) => {
    const node = graph.nodes.get(id);
    if (node === undefined) return [];
    const lost = detached.filter((e) => e.from === id).flatMap((e) => graph.nodes.get(e.to) ?? []);
    return [{ ...node, heldSources: [...new Set([...(node.heldSources ?? []), ...contentSources(graph, lost)])].sort() }];
  });
  return { target, deleted: nodes, detached, marked, digest };
}
