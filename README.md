<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
    <img src="docs/assets/banner-light.png" alt="Graph-Warden: governed knowledge graph for AI agents" width="720">
  </picture>
</p>

# Graph-Warden

**An open-source, federated knowledge graph for AI agents.** Graph-Warden captures knowledge where teams already produce it (repositories, API specs, docs, agent sessions), compiles it into a typed graph, and exposes it to any consumer over MCP, REST or a live event stream.

Federated means many teams feed one graph without stepping on each other. Each node has a scope (shared, team or private) and a provenance. Shared knowledge has a single writer, and ingestion is ordered and idempotent. Governance is built in, not bolted on: see [Why](#why).

> Status: **pre-alpha**, milestone M0. Nothing here is ready for production. The design is settled in [`docs/adr`](docs/adr); the work is tracked in [issues](https://github.com/Graph-Warden/graph-warden/issues) and the [roadmap](docs/ROADMAP.md).

## Why

Graph databases already have role-based access, and agent-memory libraries already scope memories by user. What they leave open is what happens between the agent and the knowledge:

- **Traversal leaks.** Filtering nodes is not enough: a path through a node you may not see already tells you something. Graph-Warden checks access on every hop.
- **Derived knowledge.** A summary compiled by an LLM from three sources inherits the most restrictive scope of the three, through explicit `DERIVED_FROM` provenance.
- **Erasure.** Deleting a source deletes or recompiles everything derived from it (GDPR article 17).
- **Cross-team impact.** When the BFF team merges a change to an endpoint, the three front-end teams that consume it are told — before or after the merge.
- **Private by default.** Agent sessions stay private to their author until explicitly promoted to a team, after redaction.

## How it works

```
 sources                      Graph-Warden service                       consumers
 ───────                      ────────────────────                       ─────────
 merge on main ──webhook──▶ ┌──────────────┐    ┌───────────────────┐ ──MCP──▶ Claude Code, Cursor,
 GitHub Action ──push─────▶ │ ingestion    │──▶ │ access rules      │          LibreChat, Open WebUI
 git polling ─────────────▶ │ queue        │    │ (scope per hop,   │ ──REST─▶ your tools
 Obsidian / docs ─────────▶ │ (ordered,    │    │  provenance,      │ ──SSE──▶ web graph view
                            │  idempotent) │    │  audit)           │ ◀─pull── gwarden CLI + local cache
                            └──────┬───────┘    └─────────┬─────────┘
                                   ▼                      ▼
                            LLM provider            Neo4j (GraphStore)
                     (Claude, or any OpenAI-
                      compatible / local model)
```

- **Targeted ingestion**, like `jest --findRelatedTests`: a merge only revalidates the knowledge reachable from the files it changed.
- **No inbound port on developer machines**: clients pull or subscribe over SSE, so it works behind corporate proxies without tunnels.
- **Bring your own model and your own client**: one `LLMProvider` interface, any MCP client.

## Repository layout

| Package | Role | Milestone |
|---|---|---|
| `packages/core` | Ontology, scopes, access rules | M0 |
| `packages/api` | REST + webhooks, the only access-enforcement point | M2 |
| `packages/mcp` | MCP server | M2 |
| `packages/worker` | Ingestion queue consumer, LLM calls | M1 |
| `packages/cli` | `gwarden pull`, `gwarden forget`, PR impact | M2 |
| `packages/web` | Graph view (Sigma.js), live over SSE | M2 |
| `packages/adapters/*` | Sources, LLM providers, stores, queues, analyzers | M1+ |

## Development

```sh
corepack enable
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

## Contributing

Adapters are the easiest way in: each kind has a typed interface and a shared conformance suite. Read [CONTRIBUTING.md](CONTRIBUTING.md), then pick an issue labelled [`good first issue`](https://github.com/Graph-Warden/graph-warden/labels/good%20first%20issue).

Found a way to read something you should not? Report it privately: see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
