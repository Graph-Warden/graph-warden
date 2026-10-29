# 0007 — Pluggable LLM provider and MCP clients

Stage: accepted

## Decision
- One `LLMProvider` interface with two first implementations: Anthropic, and OpenAI-compatible (covers Ollama, vLLM, LM Studio, Mistral, Azure OpenAI, OpenAI). Chosen by configuration (`provider`, `model`, `baseUrl`).
- Later: routing by sensitivity. A source marked confidential is processed only by a local model and never leaves the network; the rule is declared per source and recorded in the audit log.
- Consumers: any MCP client, plus REST.

## Consequences
Prompts must be evaluated on at least one local model, not only on a frontier model. A shared extraction evaluation set runs against every provider and the gap is measured.
