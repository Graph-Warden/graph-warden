# 0011 — Questions answered from the graph, and deletion that follows derivation

Stage: to be reviewed

## Context
Two things are asked of the graph that the read-only API (proposal 0003) cannot do.

- **Asking.** A user wants an answer, not a list of nodes: in the manner of an LLM-maintained wiki, a model reads a few pages, answers with citations, and the answer is filed back as a page so that knowledge compounds. The model must see only what the user may read, and a filed answer must not be readable by anyone who could not read what it was written from.
- **Deleting.** A node is wrong, obsolete or must be erased. What was derived from it cannot simply stay, nor be deleted wholesale: a summary of three documents does not disappear because one of them did.

Both are writes. Proposal 0004 keeps shared knowledge to a single ingestion writer; these writes come from users, through the API.

## Decision
- **Nodes carry their text** (`body`): the body of a Markdown page, the `body` field of a JSON or YAML document. The graph stays the source of truth; nothing reads the files back.
- **Retrieval is the domain's, not the model's.** `ask` picks among the nodes the user may read (an optional anchor node and its readable neighbours, then nodes scored on the question's words) and hands the model those nodes and nothing else. The audit entry names every node handed over, before the model reads them.
- **A filed answer is derived from every node the model read**, cited or not, with `DERIVED_FROM` edges. Its scope follows proposal 0010: private to the asker by default, or a declared scope narrowed to the readers of all its sources. Answering needs no group; filing needs a writer group.
- **Deletion follows `DERIVED_FROM` only.** Deleting a node removes it and its edges. A node derived from it and from others loses that edge and keeps its other sources; a node whose every source is deleted is deleted too, down the chain. Nodes it points to, or that merely reference it, are untouched.
- **A node that loses a source keeps its scope.** Its text was written from that source too; recomputing its scope from the remaining sources would widen it to people who could never read the deleted one.
- **Who may delete:** members of a writer group (`GWARDEN_WRITERS`) who may read the node, every node the deletion removes and every node that loses a source. A deletion that would touch anything else is refused without naming it.
- **A deletion is shown before it is made.** The plan (nodes removed, edges detached) comes with a digest; the deletion is made only with the digest of a plan that still matches the graph, so a confirmation never covers more than was shown. The CLI asks the user to type the node id. Previews, deletions and refusals are all audited.
- **The model is behind the `LLMProvider` port** (proposal 0007). The first adapter is Claude; an API without a model configured answers questions with 501.

## Consequences
- What an answer could have drawn on is known exactly, which is what makes its scope sound. The price is that retrieval is lexical and simple; better retrieval (embeddings, graph-aware ranking) can replace it behind the same rule: the model sees only what retrieval picked.
- Answers filed with a wide declared scope are often narrowed to a few people, because the model read nodes from several teams. That is the rule working, not a bug; an anchor (`--from`) keeps retrieval, and so the scope, focused.
- The question itself is stored in the audit log and in a filed answer's body.
- Erasure (`gwarden forget <source>`) is deletion applied to every node of a source; it builds on this plan and digest. Deletion is not tied to ingestion: re-ingesting a deleted document brings it back. Erasure is: an erased source stays out, since it may still hold the text and nothing keeps the text to recognise it. The writer refuses its nodes, the ingester skips it, and time travel has no past for it, until an operator readmits it (`gwarden readmit <source>`, audited). This stands for the source, not the words: the same text copied into another source is not caught.
