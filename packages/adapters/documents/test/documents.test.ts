import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePage, readDocuments, toGraph } from "../src/index.js";

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
      references: [],
      body: "# Scopes\nSee [[traversal]], [[traversal|the walk]] and [[audit#Entries]].",
      title: "Scopes",
    });
  });

  it("takes the title field, else the first heading, else none", () => {
    expect(parsePage("a.md", "---\ntitle: ADR 7\n---\n# Heading\n").title).toBe("ADR 7");
    expect(parsePage("a.md", "Intro\n\n## Sub\n# Main title #\n").title).toBe("Main title");
    expect(parsePage("a.md", "No heading.").title).toBeUndefined();
    expect(parsePage("a.yaml", "title: Orders API\n").title).toBe("Orders API");
    const { nodes } = toGraph([parsePage("a.md", "# A page")], { source: "docs", defaultScope: { kind: "shared" } });
    expect(nodes[0]?.title).toBe("A page");
  });

  it("keeps the text as the body: below the frontmatter, or the body field of JSON and YAML", () => {
    expect(parsePage("a.md", "---\ntype: Module\n---\n\nText.\n").body).toBe("Text.");
    expect(parsePage("a.md", "---\ntype: Module\n---\n").body).toBeUndefined();
    expect(parsePage("a.json", '{"body": " Text. "}').body).toBe("Text.");
    expect(parsePage("a.yaml", "body: 3\n").body).toBeUndefined();
    const { nodes } = toGraph([parsePage("a.md", "Text.")], { source: "docs", defaultScope: { kind: "shared" } });
    expect(nodes[0]?.body).toBe("Text.");
  });

  it("accepts a page without frontmatter", () => {
    expect(parsePage("note.md", "Just [[text]].").frontmatter).toEqual({});
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
      { id: "a", type: "Concept", scope: { kind: "private", user: "me" }, provenance: { source: "docs:test", path: "a.md" }, body: "[[b]] [[c]] [[a]] [[missing]]" },
      { id: "b", type: "Source", scope: { kind: "team", team: "bff" }, provenance: { source: "docs:test", path: "b.md" }, body: "[[a]]" },
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

describe("typed references", () => {
  const pages = [
    parsePage(
      "adr.md",
      "---\ntype: decision\nreferences:\n  - { type: DECIDES, to: api }\n  - glossary\n  - { type: DERIVED_FROM, to: missing }\n---\nSee [[api]] and [[glossary]].",
    ),
    parsePage("api.md", "---\ntype: Endpoint\n---\n"),
    parsePage("glossary.md", "---\ntype: entity\n---\n"),
  ];
  const { nodes, edges } = toGraph(pages, { source: "docs:test", defaultScope: { kind: "shared" } });

  it("reads typed and bare references from the frontmatter", () => {
    expect(pages[0]?.references).toEqual([
      { type: "DECIDES", to: "api" },
      { type: "REFERENCES", to: "glossary" },
      { type: "DERIVED_FROM", to: "missing" },
    ]);
  });

  it("lets a typed reference replace the wikilink to the same target, without duplicates", () => {
    expect(edges).toEqual([
      { type: "DECIDES", from: "adr", to: "api" },
      { type: "REFERENCES", from: "adr", to: "glossary" },
    ]);
  });

  it("maps type: to a node type in any case, else Concept", () => {
    expect(nodes.map((n) => n.type)).toEqual(["Decision", "Endpoint", "Concept"]);
  });

  it("rejects an unknown edge type, naming the file", () => {
    expect(() => parsePage("bad.md", "---\nreferences:\n  - { type: LIKES, to: x }\n---\n")).toThrow(/bad\.md: invalid references/);
  });

  it("rejects references that are not a list", () => {
    expect(() => parsePage("bad.md", "---\nreferences: api\n---\n")).toThrow(/bad\.md/);
  });
});

describe("JSON and YAML documents", () => {
  it("reads the whole object as fields, with id, type, scope and references", () => {
    const json = parsePage(
      "decisions/adr-2.json",
      JSON.stringify({ id: "adr-0002", type: "Decision", scope: "team:bff", references: [{ type: "DECIDES", to: "api" }] }),
    );
    const yaml = parsePage("api.yaml", "type: endpoint\nreferences:\n  - adr-0002\n");
    expect(json).toMatchObject({ name: "adr-0002", links: [], references: [{ type: "DECIDES", to: "api" }] });
    expect(yaml).toMatchObject({ name: "api", references: [{ type: "REFERENCES", to: "adr-0002" }] });

    const { nodes, edges } = toGraph([json, yaml], { source: "docs:test", defaultScope: { kind: "shared" } });
    expect(nodes.map((n) => [n.id, n.type, n.scope])).toEqual([
      ["adr-0002", "Decision", { kind: "team", team: "bff" }],
      ["api", "Endpoint", { kind: "shared" }],
    ]);
    expect(edges).toEqual([
      { type: "DECIDES", from: "adr-0002", to: "api" },
      { type: "REFERENCES", from: "api", to: "adr-0002" },
    ]);
  });

  it("accepts .yml and an empty file", () => {
    expect(parsePage("empty.yml", "").name).toBe("empty");
  });

  it("rejects malformed documents, naming the file", () => {
    expect(() => parsePage("bad.json", "{ nope")).toThrow(/bad\.json: invalid JSON/);
    expect(() => parsePage("bad.yaml", "a: [")).toThrow(/bad\.yaml: invalid YAML/);
    expect(() => parsePage("list.yaml", "- a\n- b\n")).toThrow(/list\.yaml: a document must be an object/);
    expect(() => parsePage("id.json", '{ "id": 3 }')).toThrow(/id\.json: id must be/);
    expect(() => parsePage("notes.txt", "")).toThrow(/notes\.txt: unsupported/);
  });
});

describe("readDocuments across formats", () => {
  it("reads Markdown, JSON and YAML files and ignores the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "docs-"));
    await writeFile(join(dir, "a.md"), "[[b]]");
    await writeFile(join(dir, "b.json"), '{ "references": ["c"] }');
    await writeFile(join(dir, "c.yml"), "type: concept\n");
    await writeFile(join(dir, "d.txt"), "ignored");
    const { nodes, edges } = await readDocuments(dir, { source: "docs:test", defaultScope: { kind: "shared" } });
    expect(nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(edges).toHaveLength(2);
  });
});
