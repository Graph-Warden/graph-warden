import type { Extracted } from "./conformance.js";
import { narrowDependents } from "./derivation.js";
import type { Writer } from "./events.js";
import type { Edge, Node } from "./ontology.js";
import { formatScope, type Scope } from "./scope.js";
import type { GraphStore } from "./store.js";

// Sources read through an API rather than git (issues #19, #20, #21): GitLab merge requests, Jira
// issues, Confluence pages. A connector reads everything its source holds now, with the scope of
// each item from the source's own permissions; a sync makes the graph hold exactly that for the
// source: new and changed nodes written, nodes gone deleted, edges from the source's nodes
// replaced. Permissions change without content changing, so a connector may also read scopes
// alone, more often than content: `rescope` writes only scopes.
//
// Either way, nodes derived from the source's (answers filed from a page) narrow with them.

export interface Connector {
  // The provenance source of every node it gives: `jira:acme.atlassian.net`.
  readonly source: string;
  read(): Promise<Extracted>;
  // The scope of each node as the source's permissions say now, without reading content.
  readScopes?(): Promise<ReadonlyMap<string, Scope>>;
}

export interface SyncReport {
  readonly upserted: number;
  readonly deleted: readonly string[];
  // Nodes whose scope changed, and nodes derived from them narrowed with them.
  readonly rescoped: readonly string[];
  readonly narrowed: readonly string[];
}

export interface ConnectorSync {
  sync(connector: Connector): Promise<SyncReport>;
  rescope(connector: Connector): Promise<SyncReport>;
}

const key = (edge: Edge) => `${edge.type} ${edge.from} ${edge.to}`;

export function createConnectorSync(store: GraphStore, writer: Writer): ConnectorSync {
  return {
    async sync(connector) {
      const { nodes, edges } = await connector.read();
      const wrong = nodes.find((node) => node.provenance.source !== connector.source);
      if (wrong !== undefined) throw new Error(`${wrong.id}: provenance ${wrong.provenance.source}, not ${connector.source}`);
      const before = await store.snapshot();
      const owned = [...before.nodes.values()].filter((node) => node.provenance.source === connector.source);
      const kept = new Set(nodes.map((node) => node.id));
      const deleted = owned.filter((node) => !kept.has(node.id)).map((node) => node.id);
      const gone = new Set(deleted);
      const exists = (id: string) => kept.has(id) || (before.nodes.has(id) && !gone.has(id));
      const fresh = edges.filter((edge) => kept.has(edge.from) && exists(edge.to));
      const freshKeys = new Set(fresh.map(key));
      const stale = before.edges.filter((edge) => kept.has(edge.from) && before.nodes.get(edge.from)?.provenance.source === connector.source && !freshKeys.has(key(edge)));
      const rescoped = nodes.filter((node) => {
        const old = before.nodes.get(node.id);
        return old !== undefined && formatScope(old.scope) !== formatScope(node.scope);
      });

      await writer.upsertNodes(nodes);
      await writer.deleteEdges(stale);
      await writer.upsertEdges(fresh);
      for (const id of deleted) await writer.deleteNode(id);
      const narrowed = narrowDependents(await store.snapshot(), rescoped.map((node) => node.id));
      await writer.upsertNodes(narrowed);
      return { upserted: nodes.length, deleted, rescoped: rescoped.map((node) => node.id), narrowed: narrowed.map((node) => node.id) };
    },

    async rescope(connector) {
      if (connector.readScopes === undefined) throw new Error(`${connector.source} cannot read permissions alone`);
      const scopes = await connector.readScopes();
      const graph = await store.snapshot();
      const changed: Node[] = [];
      for (const [id, scope] of scopes) {
        const node = graph.nodes.get(id);
        if (node === undefined || node.provenance.source !== connector.source) continue;
        if (formatScope(node.scope) !== formatScope(scope)) changed.push({ ...node, scope });
      }
      // A node the source no longer lets anyone read through its permissions (no scope given) is
      // left to the next content sync, which deletes it: rescope only rewrites scopes.
      await writer.upsertNodes(changed);
      const narrowed = narrowDependents(await store.snapshot(), changed.map((node) => node.id));
      await writer.upsertNodes(narrowed);
      return { upserted: 0, deleted: [], rescoped: changed.map((node) => node.id), narrowed: narrowed.map((node) => node.id) };
    },
  };
}
