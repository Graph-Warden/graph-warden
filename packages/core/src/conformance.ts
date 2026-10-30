import { formatScope, type Scope } from "./scope.js";
import type { Extractor, RepositoryConfig, Snapshot } from "./ingestion.js";
import { CORE_ONTOLOGY, NodeSchema, type Edge, type Node, type Ontology } from "./ontology.js";

// The source conformance suite (issue #18): what every source adapter must guarantee of the nodes
// and edges it gives, whatever it reads. An adapter passes it on a fixture of its own: files, and
// the nodes whose content declares no scope. It is framework-free, so that an adapter outside this
// repository runs it in its own tests: `expect(await checkSource(...)).toEqual([])`.
//
// 1. Every node is valid (schema), has a type of the ontology, and a unique id.
// 2. Every edge has a type of the ontology and joins two nodes the adapter gave: none dangles.
// 3. Provenance names the configured source, and the path of a fixture file.
// 4. Content that declares no scope gets the default the adapter was given (private to the
//    ingesting user, for documents): nothing becomes wider than someone chose.
// 5. The same files give the same graph, whatever the order they are read in.
// 6. A file left out takes its nodes with it.

export interface Extracted {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}

export interface SourceUnderTest {
  readonly source: string;
  // The fixture: file paths and their text.
  readonly files: ReadonlyMap<string, string>;
  extract(files: ReadonlyMap<string, string>): Promise<Extracted>;
  // Ids of the nodes whose content declares no scope, and the scope they must get.
  readonly undeclared: readonly string[];
  readonly defaultScope: Scope;
  readonly ontology?: Ontology;
}

export async function checkSource(adapter: SourceUnderTest): Promise<string[]> {
  const { source, files, undeclared, defaultScope, ontology = CORE_ONTOLOGY } = adapter;
  const violations: string[] = [];
  const graph = await adapter.extract(files);
  const ids = new Map<string, Node>();

  for (const node of graph.nodes) {
    const parsed = NodeSchema.safeParse(node);
    if (!parsed.success) violations.push(`${node.id}: invalid node`);
    if (!ontology.nodeTypes.includes(node.type)) violations.push(`${node.id}: node type ${node.type} is not in the ontology`);
    if (ids.has(node.id)) violations.push(`${node.id}: given twice`);
    ids.set(node.id, node);
    if (node.provenance.source !== source) violations.push(`${node.id}: provenance source ${node.provenance.source}, expected ${source}`);
    if (!files.has(node.provenance.path)) violations.push(`${node.id}: provenance path ${node.provenance.path} is not a file of the fixture`);
  }
  for (const edge of graph.edges) {
    const name = `${edge.type} ${edge.from} -> ${edge.to}`;
    if (!ontology.edgeTypes.includes(edge.type)) violations.push(`${name}: edge type is not in the ontology`);
    if (!ids.has(edge.from) || !ids.has(edge.to)) violations.push(`${name}: dangles`);
  }

  if (undeclared.length === 0) violations.push("the fixture has no content without a scope: the default is not checked");
  for (const id of undeclared) {
    const node = ids.get(id);
    if (node === undefined) violations.push(`${id}: expected in the fixture, not given`);
    else if (formatScope(node.scope) !== formatScope(defaultScope)) {
      violations.push(`${id}: declares no scope but got ${formatScope(node.scope)}, expected ${formatScope(defaultScope)}`);
    }
  }

  const reversed = await adapter.extract(new Map([...files].reverse()));
  if (fingerprint(reversed) !== fingerprint(graph)) violations.push("reading the files in another order gives another graph");
  const again = await adapter.extract(files);
  if (fingerprint(again) !== fingerprint(graph)) violations.push("reading the same files twice gives two graphs");

  for (const path of files.keys()) {
    const without = await adapter.extract(new Map([...files].filter(([other]) => other !== path)));
    const left = without.nodes.filter((node) => node.provenance.path === path).map((node) => node.id);
    if (left.length > 0) violations.push(`${path}: left out, but ${left.join(", ")} still given`);
  }
  return violations;
}

// JSON with keys in order, at every depth.
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(",")}}`
      : JSON.stringify(value);

const fingerprint = (graph: Extracted) =>
  JSON.stringify([
    [...graph.nodes].map(canonical).sort(),
    [...graph.edges].map((edge) => `${edge.type} ${edge.from} ${edge.to}`).sort(),
  ]);

// `extract` for an extractor of the ingester, as the ingester calls it on a first commit holding
// the fixture: every file is new.
export function extractWith(extractor: Extractor, repo: RepositoryConfig): (files: ReadonlyMap<string, string>) => Promise<Extracted> {
  return async (files) => {
    const snapshot: Snapshot = {
      repo,
      sha: "0000000",
      changes: [...files.keys()].map((path) => ({ status: "upserted", path })),
      read: async (path) => {
        const text = files.get(path);
        if (text === undefined) throw new Error(`${path}: not in the commit`);
        return text;
      },
      files: async () => [...files.keys()],
    };
    const matched = [...files].filter(([path]) => extractor.matches(path)).map(([path, text]) => ({ path, text }));
    const extraction = await extractor.extract(matched, snapshot);
    return {
      nodes: extraction.nodes.map(({ path, ...node }) => ({ ...node, provenance: { source: repo.name, path, sha: snapshot.sha } })),
      edges: extraction.edges.filter((edge) => extractor.edgeTypes?.includes(edge.type) ?? true),
    };
  };
}
