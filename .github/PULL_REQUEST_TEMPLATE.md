## What and why

<!-- One or two sentences. Link the issue: Closes #123 -->

## How it was verified

<!-- Tests added, commands run, screenshots for the web UI. -->

## Checklist

- [ ] Title and every commit follow Conventional Commits (`feat(core): …`, `fix(api): …`)
- [ ] Commits are signed off (`git commit -s`)
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass, and new behaviour is covered by a test
- [ ] Domain rules live in `core`, use the glossary (`docs/glossary.md`) terms, and new terms are added to it
- [ ] Access rules: if this touches reads, traversal, events or exports, a test proves no out-of-scope node or id leaks
- [ ] A changeset is included if a published package changes (`pnpm changeset`)
