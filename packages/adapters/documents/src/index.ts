import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import {
  EdgeTypeSchema,
  NodeSchema,
  NodeTypeSchema,
  parseScope,
  type Edge,
  type EdgeType,
  type Node,
  type NodeType,
  type Scope,
} from "@graph-warden/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// A folder of Markdown, JSON and YAML documents as nodes and edges. A document is a node whose id
// is its `id` field, or its file name. Its fields are the frontmatter of a Markdown page, or the
// whole object of a JSON or YAML file. Edges come from the typed `references` field and, in
// Markdown, from [[wikilinks]], which are untyped REFERENCES; a typed reference to a target
// replaces the wikilink to the same target. References to documents that were not read
// (filtered out, or missing) are dropped, so no edge dangles.

export type Frontmatter = Readonly<Record<string, unknown>>;

export interface Page {
  readonly name: string;
  readonly path: string;
  readonly frontmatter: Frontmatter;
  readonly links: readonly string[];
  readonly references: readonly Reference[];
  // The text: a Markdown page below its frontmatter, the `body` field of a JSON or YAML document.
  readonly body?: string;
}

export interface Reference {
  readonly type: EdgeType;
  readonly to: string;
}

// `- glossary` is an untyped reference; `- { type: DECIDES, to: bff-api }` a typed one.
const ReferencesSchema = z
  .array(
    z.union([
      z.string().min(1).transform((to): Reference => ({ type: "REFERENCES", to })),
      z.object({ type: EdgeTypeSchema, to: z.string().min(1) }),
    ]),
  )
  .default([]);

export interface DocumentOptions {
  // Provenance source, for example `docs:my-team`.
  readonly source: string;
  // Pages to keep; all by default.
  readonly include?: (page: Page) => boolean;
  // Scope of a page without a `scope:` frontmatter field. Required: there is no implicit default,
  // so nothing becomes visible to others unless a caller chose it (private by default is the
  // callers' rule, see the CLI).
  readonly defaultScope: Scope;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const WIKILINK = /\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g;

export const EXTENSIONS = [".md", ".json", ".yaml", ".yml"] as const;

// Parses one document; the format follows the extension of `path`.
export function parsePage(path: string, text: string): Page {
  const extension = extname(path);
  if (extension === ".md") {
    const match = FRONTMATTER.exec(text);
    const links = [...text.matchAll(WIKILINK)].map((link) => (link[1] ?? "").trim());
    const fields = match?.[1] === undefined ? {} : parse(path, "YAML", () => parseYaml(match[1] ?? ""));
    return toPage(path, fields, [...new Set(links)], text.slice(match?.[0].length ?? 0));
  }
  if (extension === ".json") return toPage(path, parse(path, "JSON", () => JSON.parse(text)), []);
  if (extension === ".yaml" || extension === ".yml") return toPage(path, parse(path, "YAML", () => parseYaml(text)), []);
  throw new Error(`${path}: unsupported document type, expected one of ${EXTENSIONS.join(", ")}`);
}

function parse(path: string, format: string, read: () => unknown): unknown {
  try {
    return read();
  } catch (error) {
    throw new Error(`${path}: invalid ${format}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function toPage(path: string, fields: unknown, links: readonly string[], text?: string): Page {
  if (fields !== null && fields !== undefined && (typeof fields !== "object" || Array.isArray(fields))) {
    throw new Error(`${path}: a document must be an object of fields`);
  }
  const frontmatter = (fields ?? {}) as Frontmatter;
  const references = ReferencesSchema.safeParse(frontmatter.references);
  if (!references.success) {
    throw new Error(`${path}: invalid references: ${z.prettifyError(references.error)}`);
  }
  const id = frontmatter.id;
  if (id !== undefined && (typeof id !== "string" || id === "")) throw new Error(`${path}: id must be a non-empty string`);
  const name = id ?? basename(path, extname(path));
  const body = (text ?? (typeof frontmatter.body === "string" ? frontmatter.body : "")).trim();
  return { name, path, frontmatter, links, references: references.data, ...(body === "" ? {} : { body }) };
}

export function toGraph(pages: readonly Page[], options: DocumentOptions): { nodes: Node[]; edges: Edge[] } {
  const kept = pages.filter(options.include ?? (() => true));
  const names = new Set(kept.map((page) => page.name));
  const nodes = kept.map((page) =>
    NodeSchema.parse({
      id: page.name,
      type: nodeType(page.frontmatter),
      scope: typeof page.frontmatter.scope === "string"
        ? parseScope(page.frontmatter.scope)
        : options.defaultScope,
      provenance: { source: options.source, path: page.path },
      ...(page.body === undefined ? {} : { body: page.body }),
    }),
  );
  const edges = kept.flatMap((page) => {
    const typed = new Set(page.references.filter((r) => r.type !== "REFERENCES").map((r) => r.to));
    const unique = new Map<string, Edge>();
    for (const { type, to } of [...page.references, ...page.links.map((to): Reference => ({ type: "REFERENCES", to }))]) {
      if (to === page.name || !names.has(to)) continue;
      if (type === "REFERENCES" && typed.has(to)) continue;
      unique.set(`${type} ${to}`, { type, from: page.name, to });
    }
    return [...unique.values()];
  });
  return { nodes, edges };
}

export async function readDocuments(dir: string, options: DocumentOptions): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const files = (await readdir(dir, { recursive: true })).filter((file) => EXTENSIONS.some((extension) => file.endsWith(extension))).sort();
  const pages = await Promise.all(
    files.map(async (file) => parsePage(relative(dir, join(dir, file)), await readFile(join(dir, file), "utf8"))),
  );
  return toGraph(pages, options);
}

// `type:` names a node type of the ontology, in any case (`decision`, `Decision`); anything else,
// or no type, is a Concept.
function nodeType(frontmatter: Frontmatter): NodeType {
  const { type } = frontmatter;
  const match = NodeTypeSchema.options.find((t) => typeof type === "string" && t.toLowerCase() === type.toLowerCase());
  return match ?? "Concept";
}
