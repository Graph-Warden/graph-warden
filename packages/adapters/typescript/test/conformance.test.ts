import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { checkSource, extractWith, type RepositoryConfig } from "@graph-warden/core";
import { createTypeScriptExtractor, isSource, moduleId } from "../src/index.js";

// Issue #18: the import extractor passes the source conformance suite on the demo monorepo.

const demo = fileURLToPath(new URL("../../../../examples/shop/repo", import.meta.url));
const demoFiles = new Map(
  readdirSync(demo, { recursive: true, encoding: "utf8" })
    .filter((path) => !path.split("/").includes("node_modules") && /\.(?:ts|json|yaml)$/.test(path))
    .sort()
    .map((path) => [path, readFileSync(join(demo, path), "utf8")]),
);
const repo: RepositoryConfig = { name: "github:acme/shop", scope: { kind: "team", team: "dev" }, author: { user: "ci", teams: ["dev"] } };

it("passes the source conformance suite", async () => {
  const violations = await checkSource({
    source: repo.name,
    files: demoFiles,
    extract: extractWith(createTypeScriptExtractor(), repo),
    // Code declares no scope: it takes the repository's.
    undeclared: [...demoFiles.keys()].filter(isSource).map((path) => moduleId(repo.name, path)),
    defaultScope: repo.scope,
  });
  expect(violations).toEqual([]);
}, 60_000);
