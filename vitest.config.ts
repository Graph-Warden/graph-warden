import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against the sources of `core`, not its build output.
    alias: { "@graph-warden/core": fileURLToPath(new URL("packages/core/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
  },
});
