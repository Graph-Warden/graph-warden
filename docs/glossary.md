# Glossary

The words below are used with this meaning in code, proposals, issues and reviews (see [proposal 0009](proposals/0009-domain-driven-design.md)). Add a term in the same pull request that introduces it.

| Term | Meaning |
|---|---|
| Node | A unit of knowledge in the graph (file, endpoint, decision, note). Has exactly one scope and a provenance. |
| Edge | A typed relation between two nodes (`IMPORTS`, `CONSUMES`, `DERIVED_FROM`…). |
| Ontology | The closed set of node types (`Source`, `Decision`, `Concept`…) and edge types a graph accepts. Extensible by configuration, never by writing an unknown type. |
| Scope | Who may see a node: `shared`, `team:<x>`, `teams:<x>,<y>` (members of every listed team) or `private:<user>`. |
| Principal | The identity a read is made for: a user and their teams, as the identity provider reports them (nested groups resolved). |
| Grant | A right held by a principal that covers a scope. |
| Provenance | Where a node comes from: source, path, commit sha. |
| Derived node | A node produced from others, typically by an LLM. Linked with `DERIVED_FROM`; read only by those who read every source (proposal 0010). |
| Author | The principal a node is derived for. Must be able to read every source. |
| Traversal | Walking edges from a node. Scopes are checked on every hop, not only on the result. |
| Erasure | Removal of a source and of everything derived from it (`gwarden forget`). |
| Audit entry | A record of a read made on behalf of a user. |
| Audit log | The append-only port (`AuditLog`) holding audit entries in write order. Itself sensitive: it says who saw what. |
| Reader | The only way to read the graph on behalf of a principal (`createReader`): applies the scopes, then writes the audit entry before returning the result. |
| Port | An interface declared in `core` (`GraphStore`, `AuditLog`, `LLMProvider`). |
| Adapter | A package that implements a port for a concrete technology. |
| Graph store | The port (`GraphStore`) that persists nodes and edges. Stores never filter by scope; the domain does. |
