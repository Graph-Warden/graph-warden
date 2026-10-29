import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  canRead,
  createGraph,
  createOrganisation,
  deriveScope,
  deriveScopes,
  resolvePrincipal,
  type Node,
  type Organisation,
  type Scope,
} from "../src/index.js";

// dev
// ├── bff
// └── front
//     ├── front-a
//     └── front-b
// ops (top level)
const org = createOrganisation({ dev: null, bff: "dev", front: "dev", "front-a": "front", "front-b": "front", ops: null });

const team = (name: string): Scope => ({ kind: "team", team: name });
const shared: Scope = { kind: "shared" };

describe("createOrganisation", () => {
  it("rejects an unknown parent and a cycle", () => {
    expect(() => createOrganisation({ a: "ghost" })).toThrow(/unknown parent/);
    expect(() => createOrganisation({ a: "b", b: "a" })).toThrow(/cycle/);
  });
});

describe("resolvePrincipal", () => {
  it("lets a team read every team below it, and only those", () => {
    const lead = resolvePrincipal(org, "lea", ["front"]);
    expect([...lead.teams].sort()).toEqual(["front", "front-a", "front-b"]);
    expect(canRead(lead, team("front-a"))).toBe(true);
    expect(canRead(lead, team("bff"))).toBe(false);
    expect(canRead(lead, team("dev"))).toBe(false);
  });

  it("keeps a team the organisation does not list", () => {
    expect(resolvePrincipal(org, "sam", ["qa"]).teams).toEqual(["qa"]);
  });

  it("is the flat model with an empty organisation", () => {
    expect(resolvePrincipal(createOrganisation(), "sam", ["bff"]).teams).toEqual(["bff"]);
  });
});

describe("deriveScope", () => {
  const head = resolvePrincipal(org, "hugo", ["dev"]);
  const alice = resolvePrincipal(org, "alice", ["front-a", "front-b"]);

  it("ignores shared sources", () => {
    expect(deriveScope(org, head, shared, [shared, team("bff")])).toEqual(team("bff"));
  });

  it("takes the upper team when one team is below the other", () => {
    expect(deriveScope(org, head, shared, [team("front"), team("front-a")])).toEqual(team("front"));
  });

  it("takes the nearest common ancestor of sibling teams", () => {
    expect(deriveScope(org, head, shared, [team("front-a"), team("bff")])).toEqual(team("dev"));
    expect(deriveScope(org, alice, shared, [team("front-a"), team("front-b")])).toEqual(team("front"));
  });

  it("falls back to the author's private scope without a common ancestor", () => {
    const both = resolvePrincipal(org, "max", ["dev", "ops"]);
    expect(deriveScope(org, both, shared, [team("bff"), team("ops")])).toEqual({ kind: "private", user: "max" });
  });

  it("makes anything private the author's", () => {
    expect(deriveScope(org, alice, shared, [team("front-a"), { kind: "private", user: "alice" }])).toEqual({
      kind: "private",
      user: "alice",
    });
  });

  it("never widens the declared scope", () => {
    expect(deriveScope(org, head, team("front-a"), [shared])).toEqual(team("front-a"));
  });

  it("refuses a source the author cannot read, and someone else's private scope", () => {
    expect(() => deriveScope(org, alice, shared, [team("bff")])).toThrow(/cannot read/);
    expect(() => deriveScope(org, alice, { kind: "private", user: "bob" }, [shared])).toThrow(/cannot derive/);
  });
});

describe("deriveScopes", () => {
  const node = (id: string, scope: Scope): Node => ({ id, type: "Concept", scope, provenance: { source: "docs", path: id } });
  const head = resolvePrincipal(org, "hugo", ["dev"]);

  it("follows chains of derivation", () => {
    const graph = createGraph(
      [node("a", team("front-a")), node("b", team("bff")), node("summary", shared), node("digest", shared), node("plain", shared)],
      [
        { type: "DERIVED_FROM", from: "summary", to: "a" },
        { type: "DERIVED_FROM", from: "summary", to: "b" },
        { type: "DERIVED_FROM", from: "digest", to: "summary" },
        { type: "REFERENCES", from: "plain", to: "a" },
      ],
    );
    const scopes = deriveScopes(graph, org, head, ["digest", "plain"]).map((n) => [n.id, n.scope]);
    expect(scopes).toEqual([
      ["digest", team("dev")],
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
    expect(() => deriveScopes(graph, org, head, ["a"])).toThrow(/cycle/);
  });
});

// For any organisation, author and sources the author can read: whoever reads the derived node
// reads every source, and the declared scope too unless they are the author.
describe("deriveScope, for any organisation", () => {
  const teams = ["t0", "t1", "t2", "t3", "t4", "t5"];
  const users = ["u0", "u1", "u2"];

  // Each team's parent is an earlier team or nobody, which rules out cycles.
  const organisation: fc.Arbitrary<Organisation> = fc
    .tuple(...teams.map((_, i) => (i === 0 ? fc.constant(null) : fc.option(fc.constantFrom(...teams.slice(0, i)), { nil: null }))))
    .map((parents) => createOrganisation(Object.fromEntries(teams.map((t, i) => [t, parents[i] ?? null]))));

  const scope: fc.Arbitrary<Scope> = fc.oneof(
    fc.constant(shared),
    fc.constantFrom(...teams).map(team),
    fc.constantFrom(...users).map((user): Scope => ({ kind: "private", user })),
  );

  const membership = fc.record({ user: fc.constantFrom(...users), memberOf: fc.subarray(teams) });

  it("gives readers of the result access to every source", () => {
    fc.assert(
      fc.property(organisation, membership, membership, scope, fc.array(scope, { maxLength: 5 }), (o, a, r, declared, all) => {
        const author = resolvePrincipal(o, a.user, a.memberOf);
        // One user has one membership at a time: a reader with the author's name is the author.
        const reader = r.user === a.user ? author : resolvePrincipal(o, r.user, r.memberOf);
        const sources = all.filter((s) => canRead(author, s));
        fc.pre(declared.kind !== "private" || declared.user === author.user);

        const result = deriveScope(o, author, declared, sources);
        if (!canRead(reader, result)) return;
        for (const source of sources) expect(canRead(reader, source)).toBe(true);
        if (reader.user !== author.user) expect(canRead(reader, declared)).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });
});
