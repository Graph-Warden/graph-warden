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
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
  },
});
