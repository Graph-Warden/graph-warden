import type { Connector, Edge, Node, Scope } from "@graph-warden/core";
import { requiredTeams, teamsScope } from "@graph-warden/core";
import { z } from "zod";

// Confluence (issue #20): the pages of some spaces as nodes, a page `BELONGS_TO` its parent and
// `REFERENCES` the pages it links to.
//
// Scopes come from Confluence's permissions, the space's and the page's:
// - a space anonymous users read is `shared`; one granted to groups, the members of every group
//   (Confluence grants to members of any of them, which a scope cannot say: requiring all narrows,
//   never widens). Anything else (a user, a role) needs a scope given in `scopes`, or the space is
//   not read;
// - a page restricted to groups (on itself or an ancestor) narrows its space's scope to them; a page
//   restricted to users only is not read: those users are not something the graph can check.
// Permissions change without pages changing, so `readScopes` reads them alone, without page
// bodies: the worker resyncs them more often than content.

export interface ConfluenceOptions {
  // `https://acme.atlassian.net`: the API is under /wiki.
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
  // Space keys.
  readonly spaces: readonly string[];
  readonly scopes?: Readonly<Record<string, Scope>>;
  readonly team?: (group: string) => string;
  readonly fetch?: typeof fetch;
}

export const pageId = (id: string): string => `confluence:${id}`;

const Space = z.object({ id: z.string(), key: z.string() });
const Page = z.object({
  id: z.string(),
  title: z.string(),
  parentId: z.string().nullable().optional(),
  body: z.object({ storage: z.object({ value: z.string() }).optional() }).optional(),
});
const Listing = <T extends z.ZodType>(item: T) => z.object({ results: z.array(item), _links: z.object({ next: z.string().optional() }).optional() });
const Permission = z.object({
  principal: z.object({ type: z.string(), id: z.string().optional() }),
  operation: z.object({ key: z.string(), targetType: z.string() }),
});
const Group = z.object({ name: z.string().min(1) });
const Restrictions = z.object({
  restrictions: z.object({
    user: z.object({ results: z.array(z.unknown()) }).optional(),
    group: z.object({ results: z.array(Group) }).optional(),
  }),
});

export class UnmappedPermissions extends Error {
  override readonly name = "UnmappedPermissions";
}

// Storage format (XHTML) as text, and the titles of the pages it links to.
export function storageText(xhtml: string): { readonly text: string; readonly links: readonly string[] } {
  const links = [...xhtml.matchAll(/<ri:page\b[^>]*ri:content-title="([^"]+)"/g)].map((m) => decode(m[1] ?? ""));
  const text = decode(
    xhtml
      .replace(/<(?:br|\/p|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n"),
  ).trim();
  return { text, links: [...new Set(links)] };
}
const decode = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[entity] ?? "");

export function createConfluenceConnector(options: ConfluenceOptions): Connector {
  const { baseUrl, email, token, spaces, scopes = {}, team = (group) => group, fetch: send = fetch } = options;
  const source = `confluence:${new URL(baseUrl).host}`;
  const root = `${baseUrl.replace(/\/+$/, "")}/wiki`;
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  const get = async (path: string): Promise<unknown> => {
    const response = await send(path.startsWith("http") ? path : `${root}${path}`, { headers: { authorization, accept: "application/json" } });
    if (!response.ok) throw new Error(`Confluence ${path}: ${response.status}`);
    return response.json();
  };
  const all = async <T extends z.ZodType>(path: string, item: T): Promise<z.infer<T>[]> => {
    const items: z.infer<T>[] = [];
    for (let next: string | undefined = path; next !== undefined; ) {
      const page = Listing(item).parse(await get(next));
      items.push(...page.results);
      next = page._links?.next;
    }
    return items;
  };

  const spaceOf = async (key: string) => {
    const [space] = (await all(`/api/v2/spaces?keys=${encodeURIComponent(key)}`, Space)).filter((s) => s.key === key);
    if (space === undefined) throw new Error(`Confluence: no space ${key}`);
    return space;
  };
  const spaceScope = async (key: string, id: string): Promise<Scope> => {
    const given = scopes[key];
    if (given !== undefined) return given;
    const reads = (await all(`/api/v2/spaces/${id}/permissions`, Permission)).filter((p) => p.operation.key === "read" && p.operation.targetType === "space");
    if (reads.some((p) => p.principal.type === "anonymous")) return { kind: "shared" };
    const groups = reads.filter((p) => p.principal.type === "group");
    const other = reads.filter((p) => p.principal.type !== "group");
    if (groups.length === 0 || other.length > 0) {
      throw new UnmappedPermissions(`${key}: read is granted to ${reads.map((p) => p.principal.type).join(", ") || "nobody"}; give the space a scope`);
    }
    const names = await Promise.all(groups.map(async (p) => Group.parse(await get(`/rest/api/group/by-id?id=${encodeURIComponent(p.principal.id ?? "")}`)).name));
    return teamsScope(names.map(team));
  };
  // The groups a page's own read restrictions name; `undefined` when users alone may read it.
  const restriction = async (page: string): Promise<readonly string[] | undefined> => {
    const { restrictions } = Restrictions.parse(await get(`/rest/api/content/${page}/restriction/byOperation/read`));
    const groups = (restrictions.group?.results ?? []).map((group) => group.name);
    const users = restrictions.user?.results.length ?? 0;
    return groups.length === 0 && users > 0 ? undefined : groups;
  };

  // Every page of the spaces with its scope: the space's, narrowed by the restrictions of the page
  // and its ancestors. A page under a user-restricted page is not read either.
  const scoped = async (withBodies: boolean) => {
    const pages: { page: z.infer<typeof Page>; scope: Scope; space: string }[] = [];
    for (const key of [...spaces].sort()) {
      const space = await spaceOf(key);
      const base = await spaceScope(key, space.id);
      const listed = await all(`/api/v2/spaces/${space.id}/pages?limit=250${withBodies ? "&body-format=storage" : ""}`, Page);
      const byId = new Map(listed.map((page) => [page.id, page]));
      const own = new Map<string, readonly string[] | undefined>();
      for (const page of listed) own.set(page.id, await restriction(page.id));
      const resolve = (id: string, seen = new Set<string>()): readonly string[] | undefined => {
        const groups = own.get(id);
        if (groups === undefined) return undefined;
        const parent = byId.get(id)?.parentId;
        if (parent === null || parent === undefined || !byId.has(parent) || seen.has(id)) return groups;
        const above = resolve(parent, new Set([...seen, id]));
        return above === undefined ? undefined : [...groups, ...above];
      };
      for (const page of listed) {
        const groups = resolve(page.id);
        if (groups === undefined) continue;
        const scope = groups.length === 0 ? base : narrow(base, groups.map(team));
        pages.push({ page, scope, space: key });
      }
    }
    return pages;
  };

  return {
    source,
    async read() {
      const pages = await scoped(true);
      const byTitle = new Map(pages.map(({ page, space }) => [`${space} ${page.title}`, page.id]));
      const kept = new Set(pages.map(({ page }) => page.id));
      const nodes: Node[] = [];
      const edges: Edge[] = [];
      for (const { page, scope, space } of pages) {
        const { text, links } = storageText(page.body?.storage?.value ?? "");
        nodes.push({ id: pageId(page.id), type: "Concept", scope, provenance: { source, path: `spaces/${space}/pages/${page.id}` }, title: page.title, ...(text === "" ? {} : { body: text }) });
        if (page.parentId && kept.has(page.parentId)) edges.push({ type: "BELONGS_TO", from: pageId(page.id), to: pageId(page.parentId) });
        for (const title of links) {
          const target = byTitle.get(`${space} ${title}`);
          if (target !== undefined && target !== page.id) edges.push({ type: "REFERENCES", from: pageId(page.id), to: pageId(target) });
        }
      }
      return { nodes, edges };
    },
    async readScopes() {
      return new Map((await scoped(false)).map(({ page, scope }) => [pageId(page.id), scope]));
    },
  };
}

// A space scope narrowed to members of `groups` too.
function narrow(base: Scope, groups: readonly string[]): Scope {
  return base.kind === "private" ? base : teamsScope([...requiredTeams(base), ...groups]);
}
