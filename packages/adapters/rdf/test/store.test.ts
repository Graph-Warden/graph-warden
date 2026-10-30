import { describe, expect, it } from "vitest";
import oxigraph from "oxigraph";
import { checkStore } from "@graph-warden/core";
import { createHttpSparqlClient, createRdfStore, nodeIri } from "../src/index.js";
import { createOxigraphClient } from "./oxigraph.js";

describe("RDF store", () => {
  it("passes the store conformance suite", async () => {
    expect(await checkStore(() => createRdfStore(createOxigraphClient()))).toEqual([]);
  });

  it("writes triples SPARQL users can query, in its own named graph, beside other data", async () => {
    const triplestore = new oxigraph.Store();
    triplestore.update('INSERT DATA { <urn:other:x> <urn:other:p> "unrelated" }');
    const store = createRdfStore(createOxigraphClient(triplestore));
    await store.upsertNodes([
      { id: "adr-1", type: "Decision", scope: { kind: "team", team: "bff" }, provenance: { source: "docs", path: "adr-1.md" }, title: "Cursors" },
      { id: "orders", type: "Endpoint", scope: { kind: "shared" }, provenance: { source: "github:acme/shop", path: "openapi.yaml" } },
    ]);
    await store.upsertEdges([{ type: "DECIDES", from: "adr-1", to: "orders" }]);
    const rows = triplestore.query(
      'PREFIX gw: <https://graph-warden.github.io/ns#> SELECT ?scope ?target WHERE { GRAPH <urn:graph-warden:graph> { ?d gw:type "Decision" ; gw:scope ?scope ; <urn:graph-warden:edge:DECIDES> ?target } }',
    ) as Map<string, { value: string }>[];
    expect(rows.map((row) => [row.get("scope")?.value, row.get("target")?.value])).toEqual([["team:bff", nodeIri("orders")]]);
    expect((await store.snapshot()).nodes.size).toBe(2);
    await store.deleteNode("orders");
    expect(triplestore.query("ASK { <urn:other:x> <urn:other:p> \"unrelated\" }")).toBe(true);
  });

  it("speaks the SPARQL protocol over HTTP", async () => {
    const triplestore = createOxigraphClient();
    const calls: string[] = [];
    // An endpoint backed by Oxigraph, answering as Fuseki does.
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const type = new Headers(init?.headers).get("content-type");
      calls.push(`${String(url)} ${type} ${new Headers(init?.headers).get("authorization")}`);
      if (type === "application/sparql-update") {
        await triplestore.update(body);
        return new Response(null, { status: 204 });
      }
      const rows = await triplestore.select(body);
      return Response.json({ results: { bindings: rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, { type: "literal", value: v }]))) } });
    }) as typeof globalThis.fetch;
    const store = createRdfStore(createHttpSparqlClient({ query: "http://fuseki/gw/query", update: "http://fuseki/gw/update", authorization: "Basic eA==", fetch }));
    await store.upsertNodes([{ id: "a", type: "Concept", scope: { kind: "shared" }, provenance: { source: "s", path: "a" } }]);
    expect(await store.getNode("a")).toMatchObject({ id: "a" });
    expect(calls[0]).toBe("http://fuseki/gw/update application/sparql-update Basic eA==");
    expect(calls[1]).toBe("http://fuseki/gw/query application/sparql-query Basic eA==");
  });
});
