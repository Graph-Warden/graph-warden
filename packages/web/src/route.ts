import { useEffect, useState } from "react";

// Routes live in the URL fragment, so the API serves one page for all of them and a link to a
// node never reaches a server log.

export type Route =
  | { readonly view: "home" }
  | { readonly view: "node"; readonly id: string }
  | { readonly view: "search"; readonly query: string }
  | { readonly view: "graph"; readonly id?: string };

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
  if (parts[0] === "search") return { view: "search", query: new URLSearchParams(search).get("q") ?? "" };
  return { view: "home" };
}

export const graphHref = (id?: string) => (id === undefined ? "#/graph" : `#/graph/${encodeURIComponent(id)}`);

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
