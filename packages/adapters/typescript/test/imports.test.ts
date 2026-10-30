import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIngester, createWriter, type GraphStore, type RepositoryConfig } from "@graph-warden/core";
import { createGitRepository } from "@graph-warden/git";
import { createMemoryEventLog, createMemoryIngestionState, createMemoryStore } from "@graph-warden/memory";
import { createTypeScriptExtractor, moduleId } from "../src/index.js";

// Issue #6: on the demo repository, the IMPORTS edges are the resolutions `tsc --traceResolution`
// reports, for every project of the repository.

const demo = fileURLToPath(new URL("../../../../examples/shop/repo", import.meta.url));
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const config: RepositoryConfig = { name: "github:acme/shop", scope: { kind: "shared" }, author: { user: "ci", teams: [] } };

let dir: string;
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const commit = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

function setup(): { store: GraphStore; ingest: (sha: string) => Promise<unknown> } {
  const store = createMemoryStore();
  const ingester = createIngester({
    store,
    writer: createWriter(store, createMemoryEventLog()),
    state: createMemoryIngestionState(),
    repositories: new Map([[config.name, { config, repository: createGitRepository(dir) }]]),
    extractors: [createTypeScriptExtractor()],
  });
  return { store, ingest: (sha) => ingester.ingest(config.name, sha) };
}

const imports = async (store: GraphStore) =>
  (await store.snapshot()).edges
    .filter((edge) => edge.type === "IMPORTS")
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .sort();

// What tsc resolves, file to file inside the repository, for each tsconfig. Workspace packages are
// linked into node_modules as pnpm would.
function traced(): string[] {
  for (const app of ["front-a", "front-b"]) {
    mkdirSync(join(dir, "apps", app, "node_modules", "@shop"), { recursive: true });
    symlinkSync(join(dir, "packages", "api-client"), join(dir, "apps", app, "node_modules", "@shop", "api-client"));
  }
  const pairs = new Set<string>();
  for (const project of ["apps/bff", "apps/front-a", "apps/front-b", "apps/front-c", "packages/api-client"]) {
    const out = execFileSync(process.execPath, [tsc, "-p", join(dir, project, "tsconfig.json"), "--traceResolution", "--noEmit"], { encoding: "utf8" });
    let from = "";
    for (const line of out.split("\n")) {
      const resolving = /^======== Resolving module '.*' from '(.*)'\. ========$/.exec(line);
      if (resolving !== null) from = resolving[1] ?? "";
      const resolved = /^======== Module name '.*' was successfully resolved to '(.*)'\. ========$/.exec(line);
      if (resolved !== null && !(resolved[1] ?? "").includes("node_modules")) {
        pairs.add(`${moduleId(config.name, relative(dir, from))} -> ${moduleId(config.name, relative(dir, resolved[1] ?? ""))}`);
      }
    }
  }
  return [...pairs].sort();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gwarden-ts-"));
  cpSync(demo, dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.com");
  git("config", "user.name", "CI");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("TypeScript imports", () => {
  it("gives the edges tsc resolves, through path aliases and workspace packages", async () => {
    const { store, ingest } = setup();
    await ingest(commit("demo"));
    const edges = await imports(store);
    expect(edges).toEqual(traced());
    const id = (path: string) => moduleId(config.name, path);
    expect(edges).toEqual(
      expect.arrayContaining([
        `${id("apps/front-a/src/checkout.ts")} -> ${id("packages/api-client/src/index.ts")}`,
        `${id("apps/front-a/src/checkout.ts")} -> ${id("apps/front-a/src/format.ts")}`,
        `${id("apps/bff/src/server.ts")} -> ${id("apps/bff/src/routes/recommendations.ts")}`,
      ]),
    );
  });

  it("replaces the imports of a changed file, and follows a changed tsconfig everywhere", async () => {
    const { store, ingest } = setup();
    await ingest(commit("demo"));
    const id = (path: string) => moduleId(config.name, path);
    writeFileSync(join(dir, "apps/front-b/src/orders-table.ts"), 'import { getOrder } from "@shop/api-client";\nexport const show = getOrder;\n');
    await ingest(commit("front-b: no refunds"));
    expect(await imports(store)).toContain(`${id("apps/front-b/src/orders-table.ts")} -> ${id("packages/api-client/src/index.ts")}`);

    // Point the alias elsewhere: checkout.ts did not change, its import now resolves to nothing.
    writeFileSync(join(dir, "apps/front-a/tsconfig.json"), '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["lib/*"] } }, "include": ["src"] }\n');
    await ingest(commit("front-a: move the alias"));
    const edges = await imports(store);
    expect(edges).not.toContain(`${id("apps/front-a/src/checkout.ts")} -> ${id("apps/front-a/src/format.ts")}`);
    expect(edges).toContain(`${id("apps/front-a/src/checkout.ts")} -> ${id("packages/api-client/src/index.ts")}`);
  });

  it("removes the module of a deleted file", async () => {
    const { store, ingest } = setup();
    await ingest(commit("demo"));
    git("rm", "-q", "apps/front-a/src/format.ts");
    await ingest(commit("drop format"));
    const graph = await store.snapshot();
    expect(graph.nodes.has(moduleId(config.name, "apps/front-a/src/format.ts"))).toBe(false);
  });
});
