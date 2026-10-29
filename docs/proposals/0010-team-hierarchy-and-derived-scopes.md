# 0010 — Teams form a tree; derived nodes take the nearest common team

Stage: to be reviewed

## Context
Proposal 0002 gives every node one scope and says a derived node takes "the most restrictive scope of its sources". With flat teams that rule has no answer for a summary built from a `team:bff` page and a `team:front` page: neither scope is narrower than the other, and no single scope means "readers of both".

Companies are not flat. A department sees what its teams produce; a team sees its own work.

## Decision
- **Teams form a tree**, declared as an organisation chart: each team names its parent, or none. A team reads its own nodes and those of every team below it; a team below reads only its own. A team missing from the chart is a top-level team with nothing below it, so an empty chart is the flat model of 0002.
- **The hierarchy is resolved into the principal**: a user's teams become every team they may read (their teams and all teams below them). `canRead` and the per-hop traversal stay unchanged, and so does the non-interference test.
- **A derived node's scope** (`DERIVED_FROM`) is computed from its sources on behalf of the author, the principal it is derived for:
  - `shared` adds no restriction;
  - two teams give their nearest common ancestor: whoever reads it reads both, by construction of the tree. Teams with no common ancestor give `private:<author>`;
  - anything private gives `private:<author>`;
  - the node's own declared scope counts as one more source, so derivation never widens it.
- **Nobody derives from what they cannot read**: the author must read every source, or the derivation is refused. A declared scope private to someone other than the author is refused too.
- Chains of derivation are followed; a cycle of `DERIVED_FROM` is refused.

## Consequences
- The nearest common ancestor is narrower than the exact set of readers of all sources: someone in both `bff` and `front` but not in `dev` loses access to the summary. The error goes the safe way.
- The author may end up unable to read what they derived (`front-a` and `front-b` member, summary in their parent `front` they are not in). A chain of derivation through such a node is refused for that author.
- A node private to its author keeps what the author read even after they leave a team, as any copy they made would.
- Rights that do not follow the tree (an audit team reading every team) are a separate mechanism, not covered here.
- Scopes are derived at ingestion. When a source's scope or the chart changes later, derived nodes must be revalidated; that belongs with `findRelated` (proposal 0005).
- Teams and their parents will come from the identity provider (OIDC groups, GitHub nested teams); until the API exists, the CLI reads a YAML file (`--org`, `GWARDEN_ORG`).
