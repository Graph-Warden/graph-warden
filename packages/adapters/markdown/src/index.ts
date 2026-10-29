import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
  EdgeTypeSchema,
  NodeSchema,
  NodeTypeSchema,
  ScopeSchema,
  type Edge,
  type EdgeType,
  type Node,
  type NodeType,
  type Scope,
} from "@graph-warden/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// A folder of Markdown documents as nodes and edges. A page is a node named after its file. Edges
// come from the typed `references:` frontmatter field and from [[wikilinks]], which are untyped
// REFERENCES; a typed reference to a target replaces the wikilink to the same target. References
// to pages that were not read (filtered out, or missing) are dropped, so no edge dangles.

export type Frontmatter = Readonly<Record<string, unknown>>;

export interface Page {
  readonly name: string;
  readonly path: string;
  readonly frontmatter: Frontmatter;
  readonly links: readonly string[];
  readonly references: readonly Reference[];
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

export function parsePage(path: string, text: string): Page {
  const match = FRONTMATTER.exec(text);
  const yaml: unknown = match?.[1] === undefined ? {} : parseYaml(match[1]);
  const frontmatter = typeof yaml === "object" && yaml !== null ? (yaml as Frontmatter) : {};
  const links = [...text.matchAll(WIKILINK)].map((link) => (link[1] ?? "").trim());
  const references = ReferencesSchema.safeParse(frontmatter.references);
  if (!references.success) {
    throw new Error(`${path}: invalid references: ${z.prettifyError(references.error)}`);
  }
  return { name: basename(path, ".md"), path, frontmatter, links: [...new Set(links)], references: references.data };
}

export function parseScope(value: string): Scope {
  const [kind, owner] = value.split(":", 2);
  const scope = kind === "team" ? { kind, team: owner } : kind === "private" ? { kind, user: owner } : { kind };
  return ScopeSchema.parse(scope);
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
  const files = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith(".md")).sort();
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
