import { describe, expect, it } from "vitest";
import { canRead, formatScope, parseScope, ScopeSchema, teamsScope, type Principal } from "../src/index.js";

const frontA: Principal = { user: "alice", teams: ["front-a"] };

describe("canRead", () => {
  it("lets everyone read shared nodes", () => {
    expect(canRead(frontA, { kind: "shared" })).toBe(true);
  });

  it("limits team nodes to team members", () => {
    expect(canRead(frontA, { kind: "team", team: "front-a" })).toBe(true);
    expect(canRead(frontA, { kind: "team", team: "bff" })).toBe(false);
  });

  it("limits private nodes to their owner", () => {
    expect(canRead(frontA, { kind: "private", user: "alice" })).toBe(true);
    expect(canRead(frontA, { kind: "private", user: "bob" })).toBe(false);
  });

  it("limits a composite team scope to members of every team", () => {
    expect(canRead({ user: "lea", teams: ["bff", "front-a"] }, { kind: "teams", teams: ["bff", "front-a"] })).toBe(true);
    expect(canRead(frontA, { kind: "teams", teams: ["bff", "front-a"] })).toBe(false);
  });
});

describe("teamsScope", () => {
  it("sorts, removes duplicates, and gives a plain team scope for one team", () => {
    expect(teamsScope(["front", "bff", "front"])).toEqual({ kind: "teams", teams: ["bff", "front"] });
    expect(teamsScope(["bff", "bff"])).toEqual({ kind: "team", team: "bff" });
  });

  it("is the only spelling the schema accepts", () => {
    expect(() => ScopeSchema.parse({ kind: "teams", teams: ["front", "bff"] })).toThrow(/sorted/);
    expect(() => ScopeSchema.parse({ kind: "teams", teams: ["bff"] })).toThrow();
  });
});

describe("parseScope and formatScope", () => {
  it("round-trip every kind", () => {
    for (const text of ["shared", "team:bff", "teams:bff,front", "private:alice"]) {
      expect(formatScope(parseScope(text))).toBe(text);
    }
  });

  it("normalise a composite scope", () => {
    expect(parseScope("teams:front, bff")).toEqual({ kind: "teams", teams: ["bff", "front"] });
  });

  it("reject an unknown kind or a missing owner", () => {
    expect(() => parseScope("public")).toThrow();
    expect(() => parseScope("team:")).toThrow();
    expect(() => parseScope("teams:bff,")).toThrow();
  });
});
