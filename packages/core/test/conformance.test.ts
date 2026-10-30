import { describe, expect, it } from "vitest";
import { checkSource, type Extracted, type Node, type SourceUnderTest } from "../src/index.js";

// The suite itself: a conforming adapter passes, and each rule catches the adapter breaking it.

const lea = { kind: "private", user: "lea" } as const;

// One node per file; `scope: x` on the first line declares a scope; `-> y` links to y.
function conforming(files: ReadonlyMap<string, string>): Extracted {
  const nodes: Node[] = [...files].map(([path, text]) => {
    const declared = /^scope: (\S+)/.exec(text)?.[1];
    return {
      id: path.replace(/\.txt$/, ""),
      type: "Concept",
      scope: declared === "shared" ? { kind: "shared" } : lea,
      provenance: { source: "notes", path },
    };
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = [...files].flatMap(([path, text]) =>
    [...text.matchAll(/-> (\S+)/g)].map((m) => ({ type: "REFERENCES" as const, from: path.replace(/\.txt$/, ""), to: m[1] ?? "" })).filter((edge) => ids.has(edge.to)),
  );
  return { nodes, edges };
}

const files = new Map([
  ["a.txt", "scope: shared\n-> b"],
  ["b.txt", "-> a"],
  ["c.txt", "-> missing"],
]);
const adapter = (extract: (files: ReadonlyMap<string, string>) => Extracted): SourceUnderTest => ({
  source: "notes",
  files,
  extract: async (given) => extract(given),
  undeclared: ["b", "c"],
  defaultScope: lea,
});

describe("checkSource", () => {
  it("passes a conforming adapter", async () => {
    expect(await checkSource(adapter(conforming))).toEqual([]);
  });

  it("catches each rule broken", async () => {
    const broken = async (change: (graph: Extracted, given: ReadonlyMap<string, string>) => Extracted) =>
      (await checkSource(adapter((given) => change(conforming(given), given)))).join("\n");

    expect(await broken((g) => ({ ...g, edges: [...g.edges, { type: "REFERENCES", from: "a", to: "ghost" }] }))).toMatch(/dangles/);
    expect(await broken((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, type: "Secret" })) }))).toMatch(/not in the ontology/);
    expect(await broken((g) => ({ ...g, nodes: [...g.nodes, ...g.nodes.slice(0, 1)] }))).toMatch(/given twice/);
    expect(await broken((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, provenance: { source: "other", path: n.provenance.path } })) }))).toMatch(/provenance source/);
    expect(await broken((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, provenance: { source: "notes", path: `/abs/${n.provenance.path}` } })) }))).toMatch(/provenance path/);
    // A node without a declared scope made shared.
    expect(await broken((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, scope: { kind: "shared" } })) }))).toMatch(/b: declares no scope but got shared/);
    // Order-dependent: the last file read wins a scope.
    expect(await broken((g, given) => ({ ...g, nodes: g.nodes.map((n) => (n.id === "b" && [...given.keys()][0] === "c.txt" ? { ...n, title: "late" } : n)) }))).toMatch(/another order/);
    // A node kept after its file is gone.
    const remembered = new Map<string, Node>();
    expect(
      await broken((g) => {
        for (const node of g.nodes) remembered.set(node.id, node);
        return { ...g, nodes: [...remembered.values()] };
      }),
    ).toMatch(/left out, but/);
  });

  it("refuses a fixture that does not exercise the default scope", async () => {
    expect(await checkSource({ ...adapter(conforming), undeclared: [] })).toEqual(["the fixture has no content without a scope: the default is not checked"]);
  });
});
