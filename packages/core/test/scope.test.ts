import { describe, expect, it } from "vitest";
import { canRead, type Principal } from "../src/index.js";

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
});
