import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { EdgeTypeSchema, parseScope, type Principal, type Scope, type TraversalOptions } from "@graph-warden/core";
import type { Page } from "@graph-warden/documents";

export const USAGE = `Usage:
  gwarden ingest <dir> --source <name> --user <user> [--team <team>]... [--where key=value]...
                 [--default-scope <scope>]
  gwarden traverse <node-id> (--api <url> --token <token> | --user <user> [--team <team>]...)
                   [--direction out|in|both] [--depth <n>] [--edge <TYPE>]...
  gwarden audit [--api <url> --token <token>] [--user <user>]
  gwarden pull --api <url> --token <token> [--cache <file>]
  gwarden cache [--cache <file>]
  gwarden show <node-id> --api <url> --token <token>
  gwarden search <words>... --api <url> --token <token> [--limit <n>]
  gwarden ask "<question>" --api <url> --token <token> [--from <node-id>] [--save [--scope <scope>]]
  gwarden delete <node-id> --api <url> --token <token> [--confirm <node-id>]
  gwarden impact <repo-dir> --source <name> --base <ref> [--head <ref>] [--scope <scope>] [--team <team>]...
                 [--comment <owner/repo>#<number>]

Scopes: shared, team:<name>, teams:<a>,<b> (members of every team), private:<user>. A document without a scope: field is private to the
ingesting --user unless --default-scope says otherwise. Every traverse is recorded in the audit log, which
audit prints oldest first.

--team lists the groups the identity provider reports for --user, nested groups included. A document
derived from others (DERIVED_FROM) is narrowed so that only readers of all its sources read it; the
ingesting --user and --team must read every source. Neo4j settings come from NEO4J_URI, NEO4J_USER and
NEO4J_PASSWORD (see .env.example).

Readers go through the API, as the user their token stands for: --api and --token, or GWARDEN_API and
GWARDEN_TOKEN. pull fetches what changed since the last pull into a local SQLite cache (default
~/.graph-warden/cache.db); cache lists it, offline. Without an API, ingest, traverse and audit talk to
Neo4j directly: that is for whoever operates the graph, and traverse then needs --user and --team.

ask answers from the nodes the token's user may read, citing them; --from anchors it on a node.
--save files the answer as a node derived from every node the model read, private to the user
unless --scope declares a wider one (narrowed to the readers of all its sources). delete shows
what would go (the node, and the nodes derived only from what is deleted) and asks you to type the
node id; --confirm <node-id> types it for you, in scripts. Both need a writer group to write.

impact ingests the commits from --base to --head (HEAD by default) of a clone into a copy of the
graph read from Neo4j, never the graph itself, and prints the endpoints they touch, the modules
consuming them by package, and the decisions and documents to check. It lists only nodes readable
by --team (shared only without it): the report is for everyone who reads the pull request.
--scope is the repository's scope (shared by default). --comment posts it on the pull request,
replacing the previous report, with GITHUB_TOKEN.`;

export interface Remote {
  readonly api: string;
  readonly token: string;
}

// Where a read goes: the API as the token's user, or Neo4j directly as an operator.
export type Through = ({ readonly kind: "api" } & Remote) | { readonly kind: "neo4j" };

export type Command =
  | {
      readonly name: "ingest";
      readonly dir: string;
      readonly source: string;
      readonly include: (page: Page) => boolean;
      readonly defaultScope: Scope;
      readonly author: Principal;
    }
  | {
      readonly name: "traverse";
      readonly start: string;
      // Required when reading Neo4j directly; the API takes the principal from the token.
      readonly principal?: Principal;
      readonly options: TraversalOptions;
      readonly through: Through;
    }
  | {
      readonly name: "audit";
      readonly user?: string;
      readonly through: Through;
    }
  | ({
      readonly name: "pull";
      readonly cache: string;
    } & Remote)
  | {
      readonly name: "cache";
      readonly cache: string;
    }
  | ({ readonly name: "show"; readonly id: string } & Remote)
  | ({ readonly name: "search"; readonly query: string; readonly limit?: number } & Remote)
  | ({
      readonly name: "ask";
      readonly question: string;
      readonly from?: string;
      readonly save: boolean;
      readonly scope?: string;
    } & Remote)
  | {
      readonly name: "impact";
      readonly dir: string;
      readonly source: string;
      readonly base: string;
      readonly head: string;
      readonly scope: Scope;
      readonly reader: Principal;
      readonly comment?: { readonly repo: string; readonly pull: number };
    }
  | ({
      readonly name: "delete";
      readonly id: string;
      // The node id typed in advance, for scripts; without it, delete asks for it.
      readonly confirm?: string;
    } & Remote);

export function parseCommand(argv: readonly string[]): Command {
  const [name, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      source: { type: "string" },
      where: { type: "string", multiple: true, default: [] },
      "default-scope": { type: "string" },
      user: { type: "string" },
      team: { type: "string", multiple: true, default: [] },
      direction: { type: "string", default: "out" },
      depth: { type: "string" },
      edge: { type: "string", multiple: true },
      api: { type: "string" },
      token: { type: "string" },
      cache: { type: "string" },
      from: { type: "string" },
      save: { type: "boolean", default: false },
      scope: { type: "string" },
      confirm: { type: "string" },
      limit: { type: "string" },
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      comment: { type: "string" },
    },
  });
  const cache = values.cache ?? join(homedir(), ".graph-warden", "cache.db");
  if (name === "cache") return { name, cache };
  const api = values.api ?? process.env.GWARDEN_API;
  const remote = (): Remote => {
    if (api === undefined || api === "") throw new Error("--api or GWARDEN_API is required");
    const token = values.token ?? process.env.GWARDEN_TOKEN;
    if (token === undefined || token === "") throw new Error("--token or GWARDEN_TOKEN is required");
    return { api: api.replace(/\/+$/, ""), token };
  };
  const through = (): Through => (api === undefined || api === "" ? { kind: "neo4j" } : { kind: "api", ...remote() });
  if (name === "pull") return { name, cache, ...remote() };
  if (name === "audit") return { name, through: through(), ...(values.user === undefined ? {} : { user: values.user }) };

  const [target] = positionals;
  if (target === undefined) throw new Error(USAGE);

  switch (name) {
    case "show":
      return { name, id: target, ...remote() };
    case "search": {
      const limit = values.limit === undefined ? undefined : Number(values.limit);
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit must be a positive integer");
      return { name, query: positionals.join(" "), ...(limit === undefined ? {} : { limit }), ...remote() };
    }
    case "ask": {
      if (values.scope !== undefined && !values.save) throw new Error("--scope needs --save");
      if (values.scope !== undefined) parseScope(values.scope);
      return {
        name,
        question: positionals.join(" "),
        save: values.save,
        ...(values.from === undefined ? {} : { from: values.from }),
        ...(values.scope === undefined ? {} : { scope: values.scope }),
        ...remote(),
      };
    }
    case "impact": {
      if (values.source === undefined) throw new Error("--source is required");
      if (values.base === undefined) throw new Error("--base is required");
      const comment = values.comment === undefined ? undefined : /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(values.comment);
      if (comment === null) throw new Error("--comment expects owner/repo#number");
      return {
        name,
        dir: target,
        source: values.source,
        base: values.base,
        head: values.head,
        scope: parseScope(values.scope ?? "shared"),
        reader: { user: values.user ?? "pull-request", teams: values.team },
        ...(comment === undefined ? {} : { comment: { repo: comment[1] ?? "", pull: Number(comment[2]) } }),
      };
    }
    case "delete":
      return { name, id: target, ...(values.confirm === undefined ? {} : { confirm: values.confirm }), ...remote() };
    case "ingest": {
      if (values.source === undefined) throw new Error("--source is required");
      if (values.user === undefined) throw new Error("--user is required");
      const filters = values.where.map(parseFilter);
      return {
        name,
        dir: target,
        source: values.source,
        include: (page) => filters.every(([key, value]) => matches(page.frontmatter[key], value)),
        defaultScope: parseScope(values["default-scope"] ?? `private:${values.user}`),
        author: { user: values.user, teams: values.team },
      };
    }
    case "traverse": {
      const via = through();
      if (via.kind === "neo4j" && values.user === undefined) throw new Error("--user is required without --api");
      const { direction } = values;
      if (direction !== "out" && direction !== "in" && direction !== "both") {
        throw new Error("--direction must be out, in or both");
      }
      const depth = values.depth === undefined ? undefined : Number(values.depth);
      if (depth !== undefined && !(Number.isInteger(depth) && depth > 0)) {
        throw new Error("--depth must be a positive integer");
      }
      return {
        name,
        start: target,
        ...(values.user === undefined ? {} : { principal: { user: values.user, teams: values.team } }),
        through: via,
        options: {
          direction,
          ...(depth === undefined ? {} : { maxDepth: depth }),
          ...(values.edge === undefined ? {} : { edgeTypes: values.edge.map((edge) => EdgeTypeSchema.parse(edge)) }),
        },
      };
    }
    default:
      throw new Error(USAGE);
  }
}

function parseFilter(filter: string): [string, string] {
  const at = filter.indexOf("=");
  if (at <= 0) throw new Error(`--where expects key=value, got "${filter}"`);
  return [filter.slice(0, at), filter.slice(at + 1)];
}

// A frontmatter field matches a value when it equals it, or when it is a list containing it.
function matches(field: unknown, value: string): boolean {
  return Array.isArray(field) ? field.map(String).includes(value) : String(field) === value;
}
