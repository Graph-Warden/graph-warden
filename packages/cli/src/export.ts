import { createHash } from "node:crypto";
import { formatScope, type Edge, type Node } from "@graph-warden/core";

// Exports of the graph a user may read (issues #22, #23): whatever a pull from scratch through the
// API returned, so an export is a read like any other, scoped and audited by the API. Nothing here
// reads anything else: every node and edge written was in that pull, and a pull's edges only join
// nodes it sends.

export type Format = "markdown" | "jsonld" | "graphml";

// A file name per node: the id, with every character unsafe in a path replaced, and a short hash
// when that changed it, so that two ids never share a file.
export function fileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return safe === id ? `${id}.md` : `${safe}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}.md`;
}

const yamlString = (value: string) => JSON.stringify(value);

// One Markdown file per node: its fields as frontmatter, its text, then its edges as links to the
// files of the nodes they join.
export function toMarkdown(nodes: readonly Node[], edges: readonly Edge[]): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const files = new Map<string, string>();
  for (const node of nodes) {
    const { provenance } = node;
    const lines = [
      "---",
      `id: ${yamlString(node.id)}`,
      `type: ${node.type}`,
      ...(node.title === undefined ? [] : [`title: ${yamlString(node.title)}`]),
      `scope: ${yamlString(formatScope(node.scope))}`,
      "provenance:",
      `  source: ${yamlString(provenance.source)}`,
      `  path: ${yamlString(provenance.path)}`,
      ...(provenance.sha === undefined ? [] : [`  sha: ${provenance.sha}`]),
      "---",
      "",
      ...(node.body === undefined ? [] : [node.body, ""]),
    ];
    const link = (id: string) => {
      const other = byId.get(id);
      return `[${(other?.title ?? id).replace(/[[\]]/g, "")}](${encodeURI(fileName(id))})`;
    };
    const out = edges.filter((edge) => edge.from === node.id && byId.has(edge.to));
    const into = edges.filter((edge) => edge.to === node.id && byId.has(edge.from));
    if (out.length + into.length > 0) {
      lines.push("## Links", "");
      for (const edge of out) lines.push(`- ${edge.type} → ${link(edge.to)}`);
      for (const edge of into) lines.push(`- ${edge.type} ← ${link(edge.from)}`);
      lines.push("");
    }
    files.set(fileName(node.id), lines.join("\n"));
  }
  return files;
}

export const NAMESPACE = "https://graph-warden.github.io/ns#";
export const nodeIri = (id: string): string => `urn:graph-warden:node:${encodeURIComponent(id)}`;

// JSON-LD: each node an object of its type, each edge type a property linking to node IRIs.
export function toJsonLd(nodes: readonly Node[], edges: readonly Edge[]): object {
  const edgeTypes = [...new Set(edges.map((edge) => edge.type))];
  return {
    "@context": {
      "@vocab": NAMESPACE,
      title: "http://purl.org/dc/terms/title",
      body: `${NAMESPACE}body`,
      scope: `${NAMESPACE}scope`,
      source: `${NAMESPACE}source`,
      path: `${NAMESPACE}path`,
      sha: `${NAMESPACE}sha`,
      ...Object.fromEntries(edgeTypes.map((type) => [type, { "@id": `${NAMESPACE}${type}`, "@type": "@id" }])),
    },
    "@graph": nodes.map((node) => {
      const linked = new Map<string, string[]>();
      for (const edge of edges) if (edge.from === node.id) linked.set(edge.type, [...(linked.get(edge.type) ?? []), nodeIri(edge.to)]);
      return {
        "@id": nodeIri(node.id),
        "@type": node.type,
        ...(node.title === undefined ? {} : { title: node.title }),
        ...(node.body === undefined ? {} : { body: node.body }),
        scope: formatScope(node.scope),
        source: node.provenance.source,
        path: node.provenance.path,
        ...(node.provenance.sha === undefined ? {} : { sha: node.provenance.sha }),
        ...Object.fromEntries(linked),
      };
    }),
  };
}

// Control characters other than tab and newlines are not allowed in XML 1.0, even escaped.
const allowed = (char: string) => char >= " " || char === "\t" || char === "\n" || char === "\r";
const xml = (value: string) =>
  [...value]
    .filter(allowed)
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// GraphML, for Gephi or yEd: node fields and edge types as declared keys.
export function toGraphML(nodes: readonly Node[], edges: readonly Edge[]): string {
  const keys = [
    ["type", "node"],
    ["title", "node"],
    ["scope", "node"],
    ["source", "node"],
    ["path", "node"],
    ["sha", "node"],
    ["body", "node"],
    ["label", "edge"],
  ] as const;
  const data = (key: string, value: string | undefined) => (value === undefined ? [] : [`      <data key="${key}">${xml(value)}</data>`]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '    xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
    ...keys.map(([name, domain]) => `  <key id="${name}" for="${domain}" attr.name="${name}" attr.type="string"/>`),
    '  <graph id="graph-warden" edgedefault="directed">',
    ...nodes.flatMap((node) => [
      `    <node id="${xml(node.id)}">`,
      ...data("type", node.type),
      ...data("title", node.title),
      ...data("scope", formatScope(node.scope)),
      ...data("source", node.provenance.source),
      ...data("path", node.provenance.path),
      ...data("sha", node.provenance.sha),
      ...data("body", node.body),
      "    </node>",
    ]),
    ...edges.flatMap((edge, i) => [`    <edge id="e${i}" source="${xml(edge.from)}" target="${xml(edge.to)}">`, ...data("label", edge.type), "    </edge>"]),
    "  </graph>",
    "</graphml>",
    "",
  ].join("\n");
}
