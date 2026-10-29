import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePage, parseScope, readDocuments, toGraph } from "../src/index.js";

describe("parsePage", () => {
  it("reads the frontmatter and the wikilinks, without aliases, headings or duplicates", () => {
    const page = parsePage(
      "concepts/scopes.md",
      "---\ntheme: dev\ntags: [a, b]\n---\n# Scopes\nSee [[traversal]], [[traversal|the walk]] and [[audit#Entries]].\n",
    );
    expect(page).toEqual({
      name: "scopes",
      path: "concepts/scopes.md",
      frontmatter: { theme: "dev", tags: ["a", "b"] },
      links: ["traversal", "audit"],
    });
  });

  it("accepts a page without frontmatter", () => {
    expect(parsePage("note.md", "Just [[text]].").frontmatter).toEqual({});
  });
});

describe("parseScope", () => {
  it("reads the three scope forms", () => {
    expect(parseScope("shared")).toEqual({ kind: "shared" });
    expect(parseScope("team:bff")).toEqual({ kind: "team", team: "bff" });
    expect(parseScope("private:alice")).toEqual({ kind: "private", user: "alice" });
  });

  it("rejects anything else", () => {
    expect(() => parseScope("public")).toThrow();
    expect(() => parseScope("team:")).toThrow();
  });
});

describe("toGraph", () => {
  const pages = [
    parsePage("a.md", "---\ntheme: dev\n---\n[[b]] [[c]] [[a]] [[missing]]"),
    parsePage("b.md", "---\ntheme: dev\ntype: source\nscope: team:bff\n---\n[[a]]"),
    parsePage("c.md", "---\ntheme: perso\n---\n[[a]]"),
  ];
  const options = { source: "docs:test", defaultScope: { kind: "private", user: "me" } as const, include: (page: { frontmatter: Record<string, unknown> }) => page.frontmatter.theme === "dev" };

  it("keeps only the included pages, with their type, scope and provenance", () => {
    const { nodes } = toGraph(pages, options);
    expect(nodes).toEqual([
      { id: "a", type: "Concept", scope: { kind: "private", user: "me" }, provenance: { source: "docs:test", path: "a.md" } },
      { id: "b", type: "Source", scope: { kind: "team", team: "bff" }, provenance: { source: "docs:test", path: "b.md" } },
    ]);
  });

  it("drops self-links and links to pages that were not read", () => {
    expect(toGraph(pages, options).edges).toEqual([
      { type: "REFERENCES", from: "a", to: "b" },
      { type: "REFERENCES", from: "b", to: "a" },
    ]);
  });

  it("uses the default scope for pages without one", () => {
    const { nodes } = toGraph(pages.slice(0, 1), { source: "docs:test", defaultScope: { kind: "private", user: "me" } });
    expect(nodes[0]?.scope).toEqual({ kind: "private", user: "me" });
  });
});

describe("readDocuments", () => {
  it("reads every Markdown file under the directory, recursively", async () => {
    const dir = await mkdtemp(join(tmpdir(), "docs-"));
    await mkdir(join(dir, "concepts"));
    await writeFile(join(dir, "index.md"), "[[scopes]]");
    await writeFile(join(dir, "concepts", "scopes.md"), "[[index]]");
    await writeFile(join(dir, "image.png"), "");
    const { nodes, edges } = await readDocuments(dir, { source: "docs:test", defaultScope: { kind: "shared" } });
    expect(nodes.map((n) => n.provenance.path)).toEqual(["concepts/scopes.md", "index.md"]);
    expect(edges).toHaveLength(2);
  });
});
