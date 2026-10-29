# 0009 — Domain-driven design, preferred not mandated

Stage: done

## Context
The value of the project is a handful of rules that must never be broken: a node has exactly one scope and a provenance, a derived node takes the most restrictive scope of its sources, every hop of a traversal is checked, an erasure propagates. If these rules are scattered across the API, the workers and the adapters, one new read path is enough to leak.

## Decision
- **The domain lives in `core` and is pure**: no I/O, no Neo4j, no HTTP, no LLM calls. Rules are functions over readonly types, like `canRead(principal, scope)`. Classes are not required; mutable state is avoided.
- **Invariants are enforced by the domain, not by callers.** A value that can exist in an invalid state (a node without scope, a derived node with a wider scope than its sources) is built through a function that refuses it.
- **Ubiquitous language.** Code uses the words of the proposals and of [the glossary](../glossary.md): `Scope`, `Principal`, `Grant`, `Provenance`, `DERIVED_FROM`, traversal, erasure. A new domain term is added to the glossary in the same pull request.
- **Ports in `core`, adapters outside.** `GraphStore`, `LLMProvider` and source adapters are interfaces declared in `core` and implemented in adapter packages, which depend only on `core`.
- **Bounded contexts**: access (scopes, rule engine, audit), knowledge (ontology, provenance), ingestion (queue, `findRelated`), exposure (REST, MCP, SSE). A context becomes its own package when it grows, not before.
- **Zod and the domain (proposal 0001).** Zod schemas validate at the boundaries; domain types are derived from them with `z.infer` when they coincide. Domain behaviour stays in plain functions, not in schemas.

## Consequences
Rules are testable without a database, and the leak tests required by proposal 0003 run against the domain directly. Tactical patterns (aggregates, repositories, factories) are used where an invariant needs them, not by default: a CLI command or an export format does not need an aggregate. A reviewer may ask for domain logic to move into `core`; a contributor may push back when the pattern adds ceremony without protecting a rule.
