# Contributing to Graph-Warden

Thanks for helping. This project is about access control, so one rule comes before all others: **a change that can expose a node, an event, an id or a count to someone outside its scope is a bug**, and it needs a test that proves it cannot.

## Where to start

- Issues labelled `good first issue` are scoped to a few hours and have a clear definition of done.
- Adapters (`adapter` label) are self-contained: implement the interface, pass the shared conformance suite, done.
- For anything larger, comment on the issue or open one first, so we agree on the approach before you write code. Architectural changes need an ADR in `docs/adr`.

## Setup

Node 22+ (see `.nvmrc`) and pnpm via corepack:

```sh
corepack enable
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

## Rules for code

- TypeScript strict, no `any`, no non-null assertions. Zod schemas are the single source of truth for types that cross a boundary (API, MCP tools, LLM output, config).
- Tests next to the package, in `packages/<name>/test`. Access-rule changes come with a test that tries to leak and fails to.
- Keep packages independent: `core` depends on nothing internal; adapters depend only on `core`.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/) for PR titles: `feat(core): …`, `fix(worker): …`, `docs: …`.
- If a published package changes, add a changeset: `pnpm changeset`.
- Small PRs get reviewed faster than large ones.

### Sign your commits

We use the [Developer Certificate of Origin](https://developercertificate.org/). Add a sign-off to every commit:

```sh
git commit -s -m "feat(core): add Endpoint node type"
```

CI rejects pull requests with unsigned commits. To fix the last commit: `git commit --amend -s --no-edit`.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
