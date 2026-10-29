# 0006 — Pull and SSE, not WebSocket, no inbound ports

Stage: accepted

## Context
Large organisations forbid tunnels such as ngrok and many proxies break WebSocket upgrades.

## Decision
- An append-only **event log** with a monotonic sequence number is the single basis for sync, audit and replay. Events are filtered by the subscriber's scopes **before sending**, deletions included: a client never receives the id of a node it may not see.
- **Pull**: `gwarden pull` fetches the delta since the client's cursor into a local SQLite cache restricted to the client's scopes (offline use, fast agent context).
- **Push**: Server-Sent Events. Plain HTTP, native reconnection, `Last-Event-ID` resumes at the right cursor. Fallback: `gwarden pull --watch` polling.
- **Inbound ingestion** without exposing anything: GitHub webhook if the service has public ingress; otherwise a GitHub Action on a self-hosted runner pushing from inside the network; otherwise `git fetch` polling.

WebSocket would only be justified by collaborative editing, which is out of scope.
