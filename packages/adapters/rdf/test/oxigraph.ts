import oxigraph from "oxigraph";
import type { SparqlClient } from "../src/index.js";

// An in-process triplestore for tests: Oxigraph, the same SPARQL engine as its server.
export function createOxigraphClient(store = new oxigraph.Store()): SparqlClient {
  return {
    select: async (query) => {
      const rows = store.query(query) as Map<string, { value: string }>[];
      return rows.map((row) => Object.fromEntries([...row].map(([name, term]) => [name, term.value])));
    },
    update: async (update) => store.update(update),
  };
}
