import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeSchema, type Delta, type Node, type Principal } from "@graph-warden/core";

// The local cache filled by `gwarden pull` (proposal 0006): the part of the graph one principal may
// read, as of a cursor. It holds only what the API sent, so it never needs to check scopes. It
// belongs to one API and one principal: if either changes, groups included, it is emptied and
// pulled again from the start, since a node readable under the old groups may not be any more.
// That protects an honest client; nothing can make a hostile one forget what it was once sent.

export interface Cache {
  // The cursor to pull from for this API: 0 when the cache is new or holds another API's data.
  cursor(api: string): number;
  // Whether the cache was filled for this API and this principal, groups included.
  ownedBy(api: string, principal: Principal): boolean;
  clear(): void;
  apply(api: string, principal: Principal, delta: Delta): void;
  nodes(): Node[];
  edgeCount(): number;
  close(): void;
}

export function openCache(path: string): Cache {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, node TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS edges (type TEXT NOT NULL, "from" TEXT NOT NULL, "to" TEXT NOT NULL, PRIMARY KEY (type, "from", "to"));
  `);
  const owner = (api: string, principal: Principal) =>
    JSON.stringify({ api, user: principal.user, teams: [...principal.teams].sort() });
  const meta = (key: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");

  return {
    cursor: (api) => (meta("api") === api ? Number(meta("cursor") ?? 0) : 0),
    ownedBy: (api, principal) => meta("owner") === owner(api, principal),
    clear: () => db.exec("DELETE FROM nodes; DELETE FROM edges; DELETE FROM meta;"),

    apply(api, principal, delta) {
      db.exec("BEGIN");
      try {
        const dropEdges = db.prepare(`DELETE FROM edges WHERE "from" = ? OR "to" = ?`);
        const dropNode = db.prepare("DELETE FROM nodes WHERE id = ?");
        for (const id of delta.removed) {
          dropNode.run(id);
          dropEdges.run(id, id);
        }
        const putNode = db.prepare("INSERT INTO nodes (id, node) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET node = excluded.node");
        // A delta carries every readable edge of the nodes it sends, so theirs are replaced: an
        // edge removed since the cursor (a source detached by a deletion) goes too.
        for (const node of delta.nodes) {
          putNode.run(node.id, JSON.stringify(node));
          dropEdges.run(node.id, node.id);
        }
        const putEdge = db.prepare(`INSERT OR IGNORE INTO edges (type, "from", "to") VALUES (?, ?, ?)`);
        for (const edge of delta.edges) putEdge.run(edge.type, edge.from, edge.to);
        setMeta.run("api", api);
        setMeta.run("owner", owner(api, principal));
        setMeta.run("cursor", String(delta.cursor));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    nodes: () =>
      (db.prepare("SELECT node FROM nodes ORDER BY id").all() as { node: string }[]).map((row) => NodeSchema.parse(JSON.parse(row.node))),
    edgeCount: () => (db.prepare("SELECT count(*) AS n FROM edges").get() as { n: number }).n,
    close: () => db.close(),
  };
}
