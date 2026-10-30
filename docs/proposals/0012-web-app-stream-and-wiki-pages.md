# 0012 — A web app on the API, a live stream, and pages written in the browser

Stage: to be reviewed

## Context
The CLI suits developers and agents. Most readers of a knowledge base want pages: open a decision, see where it comes from, follow its links, find what derives from it. Some want the graph itself, and some want to write a page without a Git repository. All of it must keep the rules of proposals 0003 and 0010: the browser sees only what its user may read, every read is audited, derived nodes never widen.

## Decision
- **The web app is a client of the API, nothing more.** A single-page React app served by the API (`GWARDEN_WEB_DIR`), on the same origin. It holds a copy of what its user may read, pulled as the CLI does (proposal 0006), and never filters anything itself.
- **The API is the browser's backend; the browser never holds a token.** Signing in is the OIDC authorization code flow with PKCE, state and nonce, run by the API (or a demo token, in demo mode). It ends with an `HttpOnly`, `SameSite=Lax` cookie holding the ID token, encrypted with `GWARDEN_WEB_SECRET`. Each request with the cookie is resolved by the same identity provider as a bearer token: a session is exactly as valid as its token, lasts at most eight hours, and needs no session store. Writes made with the cookie must carry `x-requested-with: gwarden`, which a cross-site form cannot send and a cross-site script cannot send without a CORS preflight the API never grants.
- **Unknown and unreadable look alike.** A link to a node renders the same whether the node exists, is readable or not; its page says "not found or not readable" in both cases.
- **Changes arrive by server-sent events.** `GET /v1/stream` sends a `delta` event each time what the caller may read changes, with the cursor as event id, so a browser resumes with `Last-Event-ID`. A delta is computed only when the event log moved, and audited only when it hands the caller something: an idle tab does not fill the audit log. The caller is resolved again before each delta; a connection lasts five minutes, after which the browser reconnects and its session is checked again.
- **Wiki pages are nodes whose provenance source is `wiki`.** They are written through `PUT /v1/pages/{id}`, by members of a writer group, into a scope their author reads. An ingested node is never edited there: the next ingestion would undo the edit, so it is changed in its source. An id held by a node that is not a page, or by one the author may not read, is refused alike.
- **A save names the version it edits.** `GET /v1/nodes/{id}` returns the version as `ETag`; a save carries it in `If-Match` (or `If-None-Match: *` for a new page) and is refused with 412 if the page changed since.
- **Links follow what the author may read.** The `[[links]]` of a page become `REFERENCES` edges to the nodes its author may read, plus those it already referenced: an edit never drops a link its author cannot see, and never reveals whether an unreadable node exists.
- **The scope of a page others derive from does not change.** Their scope was computed from it (proposal 0010); a new one would not reach them.

## Consequences
- One origin, one cookie, no token in browser storage: the app needs no CORS and no token refresh logic. The price is a server secret to keep and rotate; rotating it signs everyone out.
- A writer creating a page learns that an id is taken, even by a node they may not read. That is inherent to shared ids; it reveals no content, and writers are a trusted group.
- A link to a node that does not exist yet becomes an edge only when the page is saved again after the node appears.
- The browser's copy is the user's readable graph. Past a few tens of thousands of nodes, the app will need to pull a neighbourhood rather than everything; the API already serves both.
