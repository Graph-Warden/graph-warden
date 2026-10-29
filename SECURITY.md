# Security policy

Graph-Warden's job is to keep people and agents from reading what they should not. Any way around that is a vulnerability, including:

- reading a node, an edge, a node id or a count outside your scopes, through REST, MCP, SSE, `pull` or exports;
- inferring hidden nodes through traversal results, errors, timings or pagination;
- derived knowledge that survives `forget` on its source;
- audit entries that can be skipped or forged.

## Reporting

**Do not open a public issue.** Use GitHub's private reporting: [Report a vulnerability](https://github.com/Graph-Warden/graph-warden/security/advisories/new).

You can expect an acknowledgement within 5 working days. We will agree on a disclosure date with you and credit you unless you prefer otherwise.

## Supported versions

Pre-1.0: only the latest release receives fixes.
