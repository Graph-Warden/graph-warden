import { EdgeTypeSchema, requiredTeams, type Node, type Principal, type Reader } from "@graph-warden/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// The MCP server (proposal 0007, issue #12): the graph as tools for any MCP client (Claude Code,
// an IDE, an agent). It is one more door on the reader, never on the store: each request is made
// as the principal its bearer token stands for, every tool reads through the reader, which checks
// scopes on every hop and records the read in the audit log. A tool never says anything of a node
// the principal may not read, not even that it exists.

const PREVIEW = 400;

// What a tool shows of a node: the body only when asked for one node, a preview otherwise.
const summary = (node: Node) => ({
  id: node.id,
  type: node.type,
  ...(node.title === undefined ? {} : { title: node.title }),
  scope: node.scope,
  ...(node.body === undefined ? {} : { preview: node.body.length > PREVIEW ? `${node.body.slice(0, PREVIEW)}…` : node.body }),
});

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export function createMcpServer(reader: Reader, principal: Principal): McpServer {
  const server = new McpServer(
    { name: "graph-warden", version: "0.0.0" },
    {
      instructions:
        "Graph-Warden is the organisation's knowledge graph: code modules, endpoints, decisions, incidents, documents. " +
        `Every answer is limited to what ${principal.user} may read, and every call is audited. ` +
        "Start with search, open a node with get_node, follow its links with neighbourhood, and ask impact before changing a module or an endpoint.",
    },
  );
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    "search",
    {
      title: "Search the graph",
      description: "Nodes matching words, best first: their id, type, title, scope and a preview of their text.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
      annotations: readOnly,
    },
    async ({ query, limit }) => json((await reader.search(principal, query, limit === undefined ? {} : { limit })).map(summary)),
  );

  server.registerTool(
    "get_node",
    {
      title: "Read a node",
      description: "One node by id, with its whole text and where it comes from (source, path, commit).",
      inputSchema: { id: z.string().min(1) },
      annotations: readOnly,
    },
    async ({ id }) => {
      try {
        return json(await reader.node(principal, id));
      } catch {
        return { ...json({ error: `No node ${id}` }), isError: true };
      }
    },
  );

  server.registerTool(
    "neighbourhood",
    {
      title: "Follow a node's links",
      description: "Nodes linked to a node, up to a depth, through edges of the given types (IMPORTS, CONSUMES, DECIDES, DERIVED_FROM…) or all.",
      inputSchema: {
        id: z.string().min(1),
        direction: z.enum(["out", "in", "both"]).optional(),
        depth: z.number().int().min(1).max(5).optional(),
        edgeTypes: z.array(EdgeTypeSchema).optional(),
      },
      annotations: readOnly,
    },
    async ({ id, direction, depth, edgeTypes }) =>
      json(
        (
          await reader.traverse(principal, id, {
            direction: direction ?? "both",
            maxDepth: depth ?? 1,
            ...(edgeTypes === undefined ? {} : { edgeTypes }),
          })
        ).map(summary),
      ),
  );

  server.registerTool(
    "impact",
    {
      title: "What a change would affect",
      description:
        "Everything that depends on these nodes (modules importing them, endpoints they expose, consumers of those endpoints, decisions and documents about them), nearest first, with the teams concerned.",
      inputSchema: { ids: z.array(z.string().min(1)).min(1).max(50) },
      annotations: readOnly,
    },
    async ({ ids }) => {
      const related = await reader.related(principal, ids);
      const teams = [...new Set(related.flatMap(({ node }) => requiredTeams(node.scope)))].sort();
      return json({ related: related.map(({ node, depth }) => ({ depth, ...summary(node) })), teams });
    },
  );

  server.registerTool(
    "recent_changes",
    {
      title: "What changed for my teams",
      description:
        "Nodes written since a cursor (0: everything), those of the caller's teams first unless all is set, and the cursor to pass next time.",
      inputSchema: { after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional(), all: z.boolean().optional() },
      annotations: readOnly,
    },
    async ({ after, limit, all }) => {
      const delta = await reader.pull(principal, after ?? 0);
      const mine = (node: Node) => requiredTeams(node.scope).some((team) => principal.teams.includes(team));
      const nodes = all === true ? delta.nodes : delta.nodes.filter(mine);
      return json({ cursor: delta.cursor, nodes: nodes.slice(0, limit ?? 50).map(summary), removed: delta.removed });
    },
  );

  return server;
}
