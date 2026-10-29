import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canRead, createGraph, deriveScope, deriveScopes, type Node, type Principal, type Scope } from "../src/index.js";

const team = (name: string): Scope => ({ kind: "team", team: name });
const shared: Scope = { kind: "shared" };

// Groups as the identity provider reports them, nested groups resolved: the dev lead was added to
// both team groups.
const lead: Principal = { user: "lea", teams: ["dev", "bff", "front"] };
const bob: Principal = { user: "bob", teams: ["dev", "bff"] };

describe("deriveScope", () => {
  it("ignores shared sources", () => {
    expect(deriveScope(lead, shared, [shared, team("bff")])).toEqual(team("bff"));
    expect(deriveScope(lead, shared, [shared])).toEqual(shared);
  });

  it("requires every source team to read the result", () => {
    const scope = deriveScope(lead, shared, [team("front"), team("bff"), team("bff")]);
    expect(scope).toEqual({ kind: "teams", teams: ["bff", "front"] });
    expect(canRead(lead, scope)).toBe(true);
    expect(canRead(bob, scope)).toBe(false);
  });

  it("makes anything private the author's", () => {
    expect(deriveScope(bob, shared, [team("bff"), { kind: "private", user: "bob" }])).toEqual({ kind: "private", user: "bob" });
  });

  it("never widens the declared scope", () => {
    expect(deriveScope(lead, team("front"), [shared])).toEqual(team("front"));
    expect(deriveScope(lead, team("front"), [team("bff")])).toEqual({ kind: "teams", teams: ["bff", "front"] });
  });

  it("refuses a source the author cannot read, and someone else's private scope", () => {
    expect(() => deriveScope(bob, shared, [team("front")])).toThrow(/cannot read/);
    expect(() => deriveScope(bob, { kind: "private", user: "lea" }, [shared])).toThrow(/cannot derive/);
  });
});

describe("deriveScopes", () => {
  const node = (id: string, scope: Scope): Node => ({ id, type: "Concept", scope, provenance: { source: "docs", path: id } });

  it("follows chains of derivation", () => {
    const graph = createGraph(
      [node("a", team("front")), node("b", team("bff")), node("summary", shared), node("digest", shared), node("plain", shared)],
      [
        { type: "DERIVED_FROM", from: "summary", to: "a" },
        { type: "DERIVED_FROM", from: "summary", to: "b" },
        { type: "DERIVED_FROM", from: "digest", to: "summary" },
        { type: "REFERENCES", from: "plain", to: "a" },
      ],
    );
    expect(deriveScopes(graph, lead, ["digest", "plain"]).map((n) => [n.id, n.scope])).toEqual([
      ["digest", { kind: "teams", teams: ["bff", "front"] }],
      ["plain", shared],
    ]);
  });

  it("rejects a cycle of derivation", () => {
    const graph = createGraph(
      [node("a", shared), node("b", shared)],
      [
        { type: "DERIVED_FROM", from: "a", to: "b" },
        { type: "DERIVED_FROM", from: "b", to: "a" },
      ],
    );
    expect(() => deriveScopes(graph, lead, ["a"])).toThrow(/cycle/);
  });
});

// For any author, reader and sources the author can read: whoever reads the derived node reads
// every source, and the declared scope too unless they are the author.
describe("deriveScope, for any groups", () => {
  const teams = ["t0", "t1", "t2", "t3"];
  const users = ["u0", "u1", "u2"];

  const scope: fc.Arbitrary<Scope> = fc.oneof(
    fc.constant(shared),
    fc.constantFrom(...teams).map(team),
    fc.uniqueArray(fc.constantFrom(...teams), { minLength: 2 }).map((names): Scope => ({ kind: "teams", teams: names.sort() })),
    fc.constantFrom(...users).map((user): Scope => ({ kind: "private", user })),
  );

  const principal: fc.Arbitrary<Principal> = fc.record({ user: fc.constantFrom(...users), teams: fc.subarray(teams) });

  it("gives readers of the result access to every source", () => {
    fc.assert(
      fc.property(principal, principal, scope, fc.array(scope, { maxLength: 5 }), (author, other, declared, all) => {
        // One user has one set of groups at a time: a reader with the author's name is the author.
        const reader = other.user === author.user ? author : other;
        const sources = all.filter((s) => canRead(author, s));
        fc.pre(declared.kind !== "private" || declared.user === author.user);

        const result = deriveScope(author, declared, sources);
        if (!canRead(reader, result)) return;
        for (const source of sources) expect(canRead(reader, source)).toBe(true);
        if (reader.user !== author.user) expect(canRead(reader, declared)).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });
});
