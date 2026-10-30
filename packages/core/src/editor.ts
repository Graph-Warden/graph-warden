import { Forbidden, recorder, type AuditLog } from "./audit.js";
import { planDeletion, type DeletionPlan } from "./deletion.js";
import type { Writer } from "./events.js";
import type { Principal } from "./scope.js";
import type { GraphStore } from "./store.js";

// Deletion on behalf of a user (proposal 0011). Only members of a writer group may delete, and only
// what they may read: the node itself, every node the deletion removes and every node that loses a
// source. A deletion is shown before it is made: `planDeletion` returns what would go and a digest,
// and `deleteNode` runs only with the digest of a plan that still matches the graph.

export interface Editor {
  planDeletion(principal: Principal, id: string): Promise<DeletionPlan>;
  // Rejects with `Conflict` when the graph changed since the plan with this digest was made.
  deleteNode(principal: Principal, id: string, digest: string): Promise<DeletionPlan>;
}

export interface EditorOptions {
  // Groups whose members may delete. None by default: nobody deletes through the editor.
  readonly writers?: readonly string[];
  readonly now?: () => Date;
}

export class Conflict extends Error {
  override readonly name = "Conflict";
}

const edgeName = (e: { readonly from: string; readonly to: string }) => `${e.from}>${e.to}`;

export function createEditor(store: GraphStore, writer: Writer, audit: AuditLog, options: EditorOptions = {}): Editor {
  const { writers = [], now } = options;
  const record = recorder(audit, now);

  // Refusals are recorded too, without naming anything the principal may not read.
  const plan = async (principal: Principal, id: string, planned: boolean): Promise<DeletionPlan> => {
    const denied = { action: "delete", target: id, detached: [], returned: [], denied: true, ...(planned ? { planned } : {}) } as const;
    if (!writers.some((group) => principal.teams.includes(group))) {
      await record(denied, principal);
      throw new Forbidden(`${principal.user} is not in a writer group`);
    }
    try {
      return planDeletion(await store.snapshot(), principal, id);
    } catch (error) {
      // An unknown node, an unreadable one and a deletion reaching too far are recorded alike.
      await record(denied, principal);
      throw error;
    }
  };

  return {
    async planDeletion(principal, id) {
      const result = await plan(principal, id, true);
      await record(
        { action: "delete", target: id, planned: true, detached: result.detached.map(edgeName), returned: result.deleted.map((n) => n.id) },
        principal,
      );
      return result;
    },

    async deleteNode(principal, id, digest) {
      const result = await plan(principal, id, false);
      if (result.digest !== digest) throw new Conflict(`The graph changed since this deletion of ${id} was shown`);
      // Recorded before the writes, like a read before its result: a deletion that cannot be
      // audited does not happen.
      await record({ action: "delete", target: id, detached: result.detached.map(edgeName), returned: result.deleted.map((n) => n.id) }, principal);
      await writer.deleteEdges(result.detached);
      for (const node of result.deleted) await writer.deleteNode(node.id);
      return result;
    },
  };
}
