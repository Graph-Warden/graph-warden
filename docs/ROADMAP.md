# Roadmap

Each line is a GitHub issue under the matching milestone. Labels in brackets.

## Pass and stop criteria

What decides whether the differentiator holds, written before the evidence exists.

- **Pass:** an outside team runs Graph-Warden on its own documents ([#88](https://github.com/Graph-Warden/graph-warden/issues/88)) and publishes the results, with no read outside a reader's scope, recall of at least 80% on lexical and linked queries, and overall precision of at least 25% at k=8, the level measured on the example corpus. The project is open source, so that team can be anyone with documents and groups of its own, an open-source project with public documents included: nobody has to buy anything, and no confidential data is needed.
- **Stop or redirect:** no outside team has run it by 2027-01-31, or a leak turns out to come from the design rather than from a bug. Then the project stops adding features and stays a reference implementation of per-hop checks.
- **Until then:** no new feature starts before the audience ([#89](https://github.com/Graph-Warden/graph-warden/issues/89)) and the measure above are settled. Fixes, documentation and what those two need do not count as features.

## M0 — Foundation
- [x] Repository, pnpm monorepo, strict TypeScript, CI, license, contribution and security docs
- [x] Ontology in Zod, Neo4j constraints, Neo4j `GraphStore` [core]
- [x] Rule engine: scopes, per-hop checks, inheritance through `DERIVED_FROM`, audit log [core, security]
- [x] `docker compose` demo with a sample repository (one BFF, three front-ends) [demo]

## M1 — Git ingestion
- [ ] Ingestion queue serialised per repository, idempotent writes on `(repo, path, sha)` [worker]
- [ ] Inbound: GitHub webhook, GitHub Action push, `git fetch` polling [worker]
- [ ] `IMPORTS` graph from the TypeScript compiler [adapter]
- [ ] `Endpoint` / `CONSUMES` from OpenAPI specs [adapter]
- [ ] `findRelated`: reverse traversal, revalidation, stale marking [worker]
- [ ] PR dry-run with impact comment [cli]
- [ ] `LLMProvider`: Anthropic and OpenAI-compatible, shared evaluation set [adapter]

## M2 — Exposure and sync
- [ ] REST API with OpenAPI, OIDC identity [api]
- [ ] MCP server [mcp]
- [ ] Event log, `gwarden pull` with SQLite cache [api, cli]
- [x] SSE stream filtered by scope, resume with `Last-Event-ID` (proposal 0012) [api, security]
- [x] Web app: pages, search, graph view (Sigma.js) with neighbourhood, live updates (proposal 0012) [web]
- [x] Graph view at scale: 10k nodes, filters by type and team, neighbourhood expansion, layout in a web worker [web]
- [x] Wiki pages written in the browser, saved over the version read (proposal 0012) [core, api, web]
- [x] Time travel by commit and PR impact view [web]
- [ ] `gwarden forget <source>` with propagation [core, security]
- [x] `gwarden delete` following `DERIVED_FROM`, shown then confirmed (proposal 0011) [core, api, cli]
- [x] `gwarden ask`, answers from readable nodes, filed as derived nodes (proposal 0011) [core, api, cli]
- [x] Retrieval ranked by the graph, a context budget, full text behind a port that cannot interfere (proposal 0013) [core, neo4j, eval]

## M3 — Opening up
- [ ] Source adapters: Markdown documents, GitLab, Confluence, Jira [adapter, good first issue]
- [ ] Exports: Markdown documents, JSON-LD, GraphML [adapter, good first issue]
- [x] RDF `GraphStore` (SPARQL) [adapter]
- [ ] Helm chart; deployment guides for GCP (GKE, Neo4j Aura, Vertex) then Azure [deploy]
- [ ] Agent-session capture with promotion and redaction [worker, security]
- [ ] Model routing by source sensitivity [worker, security]
