import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { NodeSchema, ScopeSchema, type Edge, type Node, type NodeType, type Scope } from "@graph-warden/core";
import { parse as parseYaml } from "yaml";

// A folder of Markdown documents as nodes and REFERENCES edges. A page is a node named after its
// file; a [[wikilink]] to another page read in the same pass is an edge. Links to pages that were
// not read (filtered out, or missing) are dropped, so the result never holds a dangling edge.

export type Frontmatter = Readonly<Record<string, unknown>>;

export interface Page {
  readonly name: string;
  readonly path: string;
  readonly frontmatter: Frontmatter;
  readonly links: readonly string[];
}

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
  return { name: basename(path, ".md"), path, frontmatter, links: [...new Set(links)] };
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
  const edges = kept.flatMap((page) =>
    page.links
      .filter((link) => link !== page.name && names.has(link))
      .map((link): Edge => ({ type: "REFERENCES", from: page.name, to: link })),
  );
  return { nodes, edges };
}

export async function readDocuments(dir: string, options: DocumentOptions): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const files = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith(".md")).sort();
  const pages = await Promise.all(
    files.map(async (file) => parsePage(relative(dir, join(dir, file)), await readFile(join(dir, file), "utf8"))),
  );
  return toGraph(pages, options);
}

function nodeType(frontmatter: Frontmatter): NodeType {
  return frontmatter.type === "source" ? "Source" : "Concept";
}
