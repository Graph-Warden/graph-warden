# Glossary

The words below are used with this meaning in code, ADRs, issues and reviews (see [ADR 0009](adr/0009-domain-driven-design.md)). Add a term in the same pull request that introduces it.

| Term | Meaning |
|---|---|
| Node | A unit of knowledge in the graph (file, endpoint, decision, note). Has exactly one scope and a provenance. |
| Edge | A typed relation between two nodes (`IMPORTS`, `CONSUMES`, `DERIVED_FROM`…). |
| Ontology | The closed set of node types (`Source`, `Decision`, `Concept`…) and edge types a graph accepts. Extensible by configuration, never by writing an unknown type. |
| Scope | Who may see a node: `shared`, `team:<x>` or `private:<user>`. |
| Principal | The identity a read is made for: a user and their teams. |
| Grant | A right held by a principal that covers a scope. |
| Provenance | Where a node comes from: source, path, commit sha. |
| Derived node | A node produced from others, typically by an LLM. Linked with `DERIVED_FROM`; takes the most restrictive scope of its sources. |
| Traversal | Walking edges from a node. Scopes are checked on every hop, not only on the result. |
| Erasure | Removal of a source and of everything derived from it (`gwarden forget`). |
| Audit entry | A record of a read made on behalf of a user. |
| Port | An interface declared in `core` (`GraphStore`, `LLMProvider`). |
| Adapter | A package that implements a port for a concrete technology. |
