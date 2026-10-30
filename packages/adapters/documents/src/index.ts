import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, posix, relative, sep } from "node:path";
import {
  CORE_ONTOLOGY,
  createOntology,
  createSensitivityPolicy,
  EdgeTypeSchema,
  NodeSchema,
  OntologyExtensionSchema,
  parseScope,
  SensitivityConfigSchema,
  type Edge,
  type EdgeType,
  type Extractor,
  type Node,
  type NodeType,
  type Ontology,
  type Scope,
  type SensitivityPolicy,
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
  // The `title` field, else the first `# ` heading of the text.
  readonly title?: string;
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
  // Scope of a page without a `scope:` frontmatter field, nor a folder file above it. Required:
  // there is no implicit default, so nothing becomes visible to others unless a caller chose it
  // (private by default is the callers' rule, see the CLI).
  readonly defaultScope: Scope;
  // Scopes declared by folder files (`.gwarden.yaml`), by folder path.
  readonly folders?: ReadonlyMap<string, Scope>;
  // The types a `type:` field may name; the core ones by default.
  readonly ontology?: Ontology;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const WIKILINK = /\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g;

export const EXTENSIONS = [".md", ".json", ".yaml", ".yml"] as const;

// A folder file declares the scope of every document in its folder and below, unless a nearer
// folder file or the document's own `scope:` field says otherwise:
//   scope: team:payments
export const FOLDER_FILE = ".gwarden.yaml";
const FolderSchema = z.object({ scope: z.string().min(1) }).strict();

const isFolderFile = (path: string) => posix.basename(path) === FOLDER_FILE;
export const isDocument = (path: string) => EXTENSIONS.some((extension) => path.endsWith(extension)) && !isFolderFile(path);

export function parseFolder(path: string, text: string): Scope {
  const parsed = FolderSchema.safeParse(parse(path, "YAML", () => parseYaml(text) ?? {}));
  if (!parsed.success) throw new Error(`${path}: invalid folder file: ${z.prettifyError(parsed.error)}`);
  return parse(path, "scope", () => parseScope(parsed.data.scope));
}

// The scope the nearest folder file above a document declares.
function folderScope(folders: ReadonlyMap<string, Scope>, path: string): Scope | undefined {
  for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
    const scope = folders.get(dir);
    if (scope !== undefined) return scope;
    if (dir === "." || dir === "/" || dir === "") return undefined;
  }
}

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

function parse<T>(path: string, format: string, read: () => T): T {
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
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1]?.trim();
  const title = typeof frontmatter.title === "string" && frontmatter.title.trim() !== "" ? frontmatter.title.trim() : heading;
  return {
    name,
    path,
    frontmatter,
    links,
    references: references.data,
    ...(body === "" ? {} : { body }),
    ...(title === undefined || title === "" ? {} : { title }),
  };
}

export function toGraph(pages: readonly Page[], options: DocumentOptions): { nodes: Node[]; edges: Edge[] } {
  const kept = pages.filter(options.include ?? (() => true));
  const names = new Set(kept.map((page) => page.name));
  return toNodes(kept, options, (name) => names.has(name));
}

function toNodes(kept: readonly Page[], options: DocumentOptions, known: (name: string) => boolean): { nodes: Node[]; edges: Edge[] } {
  const nodes = kept.map((page) =>
    NodeSchema.parse({
      id: page.name,
      type: nodeType(page.frontmatter, options.ontology ?? CORE_ONTOLOGY),
      scope:
        typeof page.frontmatter.scope === "string"
          ? parseScope(page.frontmatter.scope)
          : (folderScope(options.folders ?? new Map(), page.path) ?? options.defaultScope),
      provenance: { source: options.source, path: page.path },
      ...(page.title === undefined ? {} : { title: page.title }),
      ...(page.body === undefined ? {} : { body: page.body }),
    }),
  );
  const edges = kept.flatMap((page) => {
    const typed = new Set(page.references.filter((r) => r.type !== "REFERENCES").map((r) => r.to));
    const unique = new Map<string, Edge>();
    for (const { type, to } of [...page.references, ...page.links.map((to): Reference => ({ type: "REFERENCES", to }))]) {
      if (to === page.name || !known(to)) continue;
      if (type === "REFERENCES" && typed.has(to)) continue;
      unique.set(`${type} ${to}`, { type, from: page.name, to });
    }
    return [...unique.values()];
  });
  return { nodes, edges };
}

export async function readDocuments(dir: string, options: DocumentOptions): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const all = (await readdir(dir, { recursive: true })).map((file) => relative(dir, join(dir, file)).split(sep).join("/")).sort();
  const pages = await Promise.all(all.filter(isDocument).map(async (file) => parsePage(file, await readFile(join(dir, file), "utf8"))));
  const folders = new Map(
    await Promise.all(all.filter(isFolderFile).map(async (file) => [posix.dirname(file), parseFolder(file, await readFile(join(dir, file), "utf8"))] as const)),
  );
  return toGraph(pages, { ...options, folders });
}

// `type:` names a node type of the ontology, in any case (`decision`, `Decision`); anything else,
// or no type, is a Concept.
function nodeType(frontmatter: Frontmatter, ontology: Ontology): NodeType {
  const { type } = frontmatter;
  const match = ontology.nodeTypes.find((t) => typeof type === "string" && t.toLowerCase() === type.toLowerCase());
  return match ?? "Concept";
}

// The organisation's additions to the ontology, from a YAML file:
//   nodeTypes: [Microservice, Database]
//   edgeTypes: [OWNS, RUNS_ON]
export async function readOntology(path: string): Promise<Ontology> {
  return createOntology(OntologyExtensionSchema.parse(parseYaml(await readFile(path, "utf8")) ?? {}));
}

// The sensitivity of each source, from a YAML file (issue #28):
//   default: internal
//   confidential: [docs:hr, "github:acme/payroll*"]
export async function readSensitivity(path: string): Promise<SensitivityPolicy> {
  return createSensitivityPolicy(SensitivityConfigSchema.parse(parseYaml(await readFile(path, "utf8")) ?? {}));
}

// The documents of a git repository, for the ingester. References are kept whatever their target:
// it may be a document the commit did not change, and the ingester drops those to nothing.
// A document without a `scope:` field takes the scope of the nearest folder file, else the
// repository's unless `defaultScope` says otherwise. A commit changing or removing a folder file
// extracts every document below it again.
export interface DocumentExtractorOptions {
  readonly include?: (path: string) => boolean;
  readonly defaultScope?: Scope;
  readonly ontology?: Ontology;
}

export function createDocumentExtractor(options: DocumentExtractorOptions = {}): Extractor {
  const { include = () => true, defaultScope, ...rest } = options;
  return {
    matches: (path) => isFolderFile(path) || (isDocument(path) && include(path)),
    async extract(files, snapshot) {
      const all = await snapshot.files();
      const folders = new Map(await Promise.all(all.filter(isFolderFile).map(async (path) => [posix.dirname(path), parseFolder(path, await snapshot.read(path))] as const)));
      // Documents below a folder file the commit changed, read again: their scope may have changed.
      const moved = snapshot.changes.filter((change) => isFolderFile(change.path)).map((change) => posix.dirname(change.path));
      const below = (path: string) => moved.some((dir) => dir === "." || path.startsWith(`${dir}/`));
      const texts = new Map(files.filter((file) => isDocument(file.path)).map((file) => [file.path, file.text]));
      for (const path of all) {
        if (isDocument(path) && include(path) && below(path) && !texts.has(path)) texts.set(path, await snapshot.read(path));
      }
      const pages = [...texts].map(([path, text]) => parsePage(path, text));
      const { nodes, edges } = toNodes(pages, { ...rest, source: snapshot.repo.name, defaultScope: defaultScope ?? snapshot.repo.scope, folders }, () => true);
      return { nodes: nodes.map(({ provenance, ...node }) => ({ ...node, path: provenance.path })), edges };
    },
  };
}
