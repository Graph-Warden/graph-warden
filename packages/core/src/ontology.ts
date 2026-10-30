import { z } from "zod";
import { ScopeSchema } from "./scope.js";

// The closed default ontology (proposal 0001). Extension by configuration comes later; until then a
// node or edge of an unknown type is rejected.

export const NodeTypeSchema = z.enum([
  "Source",
  "Change",
  "Module",
  "Endpoint",
  "Decision",
  "Concept",
  "Incident",
  "Team",
  "Person",
  "Session",
]);

export type NodeType = z.infer<typeof NodeTypeSchema>;

export const EdgeTypeSchema = z.enum([
  "IMPORTS",
  "MODIFIES",
  "EXPOSES",
  "CONSUMES",
  "DECIDES",
  "DERIVED_FROM",
  "BELONGS_TO",
  "CAUSES",
  "FIXES",
  "CONTRADICTS",
  // A document that links to another (a wikilink, a URL to a known page) without a stronger
  // relation being known.
  "REFERENCES",
]);

export type EdgeType = z.infer<typeof EdgeTypeSchema>;

// Where a node comes from. `sha` is absent for sources outside git (an agent session, a ticket).
export const ProvenanceSchema = z
  .object({
    source: z.string().min(1),
    path: z.string().min(1),
    sha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/)
      .optional(),
  })
  .readonly();

export type Provenance = z.infer<typeof ProvenanceSchema>;

export const NodeSchema = z
  .object({
    id: z.string().min(1),
    type: NodeTypeSchema,
    scope: ScopeSchema,
    provenance: ProvenanceSchema,
    // A human name for the node, shown in place of its id: a document's `title:` field, or the first
    // heading of a Markdown page. The id stays the node's identity.
    title: z.string().min(1).optional(),
    // The node's text, what `ask` reads: the body of a Markdown page, the `body` field of a JSON or
    // YAML document, an answer filed by `ask`. The graph holds it so that it stays the source of
    // truth; nothing reads the files back.
    body: z.string().optional(),
  })
  .readonly();

export type Node = z.infer<typeof NodeSchema>;

export const EdgeSchema = z
  .object({
    type: EdgeTypeSchema,
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .readonly();

export type Edge = z.infer<typeof EdgeSchema>;
