import { createHash } from "node:crypto";
import { Forbidden, recorder, type AuditLog } from "./audit.js";
import { Conflict } from "./editor.js";
import type { Writer } from "./events.js";
import type { Edge, Node, NodeType } from "./ontology.js";
import { canRead, formatScope, type Principal, type Scope } from "./scope.js";
import type { GraphStore } from "./store.js";

// Wiki pages (proposal 0012): nodes written in the web app rather than ingested. A page is a node
// whose provenance source is `wiki`; an ingested node is changed in its source and ingested again,
// never here, or the next ingestion would undo the edit. Only members of a writer group save
// pages, only into a scope they read themselves, and only over the version they were shown: a
// save carries the version it edits, and is refused if the page changed since.
//
// The page's `[[links]]` become `REFERENCES` edges to the nodes its author may read, and to the
// nodes it already referenced, which another author could read: an edit never drops a link its
// author cannot see, and never reveals whether an unreadable node exists.

export const WIKI_SOURCE = "wiki";

export interface Draft {
  readonly title: string;
  readonly body: string;
  readonly scope: Scope;
  readonly type?: NodeType;
}

export interface SavedPage {
  readonly node: Node;
  readonly version: string;
  readonly created: boolean;
}

export interface Pages {
  // `expected` is the version the author edited, or null for a page that must not exist yet.
  // Rejects with `Stale` when it does not match, `Conflict` when the id belongs to a node that is
  // not a page (or that the author may not read), `Forbidden` without a writer group.
  save(principal: Principal, id: string, draft: Draft, expected: string | null): Promise<SavedPage>;
}

export interface PagesOptions {
  readonly writers?: readonly string[];
  readonly now?: () => Date;
}

export class Stale extends Error {
  override readonly name = "Stale";
}

export class Invalid extends Error {
  override readonly name = "Invalid";
}

// Keys sorted at every level, so that the same node gives the same version whatever store it
// came from.
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

export const pageVersion = (node: Node): string => createHash("sha256").update(canonical(node)).digest("hex").slice(0, 16);

export const isPage = (node: Node): boolean => node.provenance.source === WIKI_SOURCE;

const WIKILINK = /\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g;

export const wikilinks = (text: string): string[] => [...new Set([...text.matchAll(WIKILINK)].map((match) => (match[1] ?? "").trim()))].filter((id) => id !== "");

export function createPages(store: GraphStore, writer: Writer, audit: AuditLog, options: PagesOptions = {}): Pages {
  const { writers = [], now } = options;
  const record = recorder(audit, now);

  return {
    async save(principal, id, draft, expected) {
      const denied = { action: "edit", target: id, returned: [], denied: true } as const;
      if (!writers.some((group) => principal.teams.includes(group))) {
        await record(denied, principal);
        throw new Forbidden(`${principal.user} is not in a writer group`);
      }
      if (!canRead(principal, draft.scope)) {
        await record(denied, principal);
        throw new Invalid(`${principal.user} could not read a page scoped ${formatScope(draft.scope)}`);
      }
      const type = draft.type ?? "Concept";
      if (!writer.ontology.nodeTypes.includes(type)) throw new Invalid(`node type ${type} is not in the ontology`);
      const graph = await store.snapshot();
      const current = graph.nodes.get(id);
      // A node the author may not read and a node that is not a page are refused alike.
      if (current !== undefined && (!canRead(principal, current.scope) || !isPage(current))) {
        await record(denied, principal);
        throw new Conflict(`${id} is taken by a node that is not an editable page`);
      }
      // A page created, changed or deleted since the author opened it.
      if ((current === undefined ? null : pageVersion(current)) !== expected) throw new Stale(`${id} changed since it was opened`);
      if (current !== undefined && formatScope(current.scope) !== formatScope(draft.scope)) {
        // Nodes derived from the page took its scope into theirs; a new scope would not reach them.
        if (graph.edges.some((edge) => edge.type === "DERIVED_FROM" && edge.to === id)) {
          throw new Conflict(`Other nodes are derived from ${id}: its scope cannot change`);
        }
      }

      const node: Node = {
        id,
        type,
        scope: draft.scope,
        provenance: { source: WIKI_SOURCE, path: id },
        title: draft.title,
        body: draft.body,
      };
      const before = graph.edges.filter((edge) => edge.type === "REFERENCES" && edge.from === id);
      const linked = wikilinks(draft.body).filter((target) => target !== id);
      const after: Edge[] = linked
        .filter((target) => {
          const other = graph.nodes.get(target);
          return other !== undefined && (canRead(principal, other.scope) || before.some((edge) => edge.to === target));
        })
        .map((target) => ({ type: "REFERENCES", from: id, to: target }));

      // Recorded before the writes: a change that cannot be audited does not happen.
      await record({ action: "edit", target: id, returned: [id], ...(current === undefined ? { created: true } : {}) }, principal);
      await writer.upsertNodes([node]);
      await writer.deleteEdges(before.filter((edge) => !after.some((kept) => kept.to === edge.to)));
      await writer.upsertEdges(after.filter((edge) => !before.some((had) => had.to === edge.to)));
      return { node, version: pageVersion(node), created: current === undefined };
    },
  };
}
