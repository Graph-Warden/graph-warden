<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
    <img src="docs/assets/banner-light.png" alt="Graph-Warden: governed knowledge graph for AI agents" width="720">
  </picture>
</p>

<p align="center"><b>English</b> · <a href="README.fr.md">Français</a></p>

# Graph-Warden

**One knowledge graph for every team's AI agents, with rights checked on every hop.**

Graph-Warden collects what teams already write (repositories, API specs, docs, agent sessions), links it into one typed graph, and lets AI agents query it. Every query is made on behalf of a person, returns only what that person may see, and is recorded.

> Status: **pre-alpha**, milestone M0. Nothing here is ready for production. See [what works today](#what-works-today) and the [roadmap](docs/ROADMAP.md).

**Reading guide.** The [first part](#part-1--the-product) is for anyone deciding whether this is useful: the problem, who it is for, a demo. The [second part](#part-2--under-the-hood) is for anyone building or running it: architecture, how a read is checked, how to run it.

| Part 1 — The product | Part 2 — Under the hood |
|---|---|
| [The problem](#the-problem) | [Architecture](#architecture) |
| [An example](#an-example-one-endpoint-four-teams) | [Scopes](#scopes) |
| [What it guarantees](#what-it-guarantees) | [Anatomy of a read](#anatomy-of-a-read) |
| [Who it is for](#who-it-is-for) | [Derived scopes](#derived-scopes) |
| [See it run](#see-it-run) | [Asking the graph](#asking-the-graph) |
| [Ask and delete](#ask-and-delete) | [Deleting a node](#deleting-a-node) |
| [How it differs](#how-it-differs) | [Quick start](#quick-start) |
| [What works today](#what-works-today) | [Repository layout](#repository-layout) |
| | [Contributing](#contributing) |

---

# Part 1 — The product

## The problem

A large organisation wants its AI agents to know what the organisation knows. Today it has two options, and both are bad:

- **Open everything.** One team's agent reads HR files, security incidents, M&A notes and customer data that are none of its business.
- **Wall every team off.** Each team gets its own silo, and everything that crosses teams is lost — which is exactly where agents would help most.

Graph-Warden is the third option: **one shared graph, with access decided on every read.**

Filtering the final answer is not enough. In a graph, the path itself leaks information:

```mermaid
flowchart LR
    A["checkout<br/><i>team:front-a</i>"] -- CONSUMES --> O["GET /orders<br/><i>shared</i>"]
    P["Project Falcon<br/><i>team:m-and-a</i>"] -. "path an agent<br/>must not walk" .-> O
    P --> R["Retailer X contract<br/><i>team:m-and-a</i>"]

    classDef ok fill:#e7f5ea,stroke:#2f8a47,color:#123
    classDef hidden fill:#fbe9e9,stroke:#c0392b,color:#123,stroke-dasharray: 4 3
    class A,O ok
    class P,R hidden
```

An agent working for a front-end developer may walk from `checkout` to `GET /orders`. It must not walk on to `Project Falcon`, and must not even learn that it exists because a path ran through it. Graph-Warden checks rights **before each step**, not on the final result.

## An example: one endpoint, four teams

The BFF team is about to change how `GET /orders` paginates. Three front-end teams consume it.

- **Bob** (BFF team) asks his agent what depends on the endpoint. He sees his service and his decision record, not the front-end teams' internal notes.
- **Alice** (front-end team A) sees her checkout module and the incident it caused last month, not the BFF's internals.
- **Lea** (lead) sees all of it, plus an impact summary written for the leads from the three teams' documents.
- **Bob does not see that summary**, even though it was published as "shared": it is built from documents he may not read, so Graph-Warden narrows it automatically.
- **The DPO** can list every read any agent made, and when. Bob cannot.

One graph, five people, five correct views — and nobody configured a filter for any of them. The [demo](#see-it-run) runs exactly this.

## What it guarantees

| Guarantee | In plain words |
|---|---|
| **Per-step access** | An agent never walks through something its user may not see, so nothing is inferred through it. |
| **Summaries inherit their sources** | A summary built from three teams' documents is readable only by people who may read all three. |
| **Private by default** | A document nobody scoped stays private to whoever added it. Sharing is always a decision. |
| **One door** | Agents and tools reach the graph only through the API. Nobody queries the database directly. |
| **Every read is recorded** | Who asked, with which groups, for what, and what came back. If the record cannot be written, the read fails. |
| **Answers stay within your rights** | An AI answer is written only from what you may read, and a saved answer is visible only to people who may read everything it was written from. |
| **Deletion follows summaries** | Deleting a document deletes the summaries built only from it, and only unlinks those built from other documents too. You see the full list and type the name before anything goes. |
| **Your directory decides** | Users and groups come from your identity provider (Entra ID, Okta, Keycloak, Google Workspace…). No second user base to maintain. |
| **Erasure of a whole source** *(planned)* | Erasing a source (GDPR article 17) applies the same deletion to every document it brought in. |

## Who it is for

- **Security teams: agents that do not leak.** Rights are checked on every step of a traversal, not only on the result.
- **Engineering teams: cross-team impact before the merge.** When the BFF team changes an endpoint, the front-end teams that consume it are told in the pull request, before it breaks in production *(planned, M2)*.
- **Data protection and audit: compliance built in.** Every read an agent makes on behalf of a user is recorded, and erasure will reach everything an LLM derived from the erased source.
- **Infrastructure teams: it fits a large group's constraints.**
  - Self-hosted, on GCP, Azure or on premises.
  - Developer machines open no inbound port: they pull the part of the graph their user may see.
  - No tunnel, and SSE rather than WebSocket, so corporate proxies let it through.
  - Apache-2.0, which legal teams accept where they often block the AGPL.
  - Any model, including a local one for sensitive sources.

## See it run

The demo is the example above, on a sample shop. Its graph:

```mermaid
flowchart LR
    OS["orders-service<br/><i>team:bff</i>"] -- EXPOSES --> O["orders-api<br/><i>shared</i>"]
    ADR["adr-0007-cursor-pagination<br/><i>team:bff</i>"] -- DECIDES --> O
    CK["checkout<br/><i>team:front-a</i>"] -- CONSUMES --> O
    BO["backoffice<br/><i>team:front-b</i>"] -- CONSUMES --> O
    MA["mobile-app<br/><i>team:front-c</i>"] -- CONSUMES --> O
    INC["incident-142<br/><i>team:front-a</i>"] -- CAUSES --> CK
    PI["pagination-impact<br/><i>teams:bff,front-a,front-b</i>"] -- DERIVED_FROM --> ADR & CK & BO
    LN["lea-notes<br/><i>private:lea</i>"] -- REFERENCES --> ADR

    classDef shared fill:#e7f5ea,stroke:#2f8a47,color:#123
    classDef bff fill:#e6f0fb,stroke:#2e6fb7,color:#123
    classDef front fill:#f1eafb,stroke:#7d4fc0,color:#123
    classDef derived fill:#fff4e0,stroke:#d68910,color:#123
    classDef private fill:#f2f2f2,stroke:#777,color:#123
    class O shared
    class OS,ADR bff
    class CK,BO,MA,INC front
    class PI derived
    class LN private
```

| Person | Groups (from the directory) |
|---|---|
| Bob | `dev`, `bff` |
| Alice | `dev`, `front-a` |
| Carla | `dev`, `front-c` |
| Lea | `dev`, `dev-leads`, and through it every team group |
| DPO | `auditors` |

It needs only Docker:

```sh
docker compose --profile demo up -d --build --wait
examples/shop/demo.sh
```

**1. Same question, same graph, four answers.** Bob sees the BFF side of the endpoint, Alice her module and its incident, Carla only the mobile app. Lea, a lead, sees everything around it, including her own private notes.

<p align="center"><img src="docs/assets/demo-1-views.svg" alt="Four users run the same traversal of orders-api and get different results" width="660"></p>

**2. A summary takes the scope of all its sources.** Bob is in `bff` but not in `front-a` or `front-b`, so the impact summary does not exist for him. Lea reads it and its sources.

<p align="center"><img src="docs/assets/demo-2-derived.svg" alt="Ingestion narrows pagination-impact; Bob gets nothing, Lea gets the summary and its sources" width="750"></p>

**3. Pull into a local cache.** Alice's machine opens no port: it pulls a SQLite cache that holds only what she may see, and later pulls only the changes.

<p align="center"><img src="docs/assets/demo-3-pull.svg" alt="Alice pulls three nodes and two edges into a local cache" width="800"></p>

**4. Every read is recorded.** Bob may not read the audit log, and his attempt is itself recorded. The DPO may.

<p align="center"><img src="docs/assets/demo-4-audit.svg" alt="Bob is refused the audit log; the DPO reads every entry, including Bob's denied attempt" width="1050"></p>

The demo API uses fixed tokens (`examples/shop/users.yaml`) and listens on localhost only. Stop it with `docker compose --profile demo down`.

## Ask and delete

**Ask a question, get an answer with sources.** `gwarden ask "How does the orders pagination change?"` answers from the documents you may read, and cites them. Bob and Lea asking the same question get different answers, because they may read different things. With `--save`, the answer becomes a page of the graph that others can find — visible only to those who may read everything it was written from.

**Delete without leaving orphans, and without collateral damage.** `gwarden delete adr-0007-cursor-pagination` shows what goes before anything does; here, with a summary written only from that decision:

```text
Deleting adr-0007-cursor-pagination removes:
  Decision  adr-0007-cursor-pagination  [team:bff]
  Concept   adr-summary  [team:bff]  derived only from deleted nodes
and detaches, keeping these nodes, their other sources and their scope:
  pagination-impact -DERIVED_FROM-> adr-0007-cursor-pagination

Are you sure? It will delete 2 entries from adr-0007-cursor-pagination.
Type adr-0007-cursor-pagination to confirm:
```

Only members of a writer group may delete or save answers, and only what they may read. If the graph changed between the preview and the confirmation, nothing is deleted.

## How it differs

Graph databases already have role-based access, and agent-memory libraries already scope memories by user. What they leave open is what happens between the agent and the knowledge:

- paths that leak through nodes the reader may not see;
- LLM-written summaries that are more visible than their sources;
- erasure that stops at the original document;
- changes in one team that silently break another.

## What works today

- the typed ontology (Zod) and a Neo4j graph store;
- ingestion of Markdown, JSON and YAML documents with typed references, private by default;
- traversal with scopes checked on every hop; derived documents readable only by those who read all their sources;
- a REST API whose identities and groups come from an OIDC provider or Google with Cloud Identity;
- an audit entry for every read, question and deletion;
- `gwarden pull` into a local SQLite cache holding only what the user may see;
- `gwarden ask`, answers from readable nodes with Claude, filed back as derived nodes on request;
- `gwarden delete`, following `DERIVED_FROM`, shown then confirmed;
- a `docker compose` demo and a Cloud Run deployment.

**Not yet:** revalidating derived scopes when a source or a group changes, erasing a whole source, MCP, the live SSE stream, LLM compilation and the web view. The design for all of it is settled in [`docs/proposals`](docs/proposals); the work is tracked in [issues](https://github.com/Graph-Warden/graph-warden/issues).

---

# Part 2 — Under the hood

## Architecture

```mermaid
flowchart LR
    subgraph Sources
        S1[merge on main]
        S2[GitHub Action]
        S3[git polling]
        S4[docs: md / json / yaml]
    end

    subgraph Service["Graph-Warden service"]
        Q["Ingestion queue<br/>ordered, idempotent,<br/>single writer"]
        G[("Neo4j<br/>GraphStore")]
        API["API<br/>scope per hop<br/>provenance · audit"]
        Q --> G
        G --> API
    end

    IdP["Identity provider<br/>OIDC · Cloud Identity"]
    LLM["LLM provider<br/>Claude, OpenAI-compatible,<br/>or a local model"]

    S1 & S2 & S3 & S4 --> Q
    Q -.-> LLM
    IdP -- "user + groups" --> API

    API -- REST --> C1[your tools]
    API -- MCP --> C2["Claude Code, Cursor,<br/>LibreChat, Open WebUI"]
    API -- SSE --> C3[web graph view]
    C4["gwarden CLI<br/>+ local cache"] -- pull --> API
```

Today: document ingestion through the CLI, Neo4j, the REST API, identity providers, `gwarden pull`, and questions answered by Claude. Planned: the queue, LLM compilation, webhooks, MCP and SSE.

- **The graph is the source of truth**, never the files it was built from. It lives in a server: Neo4j locally (`pnpm db:up`) or a hosted deployment, from which `gwarden pull` fetches only what the user may see.
- **Single writer, ordered ingestion** *(design)*: only the merge on `main` writes shared nodes, in commit order, and replaying a webhook creates no duplicates ([proposal 0004](docs/proposals/0004-single-writer-ordered-ingestion.md)).
- **Targeted ingestion**, like `jest --findRelatedTests`: a merge only revalidates the knowledge reachable from the files it changed ([proposal 0005](docs/proposals/0005-targeted-ingestion.md)).
- **No inbound port on developer machines**: clients pull or subscribe over SSE ([proposal 0006](docs/proposals/0006-pull-and-sse.md)).
- **Bring your own model and your own client**: one `LLMProvider` interface, any MCP client ([proposal 0007](docs/proposals/0007-pluggable-llm-and-clients.md)).

## Scopes

Every node carries exactly one scope:

| Scope | Readable by |
|---|---|
| `shared` | everyone authenticated |
| `team:bff` | members of the `bff` group |
| `teams:bff,front-a` | members of **both** groups (typically a node derived from both teams) |
| `private:alice` | Alice only |

Groups come from the identity provider, nested groups resolved. Oversight belongs there, not in Graph-Warden: a `dev-leads` group nested in every team group lets leads read across teams. See [proposal 0002](docs/proposals/0002-one-graph-many-scopes.md) and [proposal 0010](docs/proposals/0010-identity-groups-and-derived-scopes.md).

## Anatomy of a read

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Alice's agent
    participant API
    participant IdP as Identity provider
    participant Reader as Reader (core)
    participant Store as GraphStore
    participant Audit as AuditLog

    Dev->>API: GET /v1/nodes/orders-api/neighbours<br/>Authorization: Bearer token
    API->>IdP: principalFor(token)
    IdP-->>API: alice, groups [dev, front-a]
    API->>Reader: traverse(alice, orders-api)
    loop each hop
        Reader->>Store: neighbours of the current frontier
        Store-->>Reader: candidate nodes
        Reader->>Reader: drop every node alice may not read,<br/>and never expand from it
    end
    Reader->>Audit: append(alice, groups, start, options, returned ids)
    Audit-->>Reader: written (or the read fails)
    Reader-->>API: visible nodes
    API-->>Dev: 200 { nodes }
```

The API is the only place readers reach the graph ([proposal 0003](docs/proposals/0003-api-as-sole-enforcement-point.md)). The audit entry is written **before** the answer leaves; entries are append-only, numbered in write order, and stored outside the graph that traversals walk. A property-based test (fast-check) checks it on random graphs: a traversal returns only readable nodes, and its result is unchanged when every node the reader may not see is removed — so a hidden node cannot leak through an id, a count or a path.

## Derived scopes

```mermaid
flowchart BT
    ADR["adr-0007-cursor-pagination<br/><i>team:bff</i>"]
    CK["checkout<br/><i>team:front-a</i>"]
    BO["backoffice<br/><i>team:front-b</i>"]
    PI["pagination-impact<br/>declared: shared<br/>narrowed to: <b>teams:bff,front-a,front-b</b>"]

    PI -- DERIVED_FROM --> ADR
    PI -- DERIVED_FROM --> CK
    PI -- DERIVED_FROM --> BO

    classDef derived fill:#fff4e0,stroke:#d68910,color:#123
    class PI derived
```

A node with `DERIVED_FROM` edges gets the scope of all its sources together, its declared scope counting as one more source, so derivation never widens it:

- `shared` sources add no restriction;
- team sources add up: `team:bff` + `team:front-a` gives `teams:bff,front-a`;
- any private source makes the result private to its author.

The author must be able to read every source: nobody derives from what they cannot see.

## Asking the graph

```mermaid
sequenceDiagram
    actor User as Bob
    participant Asker as Asker (core)
    participant Audit as AuditLog
    participant LLM as LLMProvider
    participant Writer

    User->>Asker: ask("How does pagination change?", save?)
    Asker->>Asker: retrieve: readable nodes only<br/>(anchor + neighbours, then word matches)
    Asker->>Audit: append(question, every node handed over)
    Asker->>LLM: those nodes, nothing else
    LLM-->>Asker: answer citing [[ids]]
    opt --save, writer group
        Asker->>Writer: answer node, DERIVED_FROM every node read,<br/>scope = declared ∩ readers of all of them
    end
    Asker-->>User: answer + nodes read
```

Retrieval is done by the domain, not by the model, so the nodes an answer could draw on are known exactly. A saved answer is derived from **all** of them, cited or not: it is private to the asker by default, and `--scope shared` is narrowed to the readers of all its sources ([proposal 0011](docs/proposals/0011-ask-and-governed-deletion.md)). The model sits behind the `LLMProvider` port; the first adapter is Claude (`GWARDEN_LLM=claude`, default model `claude-opus-5-5`, credentials from the environment).

## Deleting a node

```mermaid
flowchart BT
    X["adr-0007<br/><b>deleted</b>"]
    S["adr-summary<br/>only source: adr-0007<br/><b>deleted too</b>"]
    D["digest<br/>only source: adr-summary<br/><b>deleted too</b>"]
    I["pagination-impact<br/>sources: adr-0007, checkout<br/><b>kept, edge detached, scope unchanged</b>"]
    C["checkout"]
    M["orders-service<br/>IMPORTS adr-0007<br/><b>kept</b>"]

    S -- DERIVED_FROM --> X
    D -- DERIVED_FROM --> S
    I -. "DERIVED_FROM (removed)" .-> X
    I -- DERIVED_FROM --> C
    M -- IMPORTS --> X

    classDef gone fill:#fbe9e9,stroke:#c0392b,color:#123
    classDef kept fill:#e7f5ea,stroke:#2f8a47,color:#123
    class X,S,D gone
    class I,M,C kept
```

- Only `DERIVED_FROM` propagates. A node whose every source is deleted goes too, down the chain; a node with other sources only loses the edge.
- A node that loses a source **keeps its scope**: its text was written from that source too, and widening it to its remaining sources would show it to people who could never read the deleted one.
- Deleting needs a writer group (`GWARDEN_WRITERS`) and read access to every node removed or detached; otherwise the deletion is refused without naming what it would reach.
- The plan comes with a digest. `DELETE /v1/nodes/{id}?confirm=<digest>` is refused with 409 if the graph changed since, so a confirmation never covers more than was shown. Previews, deletions and refusals are audited.

## Quick start

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

### Ingest and query locally

Ingest a folder of Markdown, JSON or YAML documents into the local Neo4j, then walk the graph as different principals:

```sh
cp .env.example .env
pnpm db:up && pnpm build
pnpm gwarden ingest ~/docs --source docs:my-team --user alice --where theme=dev --default-scope team:dev
pnpm gwarden traverse some-page --user carol --team dev --direction both   # sees the team's pages
pnpm gwarden traverse some-page --user bob --direction both                # sees nothing
pnpm gwarden audit --user carol                                            # what carol read, and when

pnpm gwarden ingest ~/notes --source docs:alice --user alice       # no scope given: private to alice
```

A document is a Markdown page with frontmatter, or a JSON or YAML object:

```markdown
---
type: Module
scope: team:front-a
references:
  - { type: CONSUMES, to: orders-api }
---
# Checkout

Lists the customer's orders with `GET /orders`, page by page.
```

- `references` lists edges, typed (`{ type: DECIDES, to: bff-api }`) or not (`- glossary`, a `REFERENCES` edge, like a Markdown `[[glossary]]` link).
- `id` defaults to the file name, `type` to `Concept`.
- `scope` (`shared`, `team:<x>`, `teams:<x>,<y>`, `private:<user>`) wins over `--default-scope`. Without either, a document is private to the ingesting `--user`.
- `--where key=value` keeps documents whose field equals the value or, for a list, contains it.
- `--team` stands for the groups an identity provider will report. Through the API, groups come from the token.

Neo4j Browser at <http://localhost:7474> (user `neo4j`, password from `.env`) shows the raw graph, for example `MATCH p=(:Node)-[:REFERENCES]->(:Node) RETURN p`. It is an administrator's view: it bypasses the scopes, which only `gwarden` and the API apply.

### Through the API

Readers go through the API rather than Neo4j: `pnpm --filter @graph-warden/api start` with the settings of [`packages/api/src/config.ts`](packages/api/src/config.ts), then `gwarden traverse`, `pull`, `cache` and `audit` with `--api` and `--token` (or `GWARDEN_API` and `GWARDEN_TOKEN`). The API documents itself at `/openapi.json`.

| Route | Returns |
|---|---|
| `GET /v1/me` | the caller's user and groups |
| `GET /v1/nodes/{id}/neighbours` | the nodes reachable from `id` that the caller may read (`direction`, `depth`, `edge`) |
| `GET /v1/pull?after=<cursor>` | what changed for the caller since the cursor |
| `GET /v1/audit` | the audit log, for auditor groups only |
| `GET /v1/nodes/{id}/deletion` | what deleting `id` would remove and detach, and the digest to confirm it with |
| `DELETE /v1/nodes/{id}?confirm=<digest>` | the deletion, for writer groups, if the plan still matches |
| `POST /v1/ask` | an answer from the nodes the caller may read; `save: true` files it (writer groups) |

```sh
gwarden ask "How does the orders pagination change?" --from orders-api   # answer, and the nodes read
gwarden ask "How does the orders pagination change?" --save --scope shared
gwarden delete adr-0007-cursor-pagination                                 # shows, then asks you to type the id
```

The API settings for writes: `GWARDEN_WRITERS` (groups that may delete and save answers), `GWARDEN_LLM=claude` and optionally `GWARDEN_LLM_MODEL`.

### Deploy on Google Cloud

[`deploy/gcp`](deploy/gcp/README.md): the API on Cloud Run, the graph on Neo4j Aura, identities from Google sign-in restricted to your domain, groups from Cloud Identity.

## Repository layout

| Package | Role | State |
|---|---|---|
| `packages/core` | Ontology, scopes, derived scopes, per-hop traversal, audited reads, event log and pull deltas, questions, deletion plans; `GraphStore`, `AuditLog`, `EventLog`, `IdentityProvider` and `LLMProvider` ports | M0 done, M2 in progress |
| `packages/adapters/neo4j` | `GraphStore`, append-only `AuditLog` and `EventLog` on Neo4j | done |
| `packages/adapters/identity` | `IdentityProvider` for OIDC (Entra ID, Keycloak, Okta…), Google with Cloud Identity groups, and demo tokens | M2, first slice |
| `packages/adapters/memory` | In-memory ports for tests and demos | done |
| `packages/adapters/documents` | Markdown, JSON and YAML documents as nodes and typed edges, with their text | M1, first slice |
| `packages/adapters/anthropic` | `LLMProvider` on Claude | first slice |
| `packages/cli` | `gwarden ingest`, `traverse`, `audit`, `pull`, `cache`, `ask`, `delete`; later `forget`, PR impact | M0–M2 |
| `packages/api` | REST with OpenAPI, the only place readers reach the graph; webhooks later | M2, first slice |
| `packages/mcp` | MCP server | M2, planned |
| `packages/worker` | Ingestion queue consumer, LLM calls | M1, planned |
| `packages/web` | Graph view (Sigma.js), live over SSE | M2, planned |
| `packages/adapters/*` | More sources, LLM providers, stores, queues, analyzers | M1+ |

```mermaid
flowchart TB
    cli[cli] --> core
    api[api] --> core
    cli --> documents[adapters/documents]
    cli --> neo4j[adapters/neo4j]
    api --> identity[adapters/identity]
    api --> neo4j
    api --> anthropic[adapters/anthropic]
    anthropic --> core
    documents --> core
    neo4j --> core
    identity --> core
    memory[adapters/memory] --> core
    core(["core<br/>domain + ports, no I/O"])
```

The core holds the rules and defines ports; adapters implement them ([proposal 0009](docs/proposals/0009-domain-driven-design.md)). A new store, source or identity provider is an adapter, never a change to the rules. The vocabulary is in the [glossary](docs/glossary.md).

## Contributing

Adapters are the easiest way in: each kind has a typed interface in `core` (a shared conformance suite per kind is planned). Read [CONTRIBUTING.md](CONTRIBUTING.md), then pick an issue labelled [`good first issue`](https://github.com/Graph-Warden/graph-warden/labels/good%20first%20issue). Commits follow Conventional Commits and are signed off (`git commit -s`).

Found a way to read something you should not? Report it privately: see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
