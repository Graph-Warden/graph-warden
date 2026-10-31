import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Node } from "@graph-warden/core";
import { api, HttpError, type ImpactView, type PastGraph } from "../api.js";
import { nameOf } from "../graph.js";
import { pageHref } from "../markdown.js";
import { historyHref, impactHref } from "../route.js";
import { GraphCanvas } from "./GraphView.js";

// The past of a repository (issue #16): a commit picked from its history and the graph as it was
// then, or a pull request's impact as a highlighted subgraph. The API shows a past node only to
// who may read it both then and now.

const MESSAGES: Record<number, string> = {
  404: "This API does not have that repository or commit.",
  501: "No repositories are configured on this API.",
};
const failure = (cause: unknown) => MESSAGES[cause instanceof HttpError ? cause.status : 0] ?? (cause instanceof Error ? cause.message : String(cause));
const short = (sha: string) => sha.slice(0, 8);
const shaOf = (change: Node) => change.provenance.sha ?? change.id.slice(change.id.lastIndexOf("@") + 1);

// Runs `load` again whenever one of `keys` changes, keeping the last result.
function useLoad<T>(load: () => Promise<T> | undefined, keys: readonly unknown[]): { value?: T; error?: string } {
  const [state, setState] = useState<{ value?: T; error?: string }>({});
  useEffect(() => {
    let current = true;
    setState({});
    load()?.then(
      (value) => current && setState({ value }),
      (cause: unknown) => current && setState({ error: failure(cause) }),
    );
    return () => {
      current = false;
    };
  }, keys);
  return state;
}

export function History({ repo, sha }: { repo?: string; sha?: string }) {
  const repositories = useLoad(() => api.repositories().then((r) => r.repositories), []);
  const chosen = repo ?? (repositories.value?.length === 1 ? repositories.value[0] : undefined);
  const commits = useLoad(() => (chosen === undefined ? undefined : api.commits(chosen).then((r) => r.nodes)), [chosen]);
  const past = useLoad<PastGraph>(() => (chosen === undefined || sha === undefined ? undefined : api.graphAt(chosen, sha)), [chosen, sha]);
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const compare = (event: FormEvent) => {
    event.preventDefault();
    if (chosen !== undefined) window.location.hash = impactHref(chosen, base.trim(), head.trim());
  };
  const changes = commits.value ?? [];

  return (
    <section className="graph-view">
      <h1>{chosen === undefined ? "History" : sha === undefined ? chosen : `${chosen} at ${short(sha)}`}</h1>
      {repositories.error === undefined ? null : <p className="error">{repositories.error}</p>}
      {(repositories.value?.length ?? 0) > 1 ? (
        <p className="hint">
          {repositories.value?.map((name) => (
            <a key={name} href={historyHref(name)} className={name === chosen ? "current" : undefined}>
              {name}
            </a>
          ))}
        </p>
      ) : null}
      {chosen === undefined ? null : (
        <>
          <p className="hint">The repository as it was at a commit: only what you may read both then and now. Pick one, or compare two as a pull request would.</p>
          {commits.error === undefined ? null : <p className="error">{commits.error}</p>}
          <ol className="commits">
            {changes.map((change, i) => {
              const at = shaOf(change);
              const parent = changes[i + 1];
              return (
                <li key={change.id} className={sha !== undefined && at.startsWith(sha) ? "current" : undefined}>
                  <a href={historyHref(chosen, at)}>
                    <code>{short(at)}</code> {nameOf(change)}
                  </a>
                  {parent === undefined ? null : (
                    <>
                      {" "}
                      · <a href={impactHref(chosen, shaOf(parent), at)}>impact</a>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
          <form className="compare" onSubmit={compare}>
            <input aria-label="Base commit" placeholder="base sha" value={base} onChange={(event) => setBase(event.target.value)} />
            <input aria-label="Head commit" placeholder="head sha" value={head} onChange={(event) => setHead(event.target.value)} />
            <button type="submit" disabled={base.trim() === "" || head.trim() === ""}>
              Impact
            </button>
          </form>
          {past.error === undefined ? null : <p className="error">{past.error}</p>}
          {past.value === undefined ? null : <GraphCanvas nodes={past.value.nodes} edges={past.value.edges} />}
        </>
      )}
    </section>
  );
}

export function Impact({ repo, base, head }: { repo: string; base: string; head: string }) {
  const view = useLoad<ImpactView>(() => api.impact(repo, base, head), [repo, base, head]);
  const highlighted = useMemo(() => new Set(view.value?.highlighted ?? []), [view.value]);
  const list = (nodes: readonly Node[]) =>
    nodes.map((node, i) => (
      <span key={node.id}>
        {i === 0 ? "" : ", "}
        <a href={pageHref(node.id)}>{nameOf(node)}</a>
      </span>
    ));
  const impact = view.value?.impact;
  return (
    <section className="graph-view">
      <h1>
        Impact of {short(base)}..{short(head)}
      </h1>
      <p className="hint">
        {repo}
        {view.value === undefined ? "" : `, ${view.value.commits} ${view.value.commits === 1 ? "commit" : "commits"}`}. What the changes reach is in colour, with its neighbours. <a href={historyHref(repo)}>History</a>
      </p>
      {view.error === undefined ? null : <p className="error">{view.error}</p>}
      {impact === undefined ? null : (
        <dl className="impact">
          <dt>Endpoints</dt>
          <dd>{impact.endpoints.length === 0 ? "none" : list(impact.endpoints)}</dd>
          <dt>Consumers</dt>
          <dd>{impact.consumers.length === 0 ? "none" : list(impact.consumers.map((consumer) => consumer.module))}</dd>
          <dt>Knowledge to check</dt>
          <dd>{impact.knowledge.length === 0 ? "none" : list(impact.knowledge)}</dd>
          <dt>Teams</dt>
          <dd>{impact.teams.length === 0 ? "none" : impact.teams.join(", ")}</dd>
        </dl>
      )}
      {view.value === undefined ? null : <GraphCanvas nodes={view.value.nodes} edges={view.value.edges} highlighted={highlighted} />}
    </section>
  );
}
