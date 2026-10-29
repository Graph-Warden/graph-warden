# 0002 — One graph, scoped views per team

Stage: in progress

## Context
Example: four teams (one BFF, three front-ends) share one repository and also have their own docs and agent sessions.

## Decision
One graph. Every node has exactly one scope: `shared`, `team:<name>` or `private:<user>`. A team's "brain" is the view `shared + team:<name>` (+ the reader's private nodes). Teams come from OIDC groups or GitHub teams.

Physically separate databases per team remain a deployment option for legal isolation, not the default.

## Consequences
No duplication of the shared repository, and cross-team questions (impact analysis) are plain traversals. The price is that access must be enforced on every read path — see 0003.
