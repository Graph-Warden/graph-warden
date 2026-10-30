import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSource, createIngester, createWriter, extractWith, formatScope, type RepositoryConfig } from "@graph-warden/core";
import { createGitRepository } from "@graph-warden/git";
import { createMemoryEventLog, createMemoryIngestionState, createMemoryStore } from "@graph-warden/memory";
import { createDocumentExtractor, readDocuments } from "../src/index.js";

// Issue #18: Markdown, JSON and YAML documents pass the source conformance suite, with scopes
// from frontmatter, from folder files, and private to the ingesting user otherwise.

const files = new Map([
  ["README.md", "# Handbook\nSee [[onboarding]] and [[pay]]."],
  ["team/onboarding.md", "---\nscope: shared\n---\n# Onboarding\nAsk [[pay]]."],
  ["team/.gwarden.yaml", "scope: team:people\n"],
  ["team/pay.md", "# Pay\nMonthly."],
  ["team/hr/.gwarden.yaml", "scope: teams:people,legal\n"],
  ["team/hr/cases.yaml", "id: cases\ntitle: Cases\nreferences: [pay]\n"],
  ["notes/ideas.json", '{"id": "ideas", "body": "Undeclared, and no folder file."}'],
]);

async function write(dir: string, given: ReadonlyMap<string, string>) {
  for (const [path, text] of given) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

describe("readDocuments", () => {
  it("passes the source conformance suite", async () => {
    const violations = await checkSource({
      source: "docs:handbook",
      files,
      extract: async (given) => {
        const dir = await mkdtemp(join(tmpdir(), "gw-docs-"));
        try {
          await write(dir, given);
          return await readDocuments(dir, { source: "docs:handbook", defaultScope: { kind: "private", user: "lea" } });
        } finally {
          await rm(dir, { recursive: true });
        }
      },
      undeclared: ["README", "ideas"],
      defaultScope: { kind: "private", user: "lea" },
    });
    expect(violations).toEqual([]);
  });

  it("takes the scope of the nearest folder file, the document's own first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-docs-"));
    await write(dir, files);
    const { nodes } = await readDocuments(dir, { source: "docs:handbook", defaultScope: { kind: "private", user: "lea" } });
    expect(Object.fromEntries(nodes.map((node) => [node.id, formatScope(node.scope)]))).toEqual({
      README: "private:lea",
      onboarding: "shared",
      pay: "team:people",
      cases: "teams:legal,people",
      ideas: "private:lea",
    });
    await rm(dir, { recursive: true });
  });

  it("refuses a folder file it cannot read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-docs-"));
    await write(dir, new Map([["a/.gwarden.yaml", "scope: everyone\n"], ["a/x.md", "x"]]));
    await expect(readDocuments(dir, { source: "d", defaultScope: { kind: "shared" } })).rejects.toThrow(/a\/.gwarden.yaml/);
    await rm(dir, { recursive: true });
  });
});

const repo: RepositoryConfig = { name: "github:acme/handbook", scope: { kind: "team", team: "staff" }, author: { user: "ci", teams: ["staff", "people", "legal"] } };

describe("createDocumentExtractor", () => {
  it("passes the source conformance suite", async () => {
    const violations = await checkSource({
      source: repo.name,
      files,
      extract: extractWith(createDocumentExtractor(), repo),
      undeclared: ["README", "ideas"],
      defaultScope: repo.scope,
    });
    expect(violations).toEqual([]);
  });

  it("scopes again every document below a folder file a commit changes or removes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-docs-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ci@example.com");
    git("config", "user.name", "ci");
    const commit = async (change: () => Promise<void>) => {
      await change();
      git("add", "-A");
      git("commit", "-q", "-m", "change");
      return git("rev-parse", "HEAD");
    };
    const store = createMemoryStore();
    const ingester = createIngester({
      store,
      writer: createWriter(store, createMemoryEventLog()),
      state: createMemoryIngestionState(),
      repositories: new Map([[repo.name, { config: repo, repository: createGitRepository(dir) }]]),
      extractors: [createDocumentExtractor()],
    });
    const scopes = async () => Object.fromEntries([...(await store.snapshot()).nodes.values()].filter((n) => n.type !== "Change").map((n) => [n.id, formatScope(n.scope)]));

    await ingester.ingest(repo.name, await commit(() => write(dir, files)));
    expect(await scopes()).toMatchObject({ pay: "team:people", cases: "teams:legal,people", README: "team:staff" });

    // Only the folder file changes: the documents below it are scoped again.
    await ingester.ingest(repo.name, await commit(() => writeFile(join(dir, "team/.gwarden.yaml"), "scope: private:lea\n")));
    expect(await scopes()).toMatchObject({ pay: "private:lea", cases: "teams:legal,people", onboarding: "shared" });

    // Removed: they fall back to the repository's scope, the nearer folder file still applying.
    await ingester.ingest(repo.name, await commit(() => rm(join(dir, "team/.gwarden.yaml"))));
    expect(await scopes()).toMatchObject({ pay: "team:staff", cases: "teams:legal,people", onboarding: "shared" });
    await rm(dir, { recursive: true });
  });
});
