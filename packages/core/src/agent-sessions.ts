import { createHash } from "node:crypto";
import { Forbidden, recorder, type AuditLog } from "./audit.js";
import { NotFound } from "./deletion.js";
import { Conflict } from "./editor.js";
import type { Writer } from "./events.js";
import type { Node } from "./ontology.js";
import { Invalid } from "./pages.js";
import { redact, type Redacted } from "./redaction.js";
import { canRead, formatScope, type Principal, type Scope } from "./scope.js";
import type { GraphStore } from "./store.js";

// Coding-agent sessions (issue #27): what a developer and their agent did, captured as a
// `Session` node private to the developer, whatever the capture says. Nothing of a session reaches
// anyone else but by promotion: the author previews the session redacted of secrets and personal
// data, then promotes exactly that text (named by its digest) to a scope they read. The private
// text is replaced, not kept beside the promoted one, and a promoted session is not captured over.

export const sessionSource = (user: string): string => `session:${user}`;
export const sessionId = (user: string, id: string): string => `session:${user}:${id}`;

export interface Capture {
  // The agent's own session id.
  readonly id: string;
  readonly title?: string;
  readonly transcript: string;
}

export interface Preview extends Redacted {
  readonly id: string;
  // Names the redacted text: a promotion carries it, and is refused if the session changed.
  readonly digest: string;
}

export interface AgentSessions {
  capture(principal: Principal, capture: Capture): Promise<Node>;
  preview(principal: Principal, id: string): Promise<Preview>;
  promote(principal: Principal, id: string, scope: Scope, digest: string): Promise<Node>;
}

const isPrivateTo = (node: Node, user: string) => node.scope.kind === "private" && node.scope.user === user;
const digestOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function createAgentSessions(store: GraphStore, writer: Writer, audit: AuditLog, options: { readonly now?: () => Date } = {}): AgentSessions {
  const record = recorder(audit, options.now);

  // The author's own session, or not found: another user's session is never told apart from none.
  const own = async (principal: Principal, id: string): Promise<Node> => {
    const node = await store.getNode(id);
    if (node === undefined || node.type !== "Session" || node.provenance.source !== sessionSource(principal.user)) {
      throw new NotFound(`No session ${id}`);
    }
    return node;
  };

  return {
    async capture(principal, capture) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(capture.id)) throw new Invalid("a session id is 1 to 128 letters, digits, dots, dashes or underscores");
      const id = sessionId(principal.user, capture.id);
      const current = await store.getNode(id);
      if (current !== undefined && !isPrivateTo(current, principal.user)) throw new Conflict(`${id} was promoted: it is not captured again`);
      const title = capture.title?.trim();
      const node: Node = {
        id,
        type: "Session",
        scope: { kind: "private", user: principal.user },
        provenance: { source: sessionSource(principal.user), path: capture.id },
        ...(title ? { title } : {}),
        body: capture.transcript,
      };
      await record({ action: "capture", target: id, returned: [id] }, principal);
      await writer.upsertNodes([node]);
      return node;
    },

    async preview(principal, id) {
      const node = await own(principal, id);
      const redacted = redact(`${node.title ?? ""}\n${node.body ?? ""}`);
      const [title = "", ...rest] = redacted.text.split("\n");
      await record({ action: "promote", target: id, scope: formatScope(node.scope), returned: [id], planned: true }, principal);
      return { id, text: rest.join("\n"), findings: redacted.findings, digest: digestOf(`${title}\n${rest.join("\n")}`) };
    },

    async promote(principal, id, scope, digest) {
      const node = await own(principal, id);
      if (scope.kind === "private") throw new Invalid("a session is promoted to a team or shared scope");
      if (!canRead(principal, scope)) {
        await record({ action: "promote", target: id, scope: formatScope(scope), returned: [], denied: true }, principal);
        throw new Forbidden(`${principal.user} could not read a session scoped ${formatScope(scope)}`);
      }
      if (!isPrivateTo(node, principal.user)) throw new Conflict(`${id} is already promoted`);
      const redacted = redact(`${node.title ?? ""}\n${node.body ?? ""}`);
      const [title = "", ...rest] = redacted.text.split("\n");
      const body = rest.join("\n");
      if (digestOf(`${title}\n${body}`) !== digest) throw new Conflict(`${id} changed since its preview`);
      const promoted: Node = { ...node, scope, ...(title ? { title } : {}), body };
      await record({ action: "promote", target: id, scope: formatScope(scope), returned: [id] }, principal);
      await writer.upsertNodes([promoted]);
      return promoted;
    },
  };
}
