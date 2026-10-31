import { useEffect, useState } from "react";

// Routes live in the URL fragment, so the API serves one page for all of them and a link to a
// node never reaches a server log.

export type Route =
  | { readonly view: "home" }
  | { readonly view: "node"; readonly id: string }
  | { readonly view: "search"; readonly query: string }
  | { readonly view: "graph"; readonly id?: string }
  | { readonly view: "edit"; readonly id?: string }
  | { readonly view: "ask"; readonly from?: string }
  // A repository at a commit (issue #16); without them, the commit to pick.
  | { readonly view: "history"; readonly repo?: string; readonly sha?: string }
  | { readonly view: "impact"; readonly repo: string; readonly base: string; readonly head: string };

export function parseRoute(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter((part) => part !== "");
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  if (parts[0] === "node" && parts.length >= 2) return { view: "node", id: decode(parts.slice(1).join("/")) };
  if (parts[0] === "graph") return parts.length >= 2 ? { view: "graph", id: decode(parts.slice(1).join("/")) } : { view: "graph" };
  if (parts[0] === "edit") return parts.length >= 2 ? { view: "edit", id: decode(parts.slice(1).join("/")) } : { view: "edit" };
  if (parts[0] === "ask") {
    const from = new URLSearchParams(search).get("from");
    return from === null ? { view: "ask" } : { view: "ask", from };
  }
  if (parts[0] === "history") {
    const params = new URLSearchParams(search);
    const [repo, sha] = [params.get("repo"), params.get("sha")];
    return { view: "history", ...(repo === null ? {} : { repo }), ...(repo === null || sha === null ? {} : { sha }) };
  }
  if (parts[0] === "impact") {
    const params = new URLSearchParams(search);
    const [repo, base, head] = [params.get("repo"), params.get("base"), params.get("head")];
    if (repo !== null && base !== null && head !== null) return { view: "impact", repo, base, head };
    return repo === null ? { view: "history" } : { view: "history", repo };
  }
  if (parts[0] === "search") return { view: "search", query: new URLSearchParams(search).get("q") ?? "" };
  return { view: "home" };
}

export const graphHref = (id?: string) => (id === undefined ? "#/graph" : `#/graph/${encodeURIComponent(id)}`);

export const editHref = (id?: string) => (id === undefined ? "#/edit" : `#/edit/${encodeURIComponent(id)}`);

export const askHref = (from?: string) => (from === undefined ? "#/ask" : `#/ask?${new URLSearchParams({ from }).toString()}`);

export const historyHref = (repo?: string, sha?: string) =>
  repo === undefined ? "#/history" : `#/history?${new URLSearchParams({ repo, ...(sha === undefined ? {} : { sha }) }).toString()}`;

export const impactHref = (repo: string, base: string, head: string) => `#/impact?${new URLSearchParams({ repo, base, head }).toString()}`;

export const searchHref = (query: string) => `#/search?${new URLSearchParams({ q: query }).toString()}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
