# 0005 — Targeted ingestion, like `jest --findRelatedTests`

Stage: accepted

## Decision
1. Changed files: `git diff --name-status <last ingested sha>..<sha>`, including renames and deletions. Starting from the last ingested sha makes recovery automatic, like `--changedSince`.
2. Dependency graph: `Module -IMPORTS-> Module` edges, built by the TypeScript compiler (tree-sitter for other languages) and updated on the same merge.
3. Reverse traversal from changed modules through `IMPORTS`, then `DERIVED_FROM`, `DECIDES`, `EXPOSES`, `CONSUMES`, gives the set of nodes to revalidate.
4. Only that set is sent to the LLM, which answers: still valid, updated, or contradicted (`CONTRADICTS` edge plus an alert).

- HTTP dependencies are invisible to imports, so `Endpoint` nodes and `CONSUMES` edges come from OpenAPI specs and generated clients.
- Heavily imported modules would invalidate half the graph. Traversal depth is bounded; beyond it nodes are only marked stale and recompiled on first read.
- **Dry-run on a pull request**: the same analysis, without writing, produces an impact comment on the PR.
