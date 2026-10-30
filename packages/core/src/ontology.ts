import { z } from "zod";
import { ScopeSchema } from "./scope.js";

// The ontology (proposal 0001): closed by default, extensible by configuration. An organisation adds
// its own types (`Microservice`, `OWNS`) without forking, and never removes the core ones, which
// the domain relies on (`DERIVED_FROM` narrows scopes, `REFERENCES` links pages).
//
// On the wire a type is any name of the right shape, so that clients read nodes of types they do
// not know; whether the graph accepts it is the ontology's call, checked by the writer. The shape
// is also what keeps a type safe to use as a Neo4j label or relationship type.

export const CORE_NODE_TYPES = [
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
] as const;

export const CORE_EDGE_TYPES = [
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
] as const;

export type CoreNodeType = (typeof CORE_NODE_TYPES)[number];
export type CoreEdgeType = (typeof CORE_EDGE_TYPES)[number];
// A core type or one an organisation added.
export type NodeType = CoreNodeType | (string & {});
export type EdgeType = CoreEdgeType | (string & {});

export const NodeTypeSchema = z
  .string()
  .regex(/^[A-Z][A-Za-z0-9]{0,63}$/, "a node type is PascalCase: Microservice") as z.ZodType<NodeType, string>;
export const EdgeTypeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "an edge type is UPPER_SNAKE_CASE: OWNS, RUNS_ON") as z.ZodType<EdgeType, string>;

// What an organisation adds, as read from its configuration (GWARDEN_ONTOLOGY).
export const OntologyExtensionSchema = z
  .object({
    nodeTypes: z.array(NodeTypeSchema).default([]),
    edgeTypes: z.array(EdgeTypeSchema).default([]),
  })
  .strict();

export type OntologyExtension = z.input<typeof OntologyExtensionSchema>;

export interface Ontology {
  readonly nodeTypes: readonly NodeType[];
  readonly edgeTypes: readonly EdgeType[];
}

export function createOntology(extension: OntologyExtension = {}): Ontology {
  const { nodeTypes, edgeTypes } = OntologyExtensionSchema.parse(extension);
  return {
    nodeTypes: [...new Set<NodeType>([...CORE_NODE_TYPES, ...nodeTypes])],
    edgeTypes: [...new Set<EdgeType>([...CORE_EDGE_TYPES, ...edgeTypes])],
  };
}

export const CORE_ONTOLOGY: Ontology = createOntology();

export class OutsideOntology extends Error {
  override readonly name = "OutsideOntology";
}

// Throws on the first node or edge whose type the ontology does not have.
export function checkOntology(ontology: Ontology, nodes: readonly { readonly id: string; readonly type: NodeType }[], edges: readonly Edge[] = []): void {
  for (const node of nodes) {
    if (!ontology.nodeTypes.includes(node.type)) throw new OutsideOntology(`${node.id}: node type ${node.type} is not in the ontology`);
  }
  for (const edge of edges) {
    if (!ontology.edgeTypes.includes(edge.type)) {
      throw new OutsideOntology(`${edge.from} -> ${edge.to}: edge type ${edge.type} is not in the ontology`);
    }
  }
}

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
