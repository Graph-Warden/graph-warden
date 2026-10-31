# 0013 — Retrieval ranked by the graph, within a budget, behind a port that cannot interfere

Stage: to be reviewed

## Context
Retrieval (proposal 0011) counted a question's words and took the first eight nodes, whole. Three limits followed: what sits one link from the matching documents was missed, which is what a graph is for; one long document could fill a model's context; and every question reread the whole graph.

The usual fixes break non-interference (proposal 0002). A search engine's scores count the words of every document it holds, so a reader's results move when a hidden document changes. A limit applied before the scopes lets hidden documents push readable ones out. Centrality computed on the whole graph lets a hidden link lift a readable node. Each one tells a reader something about what they cannot read, without showing them any of it.

## Decision
- **The graph is cut once, first.** `retrieve` takes the readable part of the graph (nodes, and edges between them) and everything after works on that: word statistics, the walk over links, the cut at the limit. What a reader gets, order included, is what they would get if nothing else existed. This is a property test over arbitrary graphs, principals and queries, not a convention.
- **Ranking is BM25 over the readable nodes, then a short walk over links.** The walk starts from the lexical scores, crosses at most two links, and reads them both ways. A node with none of the query's words can come in, if it weighs at least a tenth of the best node. With no word matching, nothing is returned, whatever the links.
- **Links serve answers, not lists, and not filed answers.** A search shows what holds its words; links only rank them. A filed answer is scoped by all it read, so a node the question did not ask for would narrow who can read it: links bring nothing in when filing.
- **A link never changes where a question goes.** A provider that routes (issue #28) says which sources would send a request elsewhere or refuse it (`narrows`), and retrieval does not follow a link to a node holding such content. A confidential document whose words match is read as before, and the question goes local.
- **A node's sensitivity follows derivation.** The sources of a request are those of what its text holds: the node's own and those of everything it derives from, at any distance (`contentSources`). Before this, a filed answer written from a confidential document carried the asker as its only source and went to the remote model. This holds for asking, revalidation and recompilation.
- **`ask` reads within a budget of tokens** (`GWARDEN_ASK_BUDGET`, 8000 by default): the best nodes first, whole while they fit, a long one cut to the sentences holding the query's words, no node over half the budget while others wait. What does not fit is dropped, and a dropped node is not a source: it is not recorded, routed, or derived from.
- **Full text sits behind `TextIndex`, which does not rank, cut or filter.** It says which nodes hold one of some terms, every one of them, of every scope. The domain filters and scores what comes back. Filtering in the adapter would repeat `canRead` in Cypher, which proposal 0003 rules out, and ranking or cutting there is the interference described above. Terms are computed by the domain, stored on the node, and indexed by Neo4j split on spaces only, so an index matches what a scan matches: a conformance suite (`checkTextIndex`) checks that no match is cut, and the property tests check that results through an index equal a scan.
- **Embeddings wait for the retrieval set.** `gwarden-eval --retrieval` measures recall without a model, and they come only if it shows a gap on a real corpus. They would inherit the same rules: statistics over readable nodes, and no nearest-neighbour cut before the scopes.

## Consequences
- A reader's results depend only on what they can read, for the channels the property covers: ids, order, and the context handed to the model. Timing is not covered: a search over a graph with more hidden nodes takes longer.
- `snapshot()` is still read for every search: the walk needs the edges, and the statistics need the number of readable nodes. The index saves reading every document's text, not loading the graph. Per-hop lookups (proposal 0009) remain the way past memory.
- Precision falls as recall rises: linked nodes are often not what the question needed, and the budget pays for them. The same question can read more when asked than when filed.
- Terms are prefixes of five characters, a language-neutral approximation: `paginated` meets `pagination`, `erased` does not meet `erasure`. They do not translate, so a question in French misses a document in English that shares no root with it.
- Changing how terms are computed means reindexing: `ensureConstraints` only fills nodes that have no terms.
- A node keeps its text after a plain deletion of a source (proposal 0011), so it records the sources it loses (`heldSources`): routing still reads them, and erasing such a source reaches the node. Ingesting a document again replaces the node and clears them.
