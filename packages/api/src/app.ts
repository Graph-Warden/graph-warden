import {
  AuditEntrySchema,
  Conflict,
  EdgeSchema,
  EdgeTypeSchema,
  Forbidden,
  NotFound,
  parseScope,
  Unreachable,
  type Asker,
  type DeletionPlan,
  type Editor,
  NodeSchema,
  PullResponseSchema,
  Unauthenticated,
  type IdentityProvider,
  type Principal,
  type Reader,
} from "@graph-warden/core";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";

// The API (proposal 0003): the one place readers reach the graph. Every route below `/v1` takes a
// bearer token, turns it into a principal through the identity provider, and reads through the
// reader, which checks scopes on every hop and writes the audit entry. No route reads the store
// directly. Ingestion is the writer's job, behind the API; the only writes made through it are a
// deletion and a filed answer, by members of a writer group, both through the domain (proposal
// 0011).

export interface ApiOptions {
  readonly reader: Reader;
  readonly identity: IdentityProvider;
  // Deletion; without it, the deletion routes answer 501.
  readonly editor?: Editor;
  // Questions; without a model configured, /v1/ask answers 501.
  readonly asker?: Asker;
  readonly logger?: boolean;
}

const TraverseQuery = z.object({
  direction: z.enum(["out", "in", "both"]).default("out"),
  depth: z.coerce.number().int().positive().optional(),
  edge: z
    .union([EdgeTypeSchema, z.array(EdgeTypeSchema)])
    .transform((edge) => (Array.isArray(edge) ? edge : [edge]))
    .optional(),
});
const PullQuery = z.object({ after: z.coerce.number().int().nonnegative().default(0) });
const AuditQuery = z.object({ user: z.string().min(1).optional() });
const DeleteQuery = z.object({ confirm: z.string().min(1) });
const AskBody = z.object({
  question: z.string().min(1).max(4000),
  from: z.string().min(1).optional(),
  // File the answer; `scope` is the scope declared for it, private to the asker by default.
  save: z.boolean().default(false),
  scope: z.string().min(1).optional(),
});

const PrincipalResponse = PullResponseSchema.unwrap().shape.principal;
const NodesResponse = z.object({ nodes: z.array(NodeSchema) });
const AuditResponse = z.object({ entries: z.array(AuditEntrySchema) });
const DeletionResponse = z.object({
  target: z.string(),
  deleted: z.array(NodeSchema),
  detached: z.array(EdgeSchema),
  digest: z.string(),
});
const AskResponse = z.object({ answer: z.string(), sources: z.array(NodeSchema), saved: NodeSchema.optional() });
const deletion = (plan: DeletionPlan) =>
  DeletionResponse.parse({ target: plan.target.id, deleted: plan.deleted, detached: plan.detached, digest: plan.digest });

class NotConfigured extends Error {}

class BadRequest extends Error {}

export function buildApi(options: ApiOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  const principalOf = async (request: FastifyRequest): Promise<Principal> => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token === "") throw new Unauthenticated("A bearer token is required");
    return options.identity.principalFor(token);
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new BadRequest(z.prettifyError(result.error));
    return result.data;
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Unauthenticated) {
      // The reason stays in the server log: it would tell a caller which part of a forged token failed.
      request.log.info({ reason: error.message }, "unauthenticated");
      return reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthenticated" });
    }
    if (error instanceof Forbidden) return reply.code(403).send({ error: "forbidden" });
    if (error instanceof Unreachable) {
      return reply.code(403).send({ error: "forbidden", detail: "the deletion would change nodes you may not read" });
    }
    if (error instanceof NotFound) return reply.code(404).send({ error: "not found" });
    if (error instanceof Conflict) return reply.code(409).send({ error: "conflict", detail: error.message });
    if (error instanceof NotConfigured) return reply.code(501).send({ error: "not configured", detail: error.message });
    if (error instanceof BadRequest) return reply.code(400).send({ error: "bad request", detail: error.message });
    request.log.error(error);
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/openapi.json", async () => openApi);

  app.get("/v1/me", async (request) => PrincipalResponse.parse(await principalOf(request)));

  app.get<{ Params: { id: string } }>("/v1/nodes/:id/neighbours", async (request) => {
    const principal = await principalOf(request);
    const query = parse(TraverseQuery, request.query);
    const nodes = await options.reader.traverse(principal, request.params.id, {
      direction: query.direction,
      ...(query.depth === undefined ? {} : { maxDepth: query.depth }),
      ...(query.edge === undefined ? {} : { edgeTypes: query.edge }),
    });
    return { nodes };
  });

  app.get("/v1/pull", async (request) => {
    const principal = await principalOf(request);
    const { after } = parse(PullQuery, request.query);
    const delta = await options.reader.pull(principal, after);
    return PullResponseSchema.parse({ principal, delta });
  });

  app.get("/v1/audit", async (request) => {
    const principal = await principalOf(request);
    const { user } = parse(AuditQuery, request.query);
    return { entries: await options.reader.auditTrail(principal, user === undefined ? {} : { user }) };
  });

  app.get<{ Params: { id: string } }>("/v1/nodes/:id/deletion", async (request) => {
    const principal = await principalOf(request);
    if (options.editor === undefined) throw new NotConfigured("deletion is not enabled on this API");
    return deletion(await options.editor.planDeletion(principal, request.params.id));
  });

  app.delete<{ Params: { id: string } }>("/v1/nodes/:id", async (request) => {
    const principal = await principalOf(request);
    if (options.editor === undefined) throw new NotConfigured("deletion is not enabled on this API");
    const { confirm } = parse(DeleteQuery, request.query);
    return deletion(await options.editor.deleteNode(principal, request.params.id, confirm));
  });

  app.post("/v1/ask", async (request) => {
    const principal = await principalOf(request);
    if (options.asker === undefined) throw new NotConfigured("no language model is configured on this API");
    const body = parse(AskBody, request.body);
    let scope;
    try {
      scope = body.scope === undefined ? undefined : parseScope(body.scope);
    } catch (error) {
      throw new BadRequest(`scope: ${error instanceof Error ? error.message : String(error)}`);
    }
    const result = await options.asker.ask(principal, body.question, {
      ...(body.from === undefined ? {} : { from: body.from }),
      ...(body.save ? { save: scope === undefined ? {} : { scope } } : {}),
    });
    return AskResponse.parse(result);
  });

  return app;
}

const json = (schema: z.ZodType) => ({ "application/json": { schema: z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) } });
const errors = {
  "400": { description: "Invalid parameters" },
  "401": { description: "Missing, invalid or expired token" },
};

export const openApi = {
  openapi: "3.1.0",
  info: {
    title: "Graph-Warden API",
    version: "0.0.0",
    description:
      "The governed knowledge graph. Every /v1 route needs a bearer token from the configured identity provider; scopes are checked on every hop, and every read, question and deletion is audited.",
  },
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  security: [{ bearer: [] }],
  paths: {
    "/healthz": { get: { summary: "Liveness", security: [], responses: { "200": { description: "Up" } } } },
    "/v1/me": { get: { summary: "The principal the token stands for", responses: { "200": { description: "Principal", content: json(PrincipalResponse) }, ...errors } } },
    "/v1/nodes/{id}/neighbours": {
      get: {
        summary: "Nodes reachable from a node, as the caller may see them",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "direction", in: "query", schema: { type: "string", enum: ["out", "in", "both"], default: "out" } },
          { name: "depth", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "edge", in: "query", schema: { type: "array", items: z.toJSONSchema(EdgeTypeSchema) }, style: "form", explode: true },
        ],
        responses: { "200": { description: "Reachable nodes, nearest first; empty for an unknown or unreadable start", content: json(NodesResponse) }, ...errors },
      },
    },
    "/v1/pull": {
      get: {
        summary: "What changed since a cursor, as the caller may see it",
        parameters: [{ name: "after", in: "query", schema: { type: "integer", minimum: 0, default: 0 } }],
        responses: { "200": { description: "Delta and the principal it was computed for", content: json(PullResponseSchema) }, ...errors },
      },
    },
    "/v1/audit": {
      get: {
        summary: "The audit log, for members of an auditor group",
        parameters: [{ name: "user", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "Entries, oldest first", content: json(AuditResponse) }, ...errors, "403": { description: "Not an auditor" } },
      },
    },
    "/v1/nodes/{id}/deletion": {
      get: {
        summary: "What deleting a node would remove, and the digest to confirm it with",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The node, the derived nodes left without a source, the DERIVED_FROM edges detached", content: json(DeletionResponse) },
          ...errors,
          "403": { description: "Not a writer, or the deletion would change nodes the caller may not read" },
          "404": { description: "Unknown or unreadable node" },
        },
      },
    },
    "/v1/nodes/{id}": {
      delete: {
        summary: "Delete a node as shown by its deletion plan",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "confirm", in: "query", required: true, schema: { type: "string" }, description: "The digest of the plan shown" },
        ],
        responses: {
          "200": { description: "What was deleted", content: json(DeletionResponse) },
          ...errors,
          "403": { description: "Not a writer, or the deletion would change nodes the caller may not read" },
          "404": { description: "Unknown or unreadable node" },
          "409": { description: "The graph changed since the plan was shown" },
        },
      },
    },
    "/v1/ask": {
      post: {
        summary: "Answer a question from the nodes the caller may read, and optionally file the answer",
        requestBody: { required: true, content: { "application/json": { schema: z.toJSONSchema(AskBody, { io: "input" }) } } },
        responses: {
          "200": { description: "The answer and every node the model read", content: json(AskResponse) },
          ...errors,
          "403": { description: "Filing an answer without being a writer" },
          "501": { description: "No language model configured" },
        },
      },
    },
  },
} as const;
