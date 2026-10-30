import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import jsonld from "jsonld";
import {
  canRead,
  CORE_ONTOLOGY,
  createGraph,
  createReader,
  createWriter,
  deriveScopes,
  type Edge,
  type Node,
  type Principal,
} from "@graph-warden/core";
import { readDocuments } from "@graph-warden/documents";
import { createMemoryAuditLog, createMemoryEventLog, createMemoryStore } from "@graph-warden/memory";
import { fileName, nodeIri, toGraphML, toJsonLd, toMarkdown } from "../src/export.js";

const nodes: Node[] = [
  {
    id: "adr-0001",
    type: "Decision",
    title: "Use Neo4j",
    body: "Because <graphs> & \"paths\".\u0007",
    scope: { kind: "shared" },
    provenance: { source: "docs:core", path: "adr/0001.md", sha: "abc123" },
  },
  {
    id: "github:acme/shop:src/a.ts",
    type: "Module",
    scope: { kind: "team", team: "payments" },
    provenance: { source: "github:acme/shop", path: "src/a.ts" },
  },
  { id: "../etc/passwd", type: "Document", title: "Odd [id]", scope: { kind: "shared" }, provenance: { source: "docs:core", path: "x.md" } },
];
const edges: Edge[] = [
  { type: "DECIDES", from: "adr-0001", to: "github:acme/shop:src/a.ts" },
  { type: "REFERENCES", from: "../etc/passwd", to: "adr-0001" },
];

describe("fileName", () => {
  it("keeps a safe id and makes every other one safe and distinct", () => {
    expect(fileName("adr-0001")).toBe("adr-0001.md");
    const odd = fileName("../etc/passwd");
    expect(odd).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/);
    expect(odd).not.toContain("/");
    expect(fileName("a/b")).not.toBe(fileName("a_b"));
  });
});

describe("toMarkdown", () => {
  it("writes one file per node, with its frontmatter and links to the files of its neighbours", () => {
    const files = toMarkdown(nodes, edges);
    expect(files.size).toBe(3);
    const adr = files.get("adr-0001.md") ?? "";
    expect(adr).toContain('id: "adr-0001"');
    expect(adr).toContain('scope: "shared"');
    expect(adr).toContain("  sha: abc123");
    expect(adr).toContain("Because <graphs>");
    expect(adr).toContain(`- DECIDES → [github:acme/shop:src/a.ts](${encodeURI(fileName("github:acme/shop:src/a.ts"))})`);
    expect(adr).toContain(`- REFERENCES ← [Odd id](${encodeURI(fileName("../etc/passwd"))})`);
    // Every link points to a file of the export.
    for (const text of files.values()) {
      for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) expect(files.has(decodeURI(target ?? ""))).toBe(true);
    }
  });

  it("links nothing outside the export", () => {
    const files = toMarkdown(nodes.slice(0, 1), edges);
    expect(files.get("adr-0001.md")).not.toContain("## Links");
  });
});

describe("toJsonLd", () => {
  it("expands to the nodes and edges, as RDF", async () => {
    const doc = toJsonLd(nodes, edges);
    const quads = (await jsonld.toRDF(doc as jsonld.JsonLdDocument, { format: "application/n-quads" })) as unknown as string;
    const ns = "https://graph-warden.github.io/ns#";
    expect(quads).toContain(`<${nodeIri("adr-0001")}> <${ns}DECIDES> <${nodeIri("github:acme/shop:src/a.ts")}> .`);
    expect(quads).toContain(`<${nodeIri("adr-0001")}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${ns}Decision> .`);
    expect(quads).toContain(`<${nodeIri("adr-0001")}> <http://purl.org/dc/terms/title> "Use Neo4j" .`);
    expect(quads).toContain(`<${nodeIri("github:acme/shop:src/a.ts")}> <${ns}scope> "team:payments" .`);
    // One subject per node, and one triple per edge.
    expect(new Set(quads.trim().split("\n").map((line) => line.split(" ")[0])).size).toBe(3);
    expect(quads.split("\n").filter((line) => line.includes(`${ns}DECIDES`) || line.includes(`${ns}REFERENCES`))).toHaveLength(2);
  });
});

describe("toGraphML", () => {
  // The GraphML schema could not be fetched to validate against (graphml.graphdrawing.org is out
  // of service): this checks well-formedness and what the schema requires of a graph.
  it("is well-formed GraphML, every edge joining declared nodes and every datum a declared key", () => {
    const text = toGraphML(nodes, edges);
    expect(XMLValidator.validate(text)).toBe(true);
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: (name, _path, _leaf, attribute) => !attribute && ["key", "node", "edge", "data"].includes(name) }).parse(text);
    const { graphml } = parsed;
    expect(graphml.xmlns).toBe("http://graphml.graphdrawing.org/xmlns");
    const keys = new Map<string, string>(graphml.key.map((key: { id: string; for: string }) => [key.id, key.for]));
    const { graph } = graphml;
    expect(graph.edgedefault).toBe("directed");
    const ids = graph.node.map((node: { id: string }) => node.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain("../etc/passwd");
    for (const edge of graph.edge) {
      expect(ids).toContain(edge.source);
      expect(ids).toContain(edge.target);
      for (const datum of edge.data) expect(keys.get(datum.key)).toBe("edge");
    }
    for (const node of graph.node) for (const datum of node.data) expect(keys.get(datum.key)).toBe("node");
    const adr = graph.node.find((node: { id: string }) => node.id === "adr-0001");
    expect(adr.data.find((datum: { key: string }) => datum.key === "body")["#text"]).toBe('Because <graphs> & "paths".');
  });
});

// Issue #22: the demo, ingested as in docker-compose.yml, exported as each of its users.
describe("an export of the demo", () => {
  const lea: Principal = { user: "lea", teams: ["dev", "dev-leads", "bff", "front-a", "front-b", "front-c", "shopping-front", "user", "data"] };
  const readers: Principal[] = [lea, { user: "bob", teams: ["dev", "bff"] }, { user: "alice", teams: ["dev", "front-a"] }, { user: "nobody", teams: [] }];

  it("links only to its own files, and holds no id its user may not read", async () => {
    const docs = fileURLToPath(new URL("../../../examples/shop/docs", import.meta.url));
    const read = await readDocuments(docs, { source: "docs:shop", defaultScope: { kind: "private", user: "lea" }, ontology: CORE_ONTOLOGY });
    const store = createMemoryStore();
    const events = createMemoryEventLog();
    const writer = createWriter(store, events);
    await writer.upsertNodes(deriveScopes(createGraph(read.nodes, read.edges), lea, read.nodes.map((node) => node.id)));
    await writer.upsertEdges(read.edges);
    const audit = createMemoryAuditLog();
    const reader = createReader(store, audit, { events });
    const all = (await store.snapshot()).nodes;

    const sizes = new Set<number>();
    for (const principal of readers) {
      const { nodes, edges } = await reader.pull(principal, 0);
      const hidden = [...all.values()].filter((node) => !canRead(principal, node.scope)).map((node) => node.id);
      const files = toMarkdown(nodes, edges);
      sizes.add(files.size);
      for (const text of files.values()) {
        for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) expect(files.has(decodeURI(target ?? ""))).toBe(true);
        for (const id of hidden) expect(text).not.toMatch(new RegExp(`(^|[^\\w:-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w:-]|$)`, "m"));
      }
      for (const id of hidden) expect(files.has(fileName(id))).toBe(false);
      expect(JSON.stringify(toJsonLd(nodes, edges))).not.toMatch(new RegExp(hidden.map((id) => `"urn:graph-warden:node:${encodeURIComponent(id)}"`).join("|") || "$^"));
    }
    // Users see different parts of the graph, and each export was audited as a pull.
    expect(sizes.size).toBeGreaterThan(1);
    expect(audit.written.filter((entry) => entry.action === "pull")).toHaveLength(readers.length);
  });
});
