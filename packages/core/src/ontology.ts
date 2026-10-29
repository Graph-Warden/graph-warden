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
