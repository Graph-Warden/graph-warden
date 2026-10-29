import {
  createGraph,
  EdgeSchema,
  NodeSchema,
  type Edge,
  type GraphStore,
  type Node,
  type Scope,
} from "@graph-warden/core";
import type { Driver, Record as Neo4jRecord } from "neo4j-driver";

// Every node is stored as (:Node:<type>) with flat properties; every edge as a relationship named
// after its type. Values are validated against the ontology on the way in and on the way out, so
// a node written by hand in the database cannot reach the domain unchecked.

export async function ensureConstraints(driver: Driver): Promise<void> {
  // Community edition: uniqueness only. Existence of scope and provenance is enforced by the
  // schema validation below (property existence constraints need Enterprise).
  await driver.executeQuery("CREATE CONSTRAINT node_id IF NOT EXISTS FOR (n:Node) REQUIRE n.id IS UNIQUE");
}

export function createNeo4jStore(driver: Driver): GraphStore {
  return {
    async upsertNodes(nodes) {
      const rows = nodes.map((node) => toRow(NodeSchema.parse(node)));
      for (const [type, group] of groupBy(rows, (row) => row.type)) {
        // The label comes from the closed ontology enum, never from free input.
        await driver.executeQuery(
          `UNWIND $rows AS row MERGE (n:Node {id: row.id}) SET n = row, n:${type}`,
          { rows: group },
        );
      }
    },

    async upsertEdges(edges) {
      const parsed = edges.map((edge) => EdgeSchema.parse(edge));
      for (const [type, group] of groupBy(parsed, (edge) => edge.type)) {
        const { records } = await driver.executeQuery(
          `UNWIND $edges AS e MATCH (a:Node {id: e.from}), (b:Node {id: e.to}) MERGE (a)-[:${type}]->(b) RETURN count(*) AS written`,
          { edges: group.map(({ from, to }) => ({ from, to })) },
        );
        if (records[0]?.get("written").toNumber() !== group.length) {
          throw new Error(`Some ${type} edges reference unknown nodes`);
        }
      }
    },

    async getNode(id) {
      const { records } = await driver.executeQuery("MATCH (n:Node {id: $id}) RETURN n", { id });
      const record = records[0];
      return record === undefined ? undefined : fromRecord(record);
    },

    async deleteNode(id) {
      await driver.executeQuery("MATCH (n:Node {id: $id}) DETACH DELETE n", { id });
    },

    async snapshot() {
      const nodes = await driver.executeQuery("MATCH (n:Node) RETURN n");
      const edges = await driver.executeQuery(
        "MATCH (a:Node)-[r]->(b:Node) RETURN type(r) AS type, a.id AS from, b.id AS to",
      );
      return createGraph(
        nodes.records.map(fromRecord),
        edges.records.map((r): Edge => EdgeSchema.parse({ type: r.get("type"), from: r.get("from"), to: r.get("to") })),
      );
    },
  };
}

interface Row {
  id: string;
  type: string;
  scopeKind: Scope["kind"];
  scopeOwner: string | null;
  provenanceSource: string;
  provenancePath: string;
  provenanceSha: string | null;
}

function toRow(node: Node): Row {
  const { scope, provenance } = node;
  return {
    id: node.id,
    type: node.type,
    scopeKind: scope.kind,
    scopeOwner: scope.kind === "team" ? scope.team : scope.kind === "private" ? scope.user : null,
    provenanceSource: provenance.source,
    provenancePath: provenance.path,
    provenanceSha: provenance.sha ?? null,
  };
}

function fromRecord(record: Neo4jRecord): Node {
  const row = record.get("n").properties as Row;
  const scope =
    row.scopeKind === "team"
      ? { kind: "team", team: row.scopeOwner }
      : row.scopeKind === "private"
        ? { kind: "private", user: row.scopeOwner }
        : { kind: row.scopeKind };
  const provenance = {
    source: row.provenanceSource,
    path: row.provenancePath,
    ...(row.provenanceSha === null || row.provenanceSha === undefined ? {} : { sha: row.provenanceSha }),
  };
  return NodeSchema.parse({ id: row.id, type: row.type, scope, provenance });
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
