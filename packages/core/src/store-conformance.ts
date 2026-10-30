import type { Edge, Node } from "./ontology.js";
import type { GraphStore } from "./store.js";

// The store conformance suite (issue #24): what every GraphStore must do, whatever it runs on.
// Framework-free, like the source suite: `expect(await checkStore(() => createMyStore())).toEqual([])`.
// `make` gives an empty store each time.

const base = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  type: "Concept",
  scope: { kind: "team", team: "bff" },
  provenance: { source: "docs:core", path: `${id}.md`, sha: "5a03dc8" },
  ...extra,
});
const key = (edge: Edge) => `${edge.type} ${edge.from} ${edge.to}`;
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]))
      : value;

const CHECKS: Record<string, (store: GraphStore) => Promise<string | undefined>> = {
  "returns nodes as stored, every scope kind and field": async (store) => {
    const nodes = [
      base("a"),
      base("b", { scope: { kind: "shared" }, title: "B", body: "# B\n\nBody." }),
      base("c", { scope: { kind: "teams", teams: ["bff", "front"] } }),
      base("d", { scope: { kind: "private", user: "lea" }, type: "Microservice" }),
      base("e", { provenance: { source: "wiki", path: "e" } }),
    ];
    await store.upsertNodes(nodes);
    for (const node of nodes) if (!same(await store.getNode(node.id), node)) return `${node.id} came back as ${JSON.stringify(await store.getNode(node.id))}`;
    return (await store.getNode("missing")) === undefined ? undefined : "an unknown id gave a node";
  },
  "keeps any text and id as written": async (store) => {
    const odd = base('quote"and>angle <x> \\ back', { title: "Ünïcode ✓ 漢字", body: 'Lines\n\t"quoted" \'single\' \\n literal\r\nend \u0000? no:   ok' });
    const body = odd.body?.replace("\u0000", "") ?? "";
    await store.upsertNodes([{ ...odd, body }]);
    return same(await store.getNode(odd.id), { ...odd, body }) ? undefined : `came back as ${JSON.stringify(await store.getNode(odd.id))}`;
  },
  "replaces a node on upsert, fields removed included": async (store) => {
    await store.upsertNodes([base("a", { title: "A", body: "old" })]);
    await store.upsertNodes([base("a", { scope: { kind: "shared" } })]);
    const graph = await store.snapshot();
    return graph.nodes.size === 1 && same(graph.nodes.get("a"), base("a", { scope: { kind: "shared" } })) ? undefined : `got ${JSON.stringify([...graph.nodes.values()])}`;
  },
  "upserts edges idempotently, one per type and ends": async (store) => {
    await store.upsertNodes([base("a"), base("b")]);
    const edges: Edge[] = [
      { type: "DECIDES", from: "a", to: "b" },
      { type: "DECIDES", from: "a", to: "b" },
      { type: "REFERENCES", from: "a", to: "b" },
      { type: "REFERENCES", from: "b", to: "a" },
      { type: "DECIDES", from: "a", to: "a" },
      { type: "RUNS_ON", from: "b", to: "a" },
    ];
    await store.upsertEdges(edges);
    await store.upsertEdges(edges.slice(0, 1));
    const got = (await store.snapshot()).edges.map(key).sort();
    const want = [...new Set(edges.map(key))].sort();
    return same(got, want) ? undefined : `edges ${JSON.stringify(got)}`;
  },
  "refuses an edge to or from an unknown node, writing none of the batch": async (store) => {
    await store.upsertNodes([base("a")]);
    try {
      await store.upsertEdges([{ type: "DECIDES", from: "a", to: "ghost" }]);
      return "accepted a dangling edge";
    } catch {
      return (await store.snapshot()).edges.length === 0 ? undefined : "wrote an edge of a refused batch";
    }
  },
  "deletes a node with its edges, and nothing else": async (store) => {
    await store.upsertNodes([base("a"), base("b"), base("c")]);
    await store.upsertEdges([
      { type: "DECIDES", from: "a", to: "b" },
      { type: "DECIDES", from: "c", to: "a" },
      { type: "DECIDES", from: "b", to: "c" },
    ]);
    await store.deleteNode("a");
    await store.deleteNode("missing");
    const graph = await store.snapshot();
    return same([...graph.nodes.keys()].sort(), ["b", "c"]) && same(graph.edges.map(key), ["DECIDES b c"]) ? undefined : `left ${JSON.stringify([...graph.nodes.keys()])} ${JSON.stringify(graph.edges)}`;
  },
  "deletes edges, keeping their nodes and ignoring edges that do not exist": async (store) => {
    await store.upsertNodes([base("a"), base("b")]);
    await store.upsertEdges([
      { type: "DECIDES", from: "a", to: "b" },
      { type: "REFERENCES", from: "a", to: "b" },
    ]);
    await store.deleteEdges([
      { type: "REFERENCES", from: "a", to: "b" },
      { type: "IMPORTS", from: "b", to: "a" },
    ]);
    const graph = await store.snapshot();
    return graph.nodes.size === 2 && same(graph.edges.map(key), ["DECIDES a b"]) ? undefined : `left ${JSON.stringify(graph.edges)}`;
  },
  "gives a snapshot that later writes do not change": async (store) => {
    await store.upsertNodes([base("a")]);
    const before = await store.snapshot();
    await store.upsertNodes([base("b")]);
    return before.nodes.size === 1 ? undefined : "a snapshot changed after a write";
  },
};

export async function checkStore(make: () => GraphStore | Promise<GraphStore>): Promise<string[]> {
  const violations: string[] = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    try {
      const problem = await check(await make());
      if (problem !== undefined) violations.push(`${name}: ${problem}`);
    } catch (error) {
      violations.push(`${name}: threw ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return violations;
}
