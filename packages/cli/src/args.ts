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
Neo4j directly: that is for whoever operates the graph, and traverse then needs --user and --team.`;

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
    };

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
