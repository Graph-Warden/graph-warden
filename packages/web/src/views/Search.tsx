import { filterNodes, nameOf, type Store } from "../graph.js";
import { pageHref } from "../markdown.js";
import { Badges } from "./Badges.js";

const excerpt = (body: string | undefined) => (body ?? "").replace(/\s+/g, " ").trim().slice(0, 180);

export function Search({ store, query }: { store: Store; query: string }) {
  const nodes = filterNodes(store, query);
  return (
    <section>
      <h1>{query === "" ? "Everything you may read" : `Search: ${query}`}</h1>
      <p className="hint">
        {nodes.length} {nodes.length === 1 ? "node" : "nodes"}
      </p>
      <ul className="results">
        {nodes.map((node) => (
          <li key={node.id}>
            <a href={pageHref(node.id)}>{nameOf(node)}</a> <Badges node={node} />
            {node.title === undefined ? null : <code className="id">{node.id}</code>}
            {node.body === undefined ? null : <p>{excerpt(node.body)}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
