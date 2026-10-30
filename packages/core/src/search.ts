import type { Node } from "./ontology.js";
import { canRead, type Principal } from "./scope.js";
import { traverse, type Graph } from "./traversal.js";

// Lexical retrieval over the nodes a principal may read, for `search` and `ask` (proposal 0011).
// Unreadable nodes are dropped before anything is scored, so nothing about them reaches a result.

export interface RetrieveOptions {
  // Anchor on a node: it and its readable neighbours come first.
  readonly from?: string;
  // Most nodes returned.
  readonly limit?: number;
}

const STOPWORDS = new Set(["the", "and", "for", "with", "what", "who", "how", "why", "which", "does", "are", "this", "that", "from"]);
const terms = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOPWORDS.has(t)));
const occurrences = (text: string, word: string) => text.split(word).length - 1;

// The readable nodes most related to the query, best first: the anchor and its neighbours, then
// nodes by how often the query's words appear in their id, title (counting triple) and text.
export function retrieve(graph: Graph, principal: Principal, query: string, options: RetrieveOptions = {}): readonly Node[] {
  const { from, limit = 8 } = options;
  const anchored: Node[] = [];
  const start = from === undefined ? undefined : graph.nodes.get(from);
  if (start !== undefined && canRead(principal, start.scope)) {
    anchored.push(start, ...traverse(graph, principal, start.id, { direction: "both", maxDepth: 1 }));
  }
  const words = terms(query);
  const scored = [...graph.nodes.values()]
    .filter((node) => canRead(principal, node.scope))
    .map((node) => {
      const name = `${node.id.replace(/[-_]/g, " ")} ${node.title ?? ""}`.toLowerCase();
      const body = (node.body ?? "").toLowerCase();
      let score = 0;
      for (const word of words) score += 3 * occurrences(name, word) + occurrences(body, word);
      return { node, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
    .map(({ node }) => node);
  const picked = new Map<string, Node>();
  for (const node of [...anchored, ...scored]) if (picked.size < limit) picked.set(node.id, node);
  return [...picked.values()];
}
