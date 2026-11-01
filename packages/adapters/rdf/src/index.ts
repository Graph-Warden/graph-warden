import { createGraph, NodeSchema, type Edge, type GraphStore, type Node } from "@graph-warden/core";

// A GraphStore on an RDF triplestore (issue #24), through SPARQL 1.1: Apache Jena Fuseki, GraphDB,
// Oxigraph, Amazon Neptune. Like the Neo4j adapter, it stores and returns nodes as they are and
// never filters by scope: the domain does, on every hop.
//
// Everything lives in one named graph, so the triplestore may hold other data beside it. A node is
// the IRI `urn:graph-warden:node:<id>` with its fields as triples (type, scope, title, provenance:
// what SPARQL users query) and the node itself as JSON (`gw:json`), which is what the store reads
// back, so a node returns exactly as written. An edge is one triple whose predicate is
// `urn:graph-warden:edge:<TYPE>`: (type, from, to) is unique by construction.

export interface SparqlClient {
  // Rows of a SELECT, each variable bound to an IRI's value or a literal's lexical form.
  select(query: string): Promise<readonly Readonly<Record<string, string>>[]>;
  update(update: string): Promise<void>;
}

export const GRAPH = "urn:graph-warden:graph";
export const NODE = "urn:graph-warden:node:";
export const EDGE = "urn:graph-warden:edge:";
const GW = "https://graph-warden.github.io/ns#";

export const nodeIri = (id: string): string => `${NODE}${encodeURIComponent(id)}`;
const idOf = (iri: string) => decodeURIComponent(iri.slice(NODE.length));
const iri = (value: string) => `<${value}>`;
// JSON's escapes are SPARQL's (\", \\, \n, \uXXXX), so a JSON string is a SPARQL string literal.
const literal = (value: string) => JSON.stringify(value);
const edgeIri = (type: string) => {
  if (!/^[A-Z][A-Z0-9_]*$/.test(type)) throw new Error(`Invalid edge type: ${type}`);
  return `${EDGE}${type}`;
};

const prefixes = `PREFIX gw: <${GW}>\nPREFIX dct: <http://purl.org/dc/terms/>\n`;

function triples(node: Node): string {
  const s = iri(nodeIri(node.id));
  const scope = node.scope.kind === "shared" ? "shared" : node.scope.kind === "team" ? `team:${node.scope.team}` : node.scope.kind === "teams" ? `teams:${node.scope.teams.join(",")}` : `private:${node.scope.user}`;
  return [
    `${s} a gw:Node`,
    `${s} gw:id ${literal(node.id)}`,
    `${s} gw:type ${literal(node.type)}`,
    `${s} gw:scope ${literal(scope)}`,
    `${s} gw:source ${literal(node.provenance.source)}`,
    `${s} gw:path ${literal(node.provenance.path)}`,
    ...(node.provenance.sha === undefined ? [] : [`${s} gw:sha ${literal(node.provenance.sha)}`]),
    ...(node.title === undefined ? [] : [`${s} dct:title ${literal(node.title)}`]),
    ...(node.body === undefined ? [] : [`${s} gw:body ${literal(node.body)}`]),
    `${s} gw:json ${literal(JSON.stringify(node))}`,
  ]
    .map((triple) => `${triple} .`)
    .join("\n");
}

export function createRdfStore(client: SparqlClient): GraphStore {
  const g = iri(GRAPH);
  const known = async (ids: readonly string[]): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();
    const rows = await client.select(`${prefixes}SELECT ?n WHERE { GRAPH ${g} { VALUES ?n { ${ids.map((id) => iri(nodeIri(id))).join(" ")} } ?n a gw:Node } }`);
    return new Set(rows.map((row) => idOf(row.n ?? "")));
  };

  return {
    async upsertNodes(nodes) {
      if (nodes.length === 0) return;
      const parsed = nodes.map((node) => NodeSchema.parse(node));
      // Each node's own triples are replaced; its edges, in and out, stay.
      const updates = parsed.map(
        (node) =>
          `DELETE { GRAPH ${g} { ${iri(nodeIri(node.id))} ?p ?o } } WHERE { GRAPH ${g} { ${iri(nodeIri(node.id))} ?p ?o FILTER(!STRSTARTS(STR(?p), ${literal(EDGE)})) } };\n` +
          `INSERT DATA { GRAPH ${g} { ${triples(node)} } }`,
      );
      await client.update(`${prefixes}${updates.join(";\n")}`);
    },

    async upsertEdges(edges) {
      if (edges.length === 0) return;
      const ids = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
      const found = await known(ids);
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length > 0) throw new Error(`Edges to unknown nodes: ${missing.join(", ")}`);
      await client.update(`INSERT DATA { GRAPH ${g} { ${edges.map((edge) => `${iri(nodeIri(edge.from))} ${iri(edgeIri(edge.type))} ${iri(nodeIri(edge.to))} .`).join("\n")} } }`);
    },

    async getNode(id) {
      const [row] = await client.select(`${prefixes}SELECT ?json WHERE { GRAPH ${g} { ${iri(nodeIri(id))} gw:json ?json } }`);
      return row?.json === undefined ? undefined : NodeSchema.parse(JSON.parse(row.json));
    },

    async deleteNode(id) {
      const n = iri(nodeIri(id));
      await client.update(
        `DELETE { GRAPH ${g} { ${n} ?p ?o } } WHERE { GRAPH ${g} { ${n} ?p ?o } };\n` + `DELETE { GRAPH ${g} { ?s ?p ${n} } } WHERE { GRAPH ${g} { ?s ?p ${n} } }`,
      );
    },

    async deleteEdges(edges) {
      if (edges.length === 0) return;
      await client.update(`DELETE DATA { GRAPH ${g} { ${edges.map((edge) => `${iri(nodeIri(edge.from))} ${iri(edgeIri(edge.type))} ${iri(nodeIri(edge.to))} .`).join("\n")} } }`);
    },

    async snapshot() {
      const nodes = await client.select(`${prefixes}SELECT ?json WHERE { GRAPH ${g} { ?n gw:json ?json } }`);
      const edges = await client.select(`SELECT ?s ?p ?o WHERE { GRAPH ${g} { ?s ?p ?o FILTER(STRSTARTS(STR(?p), ${literal(EDGE)})) } }`);
      return createGraph(
        nodes.map((row) => NodeSchema.parse(JSON.parse(row.json ?? ""))),
        edges.map((row): Edge => ({ type: (row.p ?? "").slice(EDGE.length), from: idOf(row.s ?? ""), to: idOf(row.o ?? "") })),
      );
    },

    async erasedSources() {
      const rows = await client.select(`${prefixes}SELECT ?source WHERE { GRAPH ${g} { ${g} gw:erased ?source } }`);
      return new Set(rows.map((row) => row.source ?? ""));
    },

    async markErased(source) {
      await client.update(`${prefixes}INSERT DATA { GRAPH ${g} { ${g} gw:erased ${literal(source)} } }`);
    },

    async readmit(source) {
      await client.update(`${prefixes}DELETE DATA { GRAPH ${g} { ${g} gw:erased ${literal(source)} } }`);
    },
  };
}

export interface HttpSparqlOptions {
  // The query endpoint (`http://localhost:3030/graph-warden/query` on Fuseki), and the update one
  // when it differs.
  readonly query: string;
  readonly update?: string;
  // An Authorization header value, when the endpoint asks for one.
  readonly authorization?: string;
  readonly fetch?: typeof fetch;
}

// The SPARQL 1.1 Protocol over HTTP.
export function createHttpSparqlClient(options: HttpSparqlOptions): SparqlClient {
  const { query, update = query, authorization, fetch: send = fetch } = options;
  const headers = (type: string) => ({ "content-type": type, ...(authorization === undefined ? {} : { authorization }) });
  return {
    async select(text) {
      const response = await send(query, { method: "POST", headers: { ...headers("application/sparql-query"), accept: "application/sparql-results+json" }, body: text });
      if (!response.ok) throw new Error(`SPARQL query: ${response.status} ${await response.text()}`);
      const { results } = (await response.json()) as { results: { bindings: Record<string, { value: string }>[] } };
      return results.bindings.map((binding) => Object.fromEntries(Object.entries(binding).map(([name, term]) => [name, term.value])));
    },
    async update(text) {
      const response = await send(update, { method: "POST", headers: headers("application/sparql-update"), body: text });
      if (!response.ok) throw new Error(`SPARQL update: ${response.status} ${await response.text()}`);
    },
  };
}
