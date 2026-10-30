import {
  AuditEntrySchema,
  createGraph,
  GraphEventSchema,
  EdgeSchema,
  NodeSchema,
  type AuditLog,
  type Edge,
  type EventLog,
  type GraphStore,
  type IngestionState,
  type StaleMarks,
  type Node,
  type Scope,
} from "@graph-warden/core";
import neo4j, { type Driver, type Record as Neo4jRecord } from "neo4j-driver";

// Every node is stored as (:Node:<type>) with flat properties; every edge as a relationship named
// after its type. Values are validated against the ontology on the way in and on the way out, so
// a node written by hand in the database cannot reach the domain unchecked.

// Labels of the adapter's own nodes. A node type of the same name would put a graph node among
// them, in the audit log or the event log: the ontology may extend the types, not these.
export const RESERVED_LABELS = ["Node", "Counter", "AuditEntry", "Event", "Ingestion", "Stale"] as const;

export async function ensureConstraints(driver: Driver): Promise<void> {
  // Community edition: uniqueness only. Existence of scope and provenance is enforced by the
  // schema validation below (property existence constraints need Enterprise).
  await driver.executeQuery("CREATE CONSTRAINT node_id IF NOT EXISTS FOR (n:Node) REQUIRE n.id IS UNIQUE");
  await driver.executeQuery("CREATE CONSTRAINT counter_id IF NOT EXISTS FOR (c:Counter) REQUIRE c.id IS UNIQUE");
  await driver.executeQuery("CREATE CONSTRAINT audit_seq IF NOT EXISTS FOR (e:AuditEntry) REQUIRE e.seq IS UNIQUE");
  await driver.executeQuery("CREATE CONSTRAINT event_seq IF NOT EXISTS FOR (e:Event) REQUIRE e.seq IS UNIQUE");
  await driver.executeQuery("CREATE INDEX event_node IF NOT EXISTS FOR (e:Event) ON (e.node)");
  await driver.executeQuery("CREATE CONSTRAINT ingestion_repo IF NOT EXISTS FOR (i:Ingestion) REQUIRE i.repo IS UNIQUE");
  await driver.executeQuery("CREATE CONSTRAINT stale_id IF NOT EXISTS FOR (s:Stale) REQUIRE s.id IS UNIQUE");
}

export function createNeo4jStore(driver: Driver): GraphStore {
  return {
    async upsertNodes(nodes) {
      const rows = nodes.map((node) => toRow(NodeSchema.parse(node)));
      const reserved = rows.find((row) => (RESERVED_LABELS as readonly string[]).includes(row.type));
      if (reserved !== undefined) throw new Error(`${reserved.id}: node type ${reserved.type} is reserved by the Neo4j store`);
      for (const [type, group] of groupBy(rows, (row) => row.type)) {
        // The label is a validated type name (PascalCase, letters and digits), never free input.
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

    async deleteEdges(edges) {
      const parsed = edges.map((edge) => EdgeSchema.parse(edge));
      for (const [type, group] of groupBy(parsed, (edge) => edge.type)) {
        await driver.executeQuery(
          `UNWIND $edges AS e MATCH (:Node {id: e.from})-[r:${type}]->(:Node {id: e.to}) DELETE r`,
          { edges: group.map(({ from, to }) => ({ from, to })) },
        );
      }
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

// Hands out `count` sequence numbers from a counter node and binds the first one to `first`. The
// first SET takes the write lock on the counter before its value is read, so concurrent writers
// queue up instead of reading the same value.
const nextSeq = (counter: string, count: string) => `
  MERGE (c:Counter {id: '${counter}'}) SET c.locked = true
  WITH c, coalesce(c.seq, 0) + 1 AS first SET c.seq = first + ${count} - 1
  WITH first`;

// Audit entries are (:AuditEntry) nodes, outside the :Node label, so no traversal or snapshot ever
// sees them. What an entry asked for (start and options, cursor, filter) is kept as JSON in
// `request`. Nothing here updates or deletes an entry.
export function createNeo4jAuditLog(driver: Driver): AuditLog {
  return {
    async append(entry) {
      const { at, principal, action, returned, ...request } = AuditEntrySchema.parse(entry);
      await driver.executeQuery(
        `${nextSeq("audit", "1")}
         CREATE (:AuditEntry {seq: first, at: $at, user: $user, teams: $teams, action: $action,
                              request: $request, returned: $returned})`,
        { at, user: principal.user, teams: principal.teams, action, request: JSON.stringify(request), returned },
      );
    },

    async entries(filter = {}) {
      const { records } = await driver.executeQuery(
        "MATCH (e:AuditEntry) WHERE $user IS NULL OR e.user = $user RETURN e ORDER BY e.seq",
        { user: filter.user ?? null },
      );
      return records.map((record) => {
        const e = record.get("e").properties as Record<string, unknown>;
        return AuditEntrySchema.parse({
          ...(JSON.parse(String(e.request)) as object),
          at: e.at,
          principal: { user: e.user, teams: e.teams },
          action: e.action,
          returned: e.returned,
        });
      });
    },
  };
}

// Graph events are (:Event) nodes, outside the :Node label, numbered like audit entries. A batch of
// events gets consecutive numbers in one transaction.
export function createNeo4jEventLog(driver: Driver): EventLog {
  const read = async (query: string, params: Record<string, unknown>) => {
    const { records } = await driver.executeQuery(query, params);
    return records.map((record) => {
      const e = record.get("e").properties as Record<string, unknown>;
      return GraphEventSchema.parse({ ...(JSON.parse(String(e.payload)) as object), seq: neo4j.integer.toNumber(e.seq as number) });
    });
  };
  return {
    async append(events) {
      if (events.length === 0) return;
      const rows = events.map((event) => ({
        payload: JSON.stringify(event),
        node: "edge" in event ? null : event.id,
        from: "edge" in event ? event.edge.from : null,
        to: "edge" in event ? event.edge.to : null,
      }));
      await driver.executeQuery(
        `${nextSeq("events", "size($rows)")}
         UNWIND range(0, size($rows) - 1) AS i
         WITH first + i AS seq, $rows[i] AS row
         CREATE (:Event {seq: seq, payload: row.payload, node: row.node, from: row.from, to: row.to})`,
        { rows },
      );
    },
    since: (after) => read("MATCH (e:Event) WHERE e.seq > $after RETURN e ORDER BY e.seq", { after: neo4j.int(after) }),
    history: (id, upTo) =>
      read(
        "MATCH (e:Event) WHERE e.seq <= $upTo AND (e.node = $id OR e.from = $id OR e.to = $id) RETURN e ORDER BY e.seq",
        { id, upTo: neo4j.int(upTo) },
      ),
  };
}

// The last commit ingested per repository, as (:Ingestion {repo, sha}) outside the :Node label.
export function createNeo4jIngestionState(driver: Driver): IngestionState {
  return {
    async last(repo) {
      const { records } = await driver.executeQuery("MATCH (i:Ingestion {repo: $repo}) RETURN i.sha AS sha", { repo });
      return records[0]?.get("sha") as string | undefined;
    },
    async record(repo, sha) {
      await driver.executeQuery("MERGE (i:Ingestion {repo: $repo}) SET i.sha = $sha", { repo, sha });
    },
  };
}

// Nodes waiting for revalidation, as (:Stale) outside the :Node label: the evidence they hold is
// code, read by the model only. A later mark replaces an earlier one.
export function createNeo4jStaleMarks(driver: Driver): StaleMarks {
  return {
    async mark(marks) {
      if (marks.length === 0) return;
      await driver.executeQuery(
        "UNWIND $marks AS m MERGE (s:Stale {id: m.id}) SET s.change = m.change, s.evidence = m.evidence, s.user = m.user, s.teams = m.teams",
        { marks: marks.map((m) => ({ id: m.id, change: m.change, evidence: m.evidence, user: m.author.user, teams: [...m.author.teams] })) },
      );
    },
    async get(id) {
      const { records } = await driver.executeQuery("MATCH (s:Stale {id: $id}) RETURN s", { id });
      const s = records[0]?.get("s").properties as { id: string; change: string; evidence: string; user: string; teams: string[] } | undefined;
      return s === undefined ? undefined : { id: s.id, change: s.change, evidence: s.evidence, author: { user: s.user, teams: s.teams } };
    },
    async clear(id) {
      await driver.executeQuery("MATCH (s:Stale {id: $id}) DELETE s", { id });
    },
  };
}

interface Row {
  id: string;
  type: string;
  scopeKind: Scope["kind"];
  // The team or user the scope belongs to; the teams of a `teams` scope are in scopeTeams.
  scopeOwner: string | null;
  scopeTeams: string[] | null;
  provenanceSource: string;
  provenancePath: string;
  provenanceSha: string | null;
  title: string | null;
  body: string | null;
}

function toRow(node: Node): Row {
  const { scope, provenance } = node;
  return {
    id: node.id,
    type: node.type,
    scopeKind: scope.kind,
    scopeOwner: scope.kind === "team" ? scope.team : scope.kind === "private" ? scope.user : null,
    scopeTeams: scope.kind === "teams" ? [...scope.teams] : null,
    provenanceSource: provenance.source,
    provenancePath: provenance.path,
    provenanceSha: provenance.sha ?? null,
    title: node.title ?? null,
    body: node.body ?? null,
  };
}

function fromRecord(record: Neo4jRecord): Node {
  const row = record.get("n").properties as Row;
  const scope =
    row.scopeKind === "team"
      ? { kind: "team", team: row.scopeOwner }
      : row.scopeKind === "teams"
        ? { kind: "teams", teams: row.scopeTeams }
        : row.scopeKind === "private"
          ? { kind: "private", user: row.scopeOwner }
          : { kind: row.scopeKind };
  const provenance = {
    source: row.provenanceSource,
    path: row.provenancePath,
    ...(row.provenanceSha === null || row.provenanceSha === undefined ? {} : { sha: row.provenanceSha }),
  };
  const title = row.title === null || row.title === undefined ? {} : { title: row.title };
  const body = row.body === null || row.body === undefined ? {} : { body: row.body };
  return NodeSchema.parse({ id: row.id, type: row.type, scope, provenance, ...title, ...body });
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
