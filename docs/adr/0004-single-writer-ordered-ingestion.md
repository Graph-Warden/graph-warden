# 0004 — One writer for shared nodes, ordered idempotent ingestion

Status: Accepted

## Context
Four teams merge into the same `main`. Concurrent ingestion must not corrupt or duplicate shared knowledge.

## Decision
- Only the merge-on-`main` pipeline writes `shared` nodes. Teams never edit them; they attach nodes in their own scope through edges.
- The ingestion queue is serialised per repository, in commit order. `main` is linear, so git order resolves conflicts.
- Writes are idempotent on `(repo, path, sha)`: replaying a webhook or resuming after a crash creates no duplicates.
- Nodes are versioned per commit, so the graph can answer "what did this module look like at the time of the incident".
