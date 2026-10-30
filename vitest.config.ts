import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the sources of workspace packages, not their build output.
    alias: {
      "@graph-warden/core": source("packages/core/src/index.ts"),
      "@graph-warden/documents": source("packages/adapters/documents/src/index.ts"),
      "@graph-warden/neo4j": source("packages/adapters/neo4j/src/index.ts"),
      "@graph-warden/memory": source("packages/adapters/memory/src/index.ts"),
      "@graph-warden/git": source("packages/adapters/git/src/index.ts"),
      "@graph-warden/redis": source("packages/adapters/redis/src/index.ts"),
      "@graph-warden/typescript": source("packages/adapters/typescript/src/index.ts"),
      "@graph-warden/openapi": source("packages/adapters/openapi/src/index.ts"),
      "@graph-warden/gitlab": source("packages/adapters/gitlab/src/index.ts"),
      "@graph-warden/jira": source("packages/adapters/jira/src/index.ts"),
      "@graph-warden/confluence": source("packages/adapters/confluence/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
  },
});
