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

## Design: domain-driven, preferred

We favour domain-driven design ([ADR 0009](docs/adr/0009-domain-driven-design.md)):

- Domain rules live in `core` as pure functions over readonly types: no I/O, no database, no HTTP.
- Invariants are enforced where values are built, not checked by each caller.
- Use the words of the [glossary](docs/glossary.md) in code; add new domain terms to it in the same PR.
- Infrastructure goes behind a port declared in `core` (`GraphStore`, `LLMProvider`) and implemented in an adapter package.

It is a preference, not a ritual: no aggregate or repository where no invariant needs one.

## Commits and pull requests

- **[Conventional Commits](https://www.conventionalcommits.org/) are mandatory**, for every commit and for the PR title (it becomes the commit message on squash merge): `feat(core): …`, `fix(worker): …`, `docs: …`. Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, `style`. A breaking change takes `!` (`feat(api)!: …`) or a `BREAKING CHANGE:` footer. CI rejects the PR otherwise; check locally with `git log -1 --format=%B | pnpm commitlint`.
- **Tests run on every PR** (typecheck, lint, test) and must pass before merge. A behaviour change comes with a test; a bug fix comes with the test that reproduced it.
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
