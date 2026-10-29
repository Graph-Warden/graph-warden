<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
    <img src="docs/assets/banner-light.png" alt="Graph-Warden: governed knowledge graph for AI agents" width="720">
  </picture>
</p>

# Graph-Warden

**An open-source, federated knowledge graph for AI agents.** Graph-Warden captures knowledge where teams already produce it (repositories, API specs, docs, agent sessions), compiles it into a typed graph, and exposes it to any consumer over MCP, REST or a live event stream.

Federated means many teams feed one graph without stepping on each other. Each node has a scope (shared, team or private) and a provenance. Shared knowledge has a single writer, and ingestion is ordered and idempotent. Governance is built in, not bolted on: see [Why](#why).

> Status: **pre-alpha**, milestone M0. Nothing here is ready for production. The design is settled in [`docs/proposals`](docs/proposals); the work is tracked in [issues](https://github.com/Graph-Warden/graph-warden/issues) and the [roadmap](docs/ROADMAP.md).
>
> **Works today:** the typed ontology (Zod), traversal with scopes checked on every hop, a Neo4j graph store, ingestion of Markdown documents (private by default), and a CLI to ingest and to walk the graph as a given user. **Not yet:** derived-scope inheritance, audit, erasure, the API, MCP, sync and the web view.

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
 docs (md/json/yaml) ─────▶ │ (ordered,    │    │  provenance,      │ ──SSE──▶ web graph view
                            │  idempotent) │    │  audit)           │ ◀─pull── gwarden CLI + local cache
                            └──────┬───────┘    └─────────┬─────────┘
                                   ▼                      ▼
                            LLM provider            Neo4j (GraphStore)
                     (Claude, or any OpenAI-
                      compatible / local model)
```

- **The graph is the source of truth**, never the files it was built from. It lives in a server: Neo4j running locally (`pnpm db:up`), or a hosted deployment (GCP, Azure…) from which `gwarden pull` fetches only what the user's scopes allow.
- **Targeted ingestion**, like `jest --findRelatedTests`: a merge only revalidates the knowledge reachable from the files it changed.
- **No inbound port on developer machines**: clients pull or subscribe over SSE, so it works behind corporate proxies without tunnels.
- **Bring your own model and your own client**: one `LLMProvider` interface, any MCP client.

## Repository layout

| Package | Role | State |
|---|---|---|
| `packages/core` | Ontology, scopes, per-hop traversal, `GraphStore` port | M0, in progress |
| `packages/adapters/neo4j` | `GraphStore` on Neo4j | M0, done |
| `packages/adapters/markdown` | Markdown documents as nodes and `REFERENCES` edges | M1, first slice |
| `packages/cli` | `gwarden ingest-markdown`, `gwarden traverse`; later `pull`, `forget`, PR impact | M0–M2 |
| `packages/api` | REST + webhooks, the only access-enforcement point | M2, planned |
| `packages/mcp` | MCP server | M2, planned |
| `packages/worker` | Ingestion queue consumer, LLM calls | M1, planned |
| `packages/web` | Graph view (Sigma.js), live over SSE | M2, planned |
| `packages/adapters/*` | More sources, LLM providers, stores, queues, analyzers | M1+ |

## Development

```sh
corepack enable
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

The Neo4j adapter tests run when `NEO4J_TEST_URI` points at a throwaway database, which they wipe:

```sh
docker compose --profile test up -d --wait neo4j-test
NEO4J_TEST_URI=bolt://localhost:7688 pnpm test
```

### Run it locally

Ingest a folder of Markdown documents into the local Neo4j, then walk the graph as different principals:

```sh
cp .env.example .env
pnpm db:up && pnpm build
pnpm gwarden ingest-markdown ~/docs --source docs:my-team --user alice --where theme=dev --default-scope team:dev
pnpm gwarden traverse some-page --user carol --team dev --direction both   # sees the team's pages
pnpm gwarden traverse some-page --user bob --direction both                # sees nothing

pnpm gwarden ingest-markdown ~/notes --source docs:alice --user alice       # no scope given: private to alice
```

`--where key=value` keeps pages whose frontmatter field equals the value or, for a list, contains it. A page's own `scope:` field (`shared`, `team:<x>`, `private:<user>`) wins over `--default-scope`. Without either, a page is private to the ingesting `--user`: nothing is shared unless someone chose to share it.

Neo4j Browser at <http://localhost:7474> (user `neo4j`, password from `.env`) shows the raw graph, for example `MATCH p=(:Node)-[:REFERENCES]->(:Node) RETURN p`. It is an administrator's view: it bypasses the scopes, which only `gwarden` and the API apply.

## Contributing

Adapters are the easiest way in: each kind has a typed interface in `core` (a shared conformance suite per kind is planned). Read [CONTRIBUTING.md](CONTRIBUTING.md), then pick an issue labelled [`good first issue`](https://github.com/Graph-Warden/graph-warden/labels/good%20first%20issue).

Found a way to read something you should not? Report it privately: see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
