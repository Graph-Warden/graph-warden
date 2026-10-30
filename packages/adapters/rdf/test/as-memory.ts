import type { Edge, GraphStore, Node } from "@graph-warden/core";
import { createRdfStore } from "../src/index.js";
import { createOxigraphClient } from "./oxigraph.js";

// `@graph-warden/memory` with its GraphStore on RDF: with GWARDEN_TEST_STORE=rdf, vitest resolves
// the package here, so that every test of the suite runs against the triplestore (issue #24).
export * from "../../memory/src/index.js";

export function createMemoryStore(initial?: { readonly nodes: ReadonlyMap<string, Node>; readonly edges: readonly Edge[] }): GraphStore {
  const store = createRdfStore(createOxigraphClient());
  const ready = initial === undefined ? Promise.resolve() : store.upsertNodes([...initial.nodes.values()]).then(() => store.upsertEdges(initial.edges));
  return {
    upsertNodes: async (nodes) => ready.then(() => store.upsertNodes(nodes)),
    upsertEdges: async (edges) => ready.then(() => store.upsertEdges(edges)),
    getNode: async (id) => ready.then(() => store.getNode(id)),
    deleteNode: async (id) => ready.then(() => store.deleteNode(id)),
    deleteEdges: async (edges) => ready.then(() => store.deleteEdges(edges)),
    snapshot: async () => ready.then(() => store.snapshot()),
  };
}
