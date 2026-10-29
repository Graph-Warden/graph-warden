# Roadmap

Each line is a GitHub issue under the matching milestone. Labels in brackets.

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
- [ ] SSE stream filtered by scope, resume with `Last-Event-ID` [api, security]
- [ ] Web graph view: Sigma.js, filters, neighbourhood, live updates [web]
- [ ] Time travel by commit and PR impact view [web]
- [ ] `gwarden forget <source>` with propagation [core, security]

## M3 — Opening up
- [ ] Source adapters: Markdown documents, GitLab, Confluence, Jira [adapter, good first issue]
- [ ] Exports: Markdown documents, JSON-LD, GraphML [adapter, good first issue]
- [ ] RDF `GraphStore` (SPARQL) [adapter]
- [ ] Helm chart; deployment guides for GCP (GKE, Neo4j Aura, Vertex) then Azure [deploy]
- [ ] Agent-session capture with promotion and redaction [worker, security]
- [ ] Model routing by source sensitivity [worker, security]
