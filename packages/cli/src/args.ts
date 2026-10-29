import { parseArgs } from "node:util";
import { EdgeTypeSchema, type Principal, type Scope, type TraversalOptions } from "@graph-warden/core";
import { parseScope, type Page } from "@graph-warden/documents";

export const USAGE = `Usage:
  gwarden ingest <dir> --source <name> --user <user> [--where key=value]...
                 [--default-scope <scope>]
  gwarden traverse <node-id> --user <user> [--team <team>]... [--direction out|in|both]
                   [--depth <n>] [--edge <TYPE>]...
  gwarden audit [--user <user>]

Scopes: shared, team:<name>, private:<user>. A document without a scope: field is private to the
ingesting --user unless --default-scope says otherwise. Every traverse is recorded in the audit log, which
audit prints oldest first. Neo4j settings come from NEO4J_URI, NEO4J_USER and
NEO4J_PASSWORD (see .env.example).`;

export type Command =
  | {
      readonly name: "ingest";
      readonly dir: string;
      readonly source: string;
      readonly include: (page: Page) => boolean;
      readonly defaultScope: Scope;
    }
  | {
      readonly name: "traverse";
      readonly start: string;
      readonly principal: Principal;
      readonly options: TraversalOptions;
    }
  | {
      readonly name: "audit";
      readonly user?: string;
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
    },
  });
  if (name === "audit") return values.user === undefined ? { name } : { name, user: values.user };

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
      };
    }
    case "traverse": {
      if (values.user === undefined) throw new Error("--user is required");
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
        principal: { user: values.user, teams: values.team },
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
