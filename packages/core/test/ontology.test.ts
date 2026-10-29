import { describe, expect, it } from "vitest";
import { EdgeSchema, NodeSchema } from "../src/index.js";

const decision = {
  id: "adr-0002",
  type: "Decision",
  scope: { kind: "team", team: "bff" },
  provenance: { source: "github:acme/shop", path: "docs/adr/0002.md", sha: "5a03dc8" },
};

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}

describe("NodeSchema", () => {
  it("accepts a node with a type, a scope and a provenance", () => {
    expect(NodeSchema.parse(decision)).toEqual(decision);
  });

  it("accepts a provenance without sha for sources outside git", () => {
    const session = { ...decision, type: "Session", provenance: { source: "claude-code", path: "s-42" } };
    expect(NodeSchema.safeParse(session).success).toBe(true);
  });

  it("rejects a node without scope", () => {
    expect(NodeSchema.safeParse(without(decision, "scope")).success).toBe(false);
  });

  it("rejects a node without provenance", () => {
    expect(NodeSchema.safeParse(without(decision, "provenance")).success).toBe(false);
  });

  it("rejects a type outside the ontology", () => {
    expect(NodeSchema.safeParse({ ...decision, type: "Microservice" }).success).toBe(false);
  });

  it("rejects a malformed scope", () => {
    expect(NodeSchema.safeParse({ ...decision, scope: { kind: "team", team: "" } }).success).toBe(false);
    expect(NodeSchema.safeParse({ ...decision, scope: { kind: "public" } }).success).toBe(false);
  });

  it("rejects a sha that is not a commit hash", () => {
    const provenance = { ...decision.provenance, sha: "main" };
    expect(NodeSchema.safeParse({ ...decision, provenance }).success).toBe(false);
  });
});

describe("EdgeSchema", () => {
  it("accepts a typed edge between two nodes", () => {
    expect(EdgeSchema.safeParse({ type: "DERIVED_FROM", from: "concept-1", to: "adr-0002" }).success).toBe(true);
  });

  it("rejects an edge type outside the ontology", () => {
    expect(EdgeSchema.safeParse({ type: "LIKES", from: "a", to: "b" }).success).toBe(false);
  });
});

describe("REFERENCES", () => {
  it("links two documents without a stronger relation", () => {
    expect(EdgeSchema.safeParse({ type: "REFERENCES", from: "note-a", to: "note-b" }).success).toBe(true);
  });
});
