import { useEffect, useState, type FormEvent } from "react";
import type { NodeType, Principal } from "@graph-warden/core";
import { api, HttpError } from "../api.js";
import { formatScope, NODE_TYPES } from "../graph.js";
import { pageHref, renderMarkdown } from "../markdown.js";

// Writing a wiki page (proposal 0012). The page is saved over the version opened: if someone else
// saved it meanwhile, the API refuses, and the text typed here stays for the author to merge.

const MESSAGES: Record<number, string> = {
  403: "Only members of a writer group may save pages.",
  409: "This id is taken by a node that is not an editable page, or other nodes derive from this page and its scope cannot change.",
  412: "Someone saved this page after you opened it. Your text is still here: load the latest version in another tab, merge, and save again.",
  501: "Pages are not enabled on this API.",
};

export function Editor({ id, principal }: { id?: string; principal: Principal }) {
  const [version, setVersion] = useState<string | null | undefined>(id === undefined ? null : undefined);
  const [pageId, setPageId] = useState(id ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState(`private:${principal.user}`);
  const [type, setType] = useState<NodeType>("Concept");
  // The core types until the API answers with the organisation's too.
  const [types, setTypes] = useState<readonly NodeType[]>(NODE_TYPES);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.ontology().then(
      (ontology) => setTypes(ontology.nodeTypes),
      () => undefined,
    );
  }, []);

  useEffect(() => {
    if (id === undefined) return;
    api.node(id).then(
      ({ node, version: current }) => {
        if (node.provenance.source !== "wiki") {
          setError("This node comes from an ingested source: change it there, and ingest again.");
          return;
        }
        setTitle(node.title ?? "");
        setBody(node.body ?? "");
        setScope(formatScope(node.scope));
        setType(node.type);
        setVersion(current);
      },
      () => setError(`There is no page ${id}, or you may not read it.`),
    );
  }, [id]);

  const scopes = [...new Set([`private:${principal.user}`, ...principal.teams.map((team) => `team:${team}`), "shared", scope])];

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (version === undefined) return;
    setSaving(true);
    try {
      const saved = await api.savePage(pageId.trim(), { title, body, scope, type }, version);
      window.location.hash = pageHref(saved.node.id);
    } catch (cause) {
      const status = cause instanceof HttpError ? cause.status : 0;
      setError(MESSAGES[status] ?? (cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setSaving(false);
    }
  };

  if (id !== undefined && version === undefined) {
    return <section>{error === undefined ? <p className="hint">Loading…</p> : <p className="error">{error}</p>}</section>;
  }

  return (
    <form className="editor" onSubmit={(event) => void save(event)}>
      <h1>{id === undefined ? "New page" : `Edit ${title || id}`}</h1>
      <div className="fields">
        <label>
          Id
          <input value={pageId} onChange={(event) => setPageId(event.target.value)} disabled={id !== undefined} required placeholder="team/runbook" />
        </label>
        <label>
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} required />
        </label>
        <label>
          Who may read it
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            {scopes.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select value={type} onChange={(event) => setType(event.target.value as NodeType)}>
            {types.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="split">
        <label>
          <span>
            Text (Markdown; <code>[[id]]</code> links to a node)
          </span>
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={18} />
        </label>
        <div className="preview body" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
      </div>
      {error === undefined ? null : <p className="error">{error}</p>}
      <p className="actions">
        <button type="submit" disabled={saving || pageId.trim() === "" || title.trim() === ""}>
          {saving ? "Saving…" : "Save"}
        </button>
        <a href={id === undefined ? "#/" : pageHref(id)}>Cancel</a>
      </p>
    </form>
  );
}
