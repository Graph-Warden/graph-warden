import { useState, type FormEvent, type ReactNode } from "react";
import type { Node, NodeType, Principal } from "@graph-warden/core";
import { nameOf, type Store } from "../graph.js";
import { pageHref } from "../markdown.js";
import { askHref, editHref, graphHref, historyHref, searchHref } from "../route.js";

export function Shell(props: {
  principal: Principal;
  store: Store;
  error: string | undefined;
  live: boolean;
  onRefresh: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const search = (event: FormEvent) => {
    event.preventDefault();
    window.location.hash = searchHref(query);
  };

  const byType = new Map<NodeType, Node[]>();
  for (const node of props.store.nodes.values()) byType.set(node.type, [...(byType.get(node.type) ?? []), node]);
  const types = [...byType.keys()].sort();

  return (
    <div className="shell">
      <header>
        <a className="brand" href="#/">
          Graph-Warden
        </a>
        <form className="search" onSubmit={search} role="search">
          <input type="search" placeholder="Search what you may read" value={query} onChange={(event) => setQuery(event.target.value)} />
        </form>
        <a href={graphHref()}>Graph</a>
        <a href={historyHref()}>History</a>
        <a href={askHref()}>Ask</a>
        <a href={editHref()}>New page</a>
        <span className={props.live ? "live on" : "live"} title={props.live ? "Changes show up as they happen" : "Not receiving changes: refresh to update"}>
          {props.live ? "Live" : "Offline"}
        </span>
        <span className="who" title={props.principal.teams.join(", ")}>
          {props.principal.user}
        </span>
        <button type="button" onClick={props.onRefresh}>
          Refresh
        </button>
        <button type="button" onClick={props.onSignOut}>
          Sign out
        </button>
      </header>
      <nav aria-label="Nodes by type">
        {types.map((type) => (
          <details key={type} open>
            <summary>
              {type} <span className="count">{byType.get(type)?.length}</span>
            </summary>
            <ul>
              {(byType.get(type) ?? [])
                .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
                .map((node) => (
                  <li key={node.id}>
                    <a href={pageHref(node.id)}>{nameOf(node)}</a>
                  </li>
                ))}
            </ul>
          </details>
        ))}
      </nav>
      <main>
        {props.error === undefined ? null : <p className="error">The API could not be reached: {props.error}</p>}
        {props.children}
      </main>
    </div>
  );
}
