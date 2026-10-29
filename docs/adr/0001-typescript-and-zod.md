# 0001 — TypeScript strict, Zod as the single source of types

Status: Accepted

## Context
The graph is typed: node and edge types carry required properties, including `scope` and `provenance`. Types cross many boundaries: REST, MCP tool schemas, LLM structured output, configuration.

## Decision
- TypeScript with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, in a pnpm monorepo.
- Every boundary type is a Zod schema. TS types, runtime validation, MCP JSON Schema and OpenAPI are derived from it.
- The ontology is closed by default and extensible by configuration (an organisation can add `Microservice` without forking).
- LLM output that fails the schema is rejected and retried, never written as-is. Neo4j constraints back the schema in the database.

## Consequences
One language across API, MCP server, workers and CLI. Non-TS code analysis goes through tree-sitter adapters.
