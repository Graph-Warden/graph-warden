import { describe, expect, it } from "vitest";
import { parsePage } from "@graph-warden/documents";
import { parseCommand } from "../src/args.js";

// parseCommand reads these from the environment; a developer's own must not change the results.
delete process.env.GWARDEN_API;
delete process.env.GWARDEN_TOKEN;

describe("ingest", () => {
  const command = parseCommand(["ingest", "./docs", "--source", "docs:x", "--user", "alice", "--where", "theme=dev", "--where", "tags=mcp"]);

  it("reads the directory, source and default scope", () => {
    expect(command).toMatchObject({ name: "ingest", dir: "./docs", source: "docs:x", defaultScope: { kind: "private", user: "alice" } });
  });

  it("keeps pages matching every --where, on plain or list fields", () => {
    if (command.name !== "ingest") throw new Error("wrong command");
    expect(command.include(parsePage("a.md", "---\ntheme: dev\ntags: [mcp, neo4j]\n---\n"))).toBe(true);
    expect(command.include(parsePage("b.md", "---\ntheme: dev\ntags: [neo4j]\n---\n"))).toBe(false);
    expect(command.include(parsePage("c.md", "no frontmatter"))).toBe(false);
  });

  it("widens the default scope only when asked", () => {
    const shared = parseCommand(["ingest", "./docs", "--source", "x", "--user", "alice", "--default-scope", "team:dev"]);
    expect(shared).toMatchObject({ defaultScope: { kind: "team", team: "dev" } });
    const both = parseCommand(["ingest", "./docs", "--source", "x", "--user", "alice", "--default-scope", "teams:front,bff"]);
    expect(both).toMatchObject({ defaultScope: { kind: "teams", teams: ["bff", "front"] } });
  });

  it("takes the author's groups", () => {
    const command = parseCommand(["ingest", "./docs", "--source", "x", "--user", "lea", "--team", "bff", "--team", "front"]);
    expect(command).toMatchObject({ author: { user: "lea", teams: ["bff", "front"] } });
  });

  it("requires a source, a user and well-formed filters", () => {
    expect(() => parseCommand(["ingest", "./docs"])).toThrow(/--source/);
    expect(() => parseCommand(["ingest", "./docs", "--source", "x"])).toThrow(/--user/);
    expect(() => parseCommand(["ingest", "./docs", "--source", "x", "--user", "a", "--where", "theme"])).toThrow(/key=value/);
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
      through: { kind: "neo4j" },
      options: { direction: "both", maxDepth: 2, edgeTypes: ["REFERENCES"] },
    });
  });

  it("rejects a bad direction, depth or edge type", () => {
    expect(() => parseCommand(["traverse", "x", "--user", "a", "--direction", "up"])).toThrow(/direction/);
    expect(() => parseCommand(["traverse", "x", "--user", "a", "--depth", "0"])).toThrow(/depth/);
    expect(() => parseCommand(["traverse", "x", "--user", "a", "--edge", "likes"])).toThrow();
  });

  it("requires a user", () => {
    expect(() => parseCommand(["traverse", "x"])).toThrow(/--user/);
  });
});

describe("audit", () => {
  it("lists every entry, or one user's", () => {
    expect(parseCommand(["audit"])).toEqual({ name: "audit", through: { kind: "neo4j" } });
    expect(parseCommand(["audit", "--user", "bob"])).toEqual({ name: "audit", user: "bob", through: { kind: "neo4j" } });
  });

  it("goes through the API when given one", () => {
    expect(parseCommand(["audit", "--api", "https://gw.example.com/", "--token", "t"])).toEqual({
      name: "audit",
      through: { kind: "api", api: "https://gw.example.com", token: "t" },
    });
    expect(() => parseCommand(["audit", "--api", "https://gw.example.com"])).toThrow(/--token/);
  });
});

describe("traverse through the API", () => {
  it("needs no --user: the token says who it is", () => {
    expect(parseCommand(["traverse", "app", "--api", "https://gw.example.com", "--token", "t"])).toMatchObject({
      name: "traverse",
      through: { kind: "api", api: "https://gw.example.com", token: "t" },
    });
    expect(() => parseCommand(["traverse", "app"])).toThrow(/--user/);
  });
});

describe("pull", () => {
  it("needs an API and a token", () => {
    expect(parseCommand(["pull", "--api", "https://gw.example.com", "--token", "t", "--cache", "/tmp/c.db"])).toEqual({
      name: "pull",
      api: "https://gw.example.com",
      token: "t",
      cache: "/tmp/c.db",
    });
    expect(() => parseCommand(["pull", "--token", "t"])).toThrow(/--api/);
  });
});

describe("show and search", () => {
  const api = ["--api", "https://gw.example.com", "--token", "t"];

  it("reads a node, or searches words through the API", () => {
    expect(parseCommand(["show", "adr-7", ...api])).toEqual({ name: "show", id: "adr-7", api: "https://gw.example.com", token: "t" });
    expect(parseCommand(["search", "cursor", "pagination", "--limit", "5", ...api])).toMatchObject({ name: "search", query: "cursor pagination", limit: 5 });
    expect(() => parseCommand(["search", "x", "--limit", "0", ...api])).toThrow(/--limit/);
  });
});

describe("ask", () => {
  const api = ["--api", "https://gw.example.com", "--token", "t"];

  it("takes the question, an anchor and a scope to file it under", () => {
    expect(parseCommand(["ask", "How", "are", "orders", "paginated?", "--from", "orders-api", "--save", "--scope", "shared", ...api])).toEqual({
      name: "ask",
      question: "How are orders paginated?",
      from: "orders-api",
      save: true,
      scope: "shared",
      api: "https://gw.example.com",
      token: "t",
    });
  });

  it("refuses a scope without --save, and a malformed scope", () => {
    expect(() => parseCommand(["ask", "q", "--scope", "shared", ...api])).toThrow(/--save/);
    expect(() => parseCommand(["ask", "q", "--save", "--scope", "everyone", ...api])).toThrow();
  });
});

describe("delete", () => {
  it("needs the API, and takes a confirmation for scripts", () => {
    expect(parseCommand(["delete", "adr", "--confirm", "adr", "--api", "https://gw.example.com", "--token", "t"])).toEqual({
      name: "delete",
      id: "adr",
      confirm: "adr",
      api: "https://gw.example.com",
      token: "t",
    });
    expect(() => parseCommand(["delete", "adr", "--token", "t"])).toThrow(/--api/);
  });
});

it("prints usage for an unknown command", () => {
  expect(() => parseCommand(["frobnicate", "x"])).toThrow(/Usage/);
});

it("parses impact, shared-only by default", () => {
  expect(parseCommand(["impact", "/repo", "--source", "github:acme/shop", "--base", "main"])).toMatchObject({
    name: "impact",
    dir: "/repo",
    base: "main",
    head: "HEAD",
    scope: { kind: "shared" },
    reader: { teams: [] },
  });
  expect(parseCommand(["impact", "/repo", "--source", "s", "--base", "b", "--comment", "acme/shop#12"])).toMatchObject({ comment: { repo: "acme/shop", pull: 12 } });
  expect(() => parseCommand(["impact", "/repo", "--source", "s", "--base", "b", "--comment", "12"])).toThrow(/owner\/repo#number/);
  expect(() => parseCommand(["impact", "/repo", "--source", "s"])).toThrow(/--base/);
});
