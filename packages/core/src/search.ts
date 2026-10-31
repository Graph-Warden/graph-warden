import type { Node } from "./ontology.js";
import { canRead, type Principal } from "./scope.js";
import type { GraphStore } from "./store.js";
import { createGraph, traverse, type Graph } from "./traversal.js";

// Retrieval over the nodes a principal may read, for `search` and `ask` (proposals 0011 and 0013).
//
// Everything below works on the readable part of the graph, cut once at the top of `retrieve`: word
// statistics, links and the cut at the limit all come after it. So an unreadable node changes
// nothing, order included. A word count taken over the whole graph would let a reader work out what
// the hidden documents say by watching their own results move.

export interface RetrieveOptions {
  // Anchor on a node: it and its readable neighbours come first.
  readonly from?: string;
  // Most nodes returned.
  readonly limit?: number;
}

// Port for full-text search. It answers one question: which nodes hold one of these terms. It does
// not rank and it does not cut, because either would interfere: an index's scores count the words
// of every document, and a limit applied before the scopes lets hidden documents push readable ones
// out. It does not filter by scope either: the domain does, as for every other read (proposal 0003).
export interface TextIndex {
  // Every node holding at least one term, from `textTerms`, readable or not. Ids unknown to the
  // graph are ignored.
  matching(terms: readonly string[]): Promise<ReadonlySet<string>>;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "what", "who", "how", "why", "which", "does", "are", "this", "that", "from", "did", "was", "were", "has", "have", "not", "but", "its", "when", "where",
  "les", "des", "une", "qui", "que", "quoi", "comment", "pourquoi", "quel", "quelle", "dans", "pour", "sur", "par", "avec", "est", "sont", "cette", "ces", "aux", "apres", "avant",
]);

// Long enough to tell words apart, short enough to meet the forms of one word across English and
// French (`paginated`, `pagination`, `paginer`). An approximation, measured by the retrieval set.
const STEM = 5;

const normalise = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

const tokens = (text: string): string[] => (normalise(text).match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !STOPWORDS.has(word)).map((word) => word.slice(0, STEM));

// The terms of a text, repeated as they occur. What a `TextIndex` indexes.
export const textTerms = (text: string): string[] => tokens(text);

export const queryTerms = (query: string): string[] => [...new Set(tokens(query))];

const nameOf = (node: Node) => `${node.id} ${node.title ?? ""}`;

// All the terms of a node, once each. What an adapter stores for its index.
export const nodeTerms = (node: Node): string[] => [...new Set(tokens(`${nameOf(node)} ${node.body ?? ""}`))];

function readablePart(graph: Graph, principal: Principal): Graph {
  const nodes = [...graph.nodes.values()].filter((node) => canRead(principal, node.scope));
  const kept = new Set(nodes.map((node) => node.id));
  return createGraph(nodes, graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)));
}

const NAME_WEIGHT = 3;
const K1 = 1.2;
const B = 0.75;

const counts = (terms: readonly string[]) => {
  const count = new Map<string, number>();
  for (const term of terms) count.set(term, (count.get(term) ?? 0) + 1);
  return count;
};

// BM25, with the words of a name counting more. `size` is the number of readable nodes.
function lexicalScores(matches: readonly Node[], words: readonly string[], size: number): Map<string, number> {
  const documents = matches.map((node) => {
    const name = counts(tokens(nameOf(node)));
    const body = counts(tokens(node.body ?? ""));
    const length = [...name.values()].reduce((sum, n) => sum + NAME_WEIGHT * n, 0) + [...body.values()].reduce((sum, n) => sum + n, 0);
    return { id: node.id, name, body, length };
  });
  const average = documents.reduce((sum, d) => sum + d.length, 0) / Math.max(documents.length, 1);
  const scores = new Map<string, number>();
  for (const word of words) {
    const holding = documents.filter((d) => d.name.has(word) || d.body.has(word));
    const idf = Math.log(1 + (size - holding.length + 0.5) / (holding.length + 0.5));
    for (const d of holding) {
      const frequency = NAME_WEIGHT * (d.name.get(word) ?? 0) + (d.body.get(word) ?? 0);
      const score = (idf * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * d.length) / average));
      scores.set(d.id, (scores.get(d.id) ?? 0) + score);
    }
  }
  return scores;
}

// How much of a node's score stays with it at each step of the walk, and how many links it may
// cross. Few steps: past two links, a node has little to do with the question.
const RESTART = 0.5;
const STEPS = 2;
// A node reached over links must weigh this share of the best node to be kept.
const KEPT_SHARE = 0.1;

// A walk over the links from the nodes that match, with the links read both ways: an incident and
// the release that caused it answer the same questions whichever way the edge points. It starts
// from the lexical scores, so a match stays above what it only links to.
function propagate(graph: Graph, seeds: ReadonlyMap<string, number>): Map<string, number> {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
  for (const { from, to } of graph.edges) {
    if (from === to) continue;
    link(from, to);
    link(to, from);
  }
  // In a fixed order: sums of floats depend on it, and a store's order must not move a tie.
  const sorted = (entries: Iterable<[string, number]>) => [...entries].sort(([a], [b]) => a.localeCompare(b));
  let scores = new Map(seeds);
  for (let step = 0; step < STEPS; step++) {
    const next = new Map<string, number>();
    const add = (id: string, value: number) => next.set(id, (next.get(id) ?? 0) + value);
    for (const [id, value] of sorted(seeds)) add(id, RESTART * value);
    for (const [id, value] of sorted(scores)) {
      const around = [...(neighbours.get(id) ?? [])].sort();
      if (around.length === 0) add(id, (1 - RESTART) * value);
      for (const neighbour of around) add(neighbour, ((1 - RESTART) * value) / around.length);
    }
    scores = next;
  }
  return scores;
}

export interface RankOptions extends RetrieveOptions {
  // Whether a node holding none of the query's words may come in over a link. All may by default.
  readonly linkable?: (node: Node) => boolean;
}

// The readable nodes most related to the query, best first: the anchor and its neighbours, then
// nodes by their words and by their links to the nodes holding those words. With `candidates`, from
// a `TextIndex`, only these are read for words; left out, every readable node is.
export function retrieve(graph: Graph, principal: Principal, query: string, options: RankOptions & { readonly candidates?: ReadonlySet<string> } = {}): readonly Node[] {
  const { from, limit = 8, candidates, linkable = () => true } = options;
  const view = readablePart(graph, principal);
  const start = from === undefined ? undefined : view.nodes.get(from);
  // By id: the order of a node's edges is the store's, and a limit would make it matter.
  const around = start === undefined ? [] : [...traverse(view, principal, start.id, { direction: "both", maxDepth: 1 })].sort((a, b) => a.id.localeCompare(b.id));
  const anchored = start === undefined ? [] : [start, ...around];

  const words = queryTerms(query);
  const held = new Set(words);
  const matches = (candidates === undefined ? [...view.nodes.values()] : [...candidates].flatMap((id) => view.nodes.get(id) ?? [])).filter((node) =>
    tokens(`${nameOf(node)} ${node.body ?? ""}`).some((term) => held.has(term)),
  );
  const seeds = lexicalScores(matches, words, view.nodes.size);
  const scores = propagate(view, seeds);
  const best = Math.max(0, ...scores.values());
  const ranked = [...scores.entries()]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .flatMap(([id, score]) => {
      const node = view.nodes.get(id);
      return node !== undefined && (seeds.has(id) || (score >= KEPT_SHARE * best && linkable(node))) ? [node] : [];
    });

  const picked = new Map<string, Node>();
  for (const node of [...anchored, ...ranked]) if (picked.size < limit) picked.set(node.id, node);
  return [...picked.values()];
}

// `retrieve` through an index.
export async function searchGraph(graph: Graph, index: TextIndex | undefined, principal: Principal, query: string, options: RankOptions = {}): Promise<readonly Node[]> {
  const candidates = index === undefined ? undefined : await index.matching(queryTerms(query));
  return retrieve(graph, principal, query, { ...options, ...(candidates === undefined ? {} : { candidates }) });
}

// The index every store has: reads the whole graph. For a store without a better one.
export function scanIndex(store: GraphStore): TextIndex {
  return {
    async matching(terms) {
      const wanted = new Set(terms);
      const { nodes } = await store.snapshot();
      return new Set([...nodes.values()].filter((node) => nodeTerms(node).some((term) => wanted.has(term))).map((node) => node.id));
    },
  };
}

// Tokens are about four characters of English or French.
const CHARS_PER_TOKEN = 4;
// Below this, an excerpt says nothing: the remaining nodes are dropped.
const SMALLEST_EXCERPT = 40;
const ELISION = " […] ";

const cost = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

// The sentences of a body that hold most of the query's words, in their order, within `allowance`.
function excerpt(body: string, words: ReadonlySet<string>, allowance: number): string {
  const sentences = body.split(/(?<=[.!?])\s+|\n{2,}/).filter((sentence) => sentence.trim().length > 0);
  const scored = sentences.map((sentence, at) => ({ at, sentence, hits: new Set(tokens(sentence).filter((term) => words.has(term))).size }));
  const kept: typeof scored = [];
  let left = allowance - cost(ELISION);
  for (const candidate of [...scored].sort((a, b) => b.hits - a.hits || a.at - b.at)) {
    const price = cost(candidate.sentence) + cost(ELISION);
    if (price <= left) {
      kept.push(candidate);
      left -= price;
    }
  }
  if (kept.length === 0) return `${body.slice(0, Math.max(0, (allowance - cost(ELISION)) * CHARS_PER_TOKEN))}${ELISION.trimEnd()}`;
  return `${kept.sort((a, b) => a.at - b.at).map((k) => k.sentence).join(ELISION)}${ELISION.trimEnd()}`;
}

// Fits ranked nodes in `budget` tokens of text: the best first, whole while they fit, a long one cut
// to the passages holding the query's words, and no one node taking over half of it when others
// wait. What does not fit is dropped: the nodes returned are what the model reads, and what a filed
// answer derives from.
export function fitContext(nodes: readonly Node[], query: string, budget: number): readonly Node[] {
  const words = new Set(queryTerms(query));
  const fitted: Node[] = [];
  let left = budget;
  for (const [at, node] of nodes.entries()) {
    const body = node.body ?? "";
    const allowance = at === nodes.length - 1 ? left : Math.min(left, Math.ceil(budget / 2));
    if (cost(body) <= left && (cost(body) <= allowance || cost(body) <= budget / 2)) {
      fitted.push(node);
      left -= cost(body);
      continue;
    }
    if (allowance < SMALLEST_EXCERPT) break;
    const text = excerpt(body, words, allowance);
    fitted.push({ ...node, body: text });
    left -= cost(text);
  }
  return fitted;
}
