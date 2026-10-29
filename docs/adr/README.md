# Architecture decision records

One file per decision, numbered. Status is `Accepted`, `Superseded by NNNN` or `Proposed`. To propose a change, add a new ADR in a pull request; do not rewrite an accepted one.

| # | Decision |
|---|---|
| [0001](0001-typescript-and-zod.md) | TypeScript strict, Zod as the single source of types |
| [0002](0002-one-graph-many-scopes.md) | One graph, scoped views per team |
| [0003](0003-api-as-sole-enforcement-point.md) | The API is the only access-enforcement point |
| [0004](0004-single-writer-ordered-ingestion.md) | One writer for shared nodes, ordered idempotent ingestion |
| [0005](0005-targeted-ingestion.md) | Targeted ingestion, like `jest --findRelatedTests` |
| [0006](0006-pull-and-sse.md) | Pull and SSE, not WebSocket, no inbound ports |
| [0007](0007-pluggable-llm-and-clients.md) | Pluggable LLM provider and MCP clients |
| [0008](0008-apache-2.md) | Apache-2.0 license |
| [0009](0009-domain-driven-design.md) | Domain-driven design, preferred not mandated |
