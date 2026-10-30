# Proposals

One file per design decision, numbered, in the spirit of the TC39 process: a proposal moves through stages instead of being simply accepted. The stage is the `Stage:` line under the title; the same stages label the issues (`stage: …`) that carry the work.

| Stage | Meaning |
|---|---|
| `to be reviewed` | Written and open for discussion in a pull request or an issue. Nothing is built on it yet. |
| `accepted` | Agreed. Work may start; the text is no longer rewritten. |
| `in progress` | At least one pull request implementing it has been merged, and more are expected. |
| `done` | Fully implemented on `main`. |
| `refused` | Rejected or superseded. Kept for the record, with the reason or `Superseded by NNNN`. |

A proposal normally goes `to be reviewed` → `accepted` → `in progress` → `done`, or ends at `refused`. To change an accepted decision, write a new proposal and move the old one to `refused` with `Superseded by NNNN`; do not rewrite it.

| # | Proposal | Stage |
|---|---|---|
| [0001](0001-typescript-and-zod.md) | TypeScript strict, Zod as the single source of types | in progress |
| [0002](0002-one-graph-many-scopes.md) | One graph, scoped views per team | in progress |
| [0003](0003-api-as-sole-enforcement-point.md) | The API is the only access-enforcement point | in progress |
| [0004](0004-single-writer-ordered-ingestion.md) | One writer for shared nodes, ordered idempotent ingestion | accepted |
| [0005](0005-targeted-ingestion.md) | Targeted ingestion, like `jest --findRelatedTests` | accepted |
| [0006](0006-pull-and-sse.md) | Pull and SSE, not WebSocket, no inbound ports | in progress |
| [0007](0007-pluggable-llm-and-clients.md) | Pluggable LLM provider and MCP clients | accepted |
| [0008](0008-apache-2.md) | Apache-2.0 license | done |
| [0009](0009-domain-driven-design.md) | Domain-driven design, preferred not mandated | done |
| [0010](0010-identity-groups-and-derived-scopes.md) | Rights come from the identity provider; derived nodes require every source team | to be reviewed |
| [0011](0011-ask-and-governed-deletion.md) | Questions answered from the graph, and deletion that follows derivation | to be reviewed |
| [0012](0012-web-app-stream-and-wiki-pages.md) | A web app on the API, a live stream, and pages written in the browser | to be reviewed |
