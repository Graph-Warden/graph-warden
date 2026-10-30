import { useState } from "react";
import type { Node } from "@graph-warden/core";
import { api, HttpError, type DeletionPlan } from "../api.js";
import { nameOf } from "../graph.js";
import { pageHref } from "../markdown.js";

// Deletion as in the CLI (proposal 0011): the plan first, with everything that would go, then the
// deletion only once the node's id is typed back, and only if the graph did not change since.

const MESSAGES: Record<number, string> = {
  403: "You may not delete this: only writers may, and only what they may read entirely.",
  409: "The graph changed since this was shown. Look again before deleting.",
  501: "Deletion is not enabled on this API.",
};

export function Delete({ node }: { node: Node }) {
  const [plan, setPlan] = useState<DeletionPlan>();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const fail = (cause: unknown) => setError(MESSAGES[cause instanceof HttpError ? cause.status : 0] ?? String(cause));
  const show = async () => {
    setError(undefined);
    setTyped("");
    try {
      setPlan(await api.planDeletion(node.id));
    } catch (cause) {
      setPlan(undefined);
      fail(cause);
    }
  };
  const remove = async () => {
    if (plan === undefined) return;
    setBusy(true);
    try {
      await api.deleteNode(node.id, plan.digest);
      window.location.hash = "#/";
    } catch (cause) {
      fail(cause);
      if (cause instanceof HttpError && cause.status === 409) setPlan(undefined);
    } finally {
      setBusy(false);
    }
  };

  if (plan === undefined) {
    return (
      <div className="danger">
        <button type="button" onClick={() => void show()}>
          Delete…
        </button>
        {error === undefined ? null : <p className="error">{error}</p>}
      </div>
    );
  }
  const entries = plan.deleted.length + plan.detached.length;
  return (
    <div className="danger open" role="alertdialog" aria-labelledby="delete-title">
      <h2 id="delete-title">
        Are you sure? It will delete {entries} {entries === 1 ? "entry" : "entries"} from “{nameOf(node)}”.
      </h2>
      <ul>
        {plan.deleted.map((gone) => (
          <li key={gone.id}>
            <a href={pageHref(gone.id)}>{nameOf(gone)}</a> {gone.id === node.id ? "(this node)" : "(derived from it, and from nothing else)"}
          </li>
        ))}
        {plan.detached.map((edge) => (
          <li key={`${edge.from}>${edge.to}`}>
            The link from <code>{edge.from}</code> to it; <code>{edge.from}</code> stays, it has other sources.
          </li>
        ))}
      </ul>
      <label>
        <span>
          Type <code>{node.id}</code> to confirm
        </span>
        <input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
      </label>
      {error === undefined ? null : <p className="error">{error}</p>}
      <p className="actions">
        <button type="button" className="destructive" disabled={busy || typed !== node.id} onClick={() => void remove()}>
          {busy ? "Deleting…" : `Delete ${entries} ${entries === 1 ? "entry" : "entries"}`}
        </button>
        <button type="button" onClick={() => setPlan(undefined)}>
          Cancel
        </button>
      </p>
    </div>
  );
}
