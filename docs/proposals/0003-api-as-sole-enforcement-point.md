# 0003 — The API is the only access-enforcement point

Stage: accepted

## Decision
No client, agent or ingester talks to the graph store directly. One service exposes webhooks, REST and MCP; it applies the caller's scopes **on every hop of a traversal**, gives derived nodes the most restrictive scope of their sources (`DERIVED_FROM`), and writes an audit entry for every read made on behalf of a user.

## Consequences
Neo4j Community is enough, since its lack of fine-grained access control is exactly what this layer provides. Every new read path (export, event stream, search) must reuse the same rule engine and ship with a leak test.
