import { useState, type FormEvent } from "react";
import type { Principal } from "@graph-warden/core";
import { api, HttpError, type Answer } from "../api.js";
import { nameOf, type Store } from "../graph.js";
import { pageHref, renderMarkdown } from "../markdown.js";
import { Badges } from "./Badges.js";

// A question answered from the nodes its asker may read (proposal 0011). Filing the answer makes it
// a node derived from every node read, private to the asker unless they choose a scope, which
// derivation can only narrow.

const MESSAGES: Record<number, string> = {
  403: "Only writers may file answers.",
  501: "No language model is configured on this API.",
};

export function Ask({ store, from, principal }: { store: Store; from?: string; principal: Principal }) {
  const [question, setQuestion] = useState("");
  const [around, setAround] = useState(from !== undefined);
  const [save, setSave] = useState(false);
  const [scope, setScope] = useState(`private:${principal.user}`);
  const [answer, setAnswer] = useState<Answer>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const anchor = from === undefined ? undefined : store.nodes.get(from);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setAnswer(
        await api.ask(question, {
          ...(around && from !== undefined ? { from } : {}),
          ...(save ? { save: true, scope } : {}),
        }),
      );
    } catch (cause) {
      setAnswer(undefined);
      setError(MESSAGES[cause instanceof HttpError ? cause.status : 0] ?? (cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(false);
    }
  };

  const scopes = [`private:${principal.user}`, ...principal.teams.map((team) => `team:${team}`), "shared"];
  return (
    <section className="ask">
      <h1>Ask</h1>
      <p className="hint">Answered from the nodes you may read, and only those. Every node read is in the audit log.</p>
      <form onSubmit={(event) => void ask(event)}>
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} placeholder="What breaks if /orders moves to cursor pagination?" required />
        <div className="options">
          {anchor === undefined ? null : (
            <label>
              <input type="checkbox" checked={around} onChange={(event) => setAround(event.target.checked)} /> Start from “{nameOf(anchor)}”
            </label>
          )}
          <label>
            <input type="checkbox" checked={save} onChange={(event) => setSave(event.target.checked)} /> File the answer as a node
          </label>
          {save ? (
            <select value={scope} onChange={(event) => setScope(event.target.value)} aria-label="Scope of the filed answer">
              {scopes.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          ) : null}
          <button type="submit" disabled={busy || question.trim() === ""}>
            {busy ? "Asking…" : "Ask"}
          </button>
        </div>
      </form>
      {error === undefined ? null : <p className="error">{error}</p>}
      {answer === undefined ? null : (
        <>
          <div className="body" dangerouslySetInnerHTML={{ __html: renderMarkdown(answer.answer) }} />
          {answer.saved === undefined ? null : (
            <p>
              Filed as <a href={pageHref(answer.saved.id)}>{nameOf(answer.saved)}</a> <Badges node={answer.saved} />
            </p>
          )}
          <section className="related">
            <h2>Read to answer</h2>
            <ul>
              {answer.sources.map((node) => (
                <li key={node.id}>
                  <a href={pageHref(node.id)}>{nameOf(node)}</a> <Badges node={node} />
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
