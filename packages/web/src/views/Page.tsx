import type { EdgeType } from "@graph-warden/core";
import { incoming, nameOf, outgoing, type Relation, type Store } from "../graph.js";
import { pageHref, renderMarkdown, withoutTitle } from "../markdown.js";
import { Badges } from "./Badges.js";

function Related({ title, relations, typed = false }: { title: string; relations: readonly Relation[]; typed?: boolean }) {
  if (relations.length === 0) return null;
  return (
    <section className="related">
      <h2>{title}</h2>
      <ul>
        {relations.map(({ type, node }) => (
          <li key={`${type} ${node.id}`}>
            <a href={pageHref(node.id)}>{nameOf(node)}</a> {typed ? <span className="edge">{type}</span> : null} <Badges node={node} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const derived = (relations: readonly Relation[], derivedFrom: boolean) =>
  relations.filter(({ type }) => (type === ("DERIVED_FROM" satisfies EdgeType)) === derivedFrom);

export function Page({ store, id }: { store: Store; id: string }) {
  const node = store.nodes.get(id);
  // An unknown node and one the reader may not see look the same.
  if (node === undefined) {
    return (
      <section>
        <h1>Not found</h1>
        <p>
          There is no node <code>{id}</code>, or you may not read it.
        </p>
      </section>
    );
  }
  const out = outgoing(store, id);
  const into = incoming(store, id);
  const { provenance } = node;
  const text = withoutTitle(node.body ?? "", node.title);
  return (
    <article>
      <h1>{nameOf(node)}</h1>
      <p className="meta">
        <Badges node={node} /> <code className="id">{node.id}</code>
      </p>
      <p className="provenance">
        From <strong>{provenance.source}</strong> · {provenance.path}
        {provenance.sha === undefined ? null : <> · <code>{provenance.sha.slice(0, 12)}</code></>}
      </p>
      {text.trim() === "" ? (
        <p className="hint">This node has no text.</p>
      ) : (
        <div className="body" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      )}
      <div className="panels">
        <Related title="Derived from" relations={derived(out, true)} />
        <Related title="Links to" relations={derived(out, false)} typed />
        <Related title="Used by" relations={derived(into, true)} />
        <Related title="Linked from" relations={derived(into, false)} typed />
      </div>
    </article>
  );
}
