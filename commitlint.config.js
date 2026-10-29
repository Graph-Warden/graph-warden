// Conventional Commits, enforced in CI on every commit of a pull request and on its title
// (the title becomes the commit message on squash merge). Scope is free but lowercase:
// a package (`core`, `api`, `worker`, `mcp`, `cli`, `web`) or an area (`adr`, `ci`, `deps`).
export default {
  extends: ["@commitlint/config-conventional"],
};
