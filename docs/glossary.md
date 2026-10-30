# Glossary

The words below are used with this meaning in code, proposals, issues and reviews (see [proposal 0009](proposals/0009-domain-driven-design.md)). Add a term in the same pull request that introduces it.

| Term | Meaning |
|---|---|
| Node | A unit of knowledge in the graph (file, endpoint, decision, note). Has exactly one scope and a provenance. |
| Edge | A typed relation between two nodes (`IMPORTS`, `CONSUMES`, `DERIVED_FROM`…). |
| Ontology | The closed set of node types (`Source`, `Decision`, `Concept`…) and edge types a graph accepts. Extensible by configuration, never by writing an unknown type. |
| Scope | Who may see a node: `shared`, `team:<x>`, `teams:<x>,<y>` (members of every listed team) or `private:<user>`. |
| Principal | The identity a read is made for: a user and their teams, as the identity provider reports them (nested groups resolved). |
| Grant | A right held by a principal that covers a scope. |
| Provenance | Where a node comes from: source, path, commit sha. |
| Derived node | A node produced from others, typically by an LLM. Linked with `DERIVED_FROM`; read only by those who read every source (proposal 0010). |
| Author | The principal a node is derived for. Must be able to read every source. |
| Traversal | Walking edges from a node. Scopes are checked on every hop, not only on the result. |
| Erasure | Removal of a source and of everything holding its content (`gwarden forget`): its nodes, the nodes derived only from them, and the nodes derived from them and from others, written again from their other sources by a model, or deleted without one. Ids stay in the event and audit logs; text does not. |
| Body | A node's text: what `ask` reads and what a filed answer holds. |
| Deletion plan | What deleting a node would do: the nodes removed (it, and the derived nodes left without a source), the `DERIVED_FROM` edges detached, and a digest. A deletion is made only with the digest of a plan that still matches the graph (proposal 0011). |
| Detach | Remove a `DERIVED_FROM` edge from a node that keeps other sources. The node keeps its scope. |
| Editor | The only way to delete on behalf of a principal (`createEditor`): checks the writer groups and the scopes, audits, then writes. |
| Writer group | A group whose members may delete nodes and file answers (`GWARDEN_WRITERS`). |
| Wiki page | A node written in the web app rather than ingested: its provenance source is `wiki`. Saved over the version it edits (proposal 0012). |
| Page version | A fingerprint of a node, sent as `ETag`. A page save names the version it edits and is refused if the page changed since. |
| Session | A browser's sign-in: an encrypted `HttpOnly` cookie holding the ID token, resolved like a bearer token on each request. |
| Stream | `GET /v1/stream`: server-sent events, one delta each time what the caller may read changes. |
| Asker | The use case answering a question (`createAsker`): retrieves readable nodes, audits them, hands them to the model, and files the answer if asked. |
| LLM provider | The port (`LLMProvider`) for a language model. |
| Audit entry | A record of a read made on behalf of a user. |
| Event log | The append-only port (`EventLog`) recording every write to the graph with a sequence number. Pulls read it to know what changed since a cursor. |
| Writer | The only way to write the graph (`createWriter`): every write lands in the store and then in the event log. |
| Delta | What a pull returns: the nodes and edges readable now among those touched since the cursor, and the ids to drop. Computed from the current graph, never by replaying history. |
| Identity provider | The port (`IdentityProvider`) turning a bearer token into a principal with its groups: OIDC, Google with Cloud Identity, or demo tokens. |
| Audit log | The append-only port (`AuditLog`) holding audit entries in write order. Itself sensitive: it says who saw what. |
| Reader | The only way to read the graph on behalf of a principal (`createReader`): applies the scopes, then writes the audit entry before returning the result. |
| Port | An interface declared in `core` (`GraphStore`, `AuditLog`, `LLMProvider`). |
| Adapter | A package that implements a port for a concrete technology. |
| Graph store | The port (`GraphStore`) that persists nodes and edges. Stores never filter by scope; the domain does. |
| Ingester | The use case bringing a repository's graph up to a commit (`createIngester`): walks the first-parent history from the last commit ingested and ingests each commit from its diff, in git order (proposal 0004). |
| Ingestion job | "This repository has reached this commit". Jobs need no order and may repeat: a commit behind the last ingested one is a no-op. |
| Ingestion queue | The port (`IngestionQueue`) holding ingestion jobs. Handles one repository's jobs one at a time across workers; a job leaves it only once handled. |
| Ingestion state | The port (`IngestionState`) recording the last commit ingested per repository. |
| Repository | The port (`Repository`) for a git repository: ancestry, first-parent commits, changed files, file contents. |
| Extractor | Turns the files a commit changed into nodes and edges (documents, TypeScript imports, OpenAPI specs). |
| Change | The node of one ingested commit. It `MODIFIES` the nodes of the files it touched; its id is `<repo>@<sha>`. |
| Worker | The ingestion process (`gwarden-worker`): learns about merges by GitHub webhook, by a push from CI (`action/ingest`) or by polling its clones, and ingests them through the queue. |
| Trigger | One way the worker learns that a repository reached a commit. Every trigger only queues a job; none carries a diff. |
| Module | The node of one source file, id `<repo>:<path>`. `IMPORTS` edges link modules as the TypeScript compiler resolves them. |
| Endpoint | The node of one operation of an OpenAPI spec, id `<repo>:<METHOD> <path>`. Modules next to the spec `EXPOSES` it; modules elsewhere that call it, through a generated client or `fetch`, `CONSUMES` it. |
| Related nodes | What depends on a change (`findRelated`): edges followed towards their dependents (`IMPORTS`, `DERIVED_FROM`, `DECIDES`, `CONSUMES` backwards, `EXPOSES` forwards). |
| Revalidator | The use case sending the knowledge related to a commit to the model (`createRevalidator`): valid, updated (derived nodes only, narrowed to the code's readers) or contradicted (`CONTRADICTS` from the commit, and an alert). |
| Stale mark | A node related to a change but beyond the revalidation depth (`StaleMarks`): revalidated on its first read. |
| Evaluation set | The cases every LLM provider is run against (`packages/eval/cases.yaml`, `gwarden-eval`): the revalidation verdict and the `ask` answer, with the production prompts and validation. |
| MCP server | `POST /mcp` on the API (Streamable HTTP, stateless): the tools `search`, `get_node`, `neighbourhood`, `impact`, `recent_changes`, each called as the bearer token's user, through the reader. |
