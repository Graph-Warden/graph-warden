import { describe, expect, it } from "vitest";
import { parsePage } from "@graph-warden/markdown";
import { parseCommand } from "../src/args.js";

describe("ingest-markdown", () => {
  const command = parseCommand(["ingest-markdown", "./docs", "--source", "docs:x", "--where", "theme=dev", "--where", "tags=mcp"]);

  it("reads the directory, source and default scope", () => {
    expect(command).toMatchObject({ name: "ingest-markdown", dir: "./docs", source: "docs:x", defaultScope: { kind: "shared" } });
  });

  it("keeps pages matching every --where, on plain or list fields", () => {
    if (command.name !== "ingest-markdown") throw new Error("wrong command");
    expect(command.include(parsePage("a.md", "---\ntheme: dev\ntags: [mcp, neo4j]\n---\n"))).toBe(true);
    expect(command.include(parsePage("b.md", "---\ntheme: dev\ntags: [neo4j]\n---\n"))).toBe(false);
    expect(command.include(parsePage("c.md", "no frontmatter"))).toBe(false);
  });

  it("requires a source and well-formed filters", () => {
    expect(() => parseCommand(["ingest-markdown", "./docs"])).toThrow(/--source/);
    expect(() => parseCommand(["ingest-markdown", "./docs", "--source", "x", "--where", "theme"])).toThrow(/key=value/);
  });
});

describe("traverse", () => {
  it("builds the principal and the traversal options", () => {
    const command = parseCommand([
      "traverse", "graph-warden", "--user", "alice", "--team", "bff", "--team", "front-a",
      "--direction", "both", "--depth", "2", "--edge", "REFERENCES",
    ]);
    expect(command).toEqual({
      name: "traverse",
      start: "graph-warden",
      principal: { user: "alice", teams: ["bff", "front-a"] },
      options: { direction: "both", maxDepth: 2, edgeTypes: ["REFERENCES"] },
    });
  });

  it("rejects a bad direction, depth or edge type", () => {
    expect(() => parseCommand(["traverse", "x", "--user", "a", "--direction", "up"])).toThrow(/direction/);
    expect(() => parseCommand(["traverse", "x", "--user", "a", "--depth", "0"])).toThrow(/depth/);
    expect(() => parseCommand(["traverse", "x", "--user", "a", "--edge", "LIKES"])).toThrow();
  });

  it("requires a user", () => {
    expect(() => parseCommand(["traverse", "x"])).toThrow(/--user/);
  });
});

it("prints usage for an unknown command", () => {
  expect(() => parseCommand(["frobnicate", "x"])).toThrow(/Usage/);
});
