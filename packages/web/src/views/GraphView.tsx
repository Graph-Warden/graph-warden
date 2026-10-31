import { useEffect, useMemo, useRef } from "react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import type { CoreNodeType, Edge, Node, NodeType } from "@graph-warden/core";
import { nameOf, neighbourhood, type Store } from "../graph.js";
import { pageHref } from "../markdown.js";
import { graphHref } from "../route.js";

// One colour per core node type, readable on both themes; the organisation's types share one.
const COLOURS: Record<CoreNodeType, string> = {
  Source: "#8a8a80",
  Change: "#b07d2b",
  Module: "#3f7cac",
  Endpoint: "#2f8f6f",
  Decision: "#9b4dca",
  Concept: "#c2543a",
  Incident: "#d13b5c",
  Team: "#5b6abf",
  Person: "#4a9bb0",
  Session: "#7a7a72",
};
const colour = (type: NodeType): string => (COLOURS as Record<string, string>)[type] ?? "#a0763a";
const GREY = "#d4d2ca";

// A stable starting position per id, so that the same graph is laid out the same way each time.
function seed(id: string): [number, number] {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const angle = ((hash >>> 0) % 3600) / 572.96;
  const radius = 1 + (((hash >>> 12) % 100) / 100) * 9;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

// The graph drawn: `highlighted`, when given, in colour and the rest greyed (a pull request's
// impact, issue #16). A click on a node opens its page, or calls `onNode`.
export function GraphCanvas(props: {
  nodes: readonly Node[];
  edges: readonly Edge[];
  focus?: string;
  highlighted?: ReadonlySet<string>;
  onNode?: (id: string) => void;
}) {
  const { nodes, edges, focus, highlighted, onNode } = props;
  const container = useRef<HTMLDivElement>(null);
  const types = [...new Set(nodes.map((node) => node.type))].sort();

  useEffect(() => {
    if (container.current === null || nodes.length === 0) return;
    const graph = new Graph({ multi: true, type: "directed" });
    const degree = new Map<string, number>();
    for (const edge of edges) for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
    const lit = (id: string) => highlighted === undefined || highlighted.has(id);
    for (const node of nodes) {
      const [x, y] = seed(node.id);
      graph.addNode(node.id, {
        x,
        y,
        label: nameOf(node),
        size: (node.id === focus || (highlighted?.has(node.id) ?? false) ? 12 : 6) + Math.min(degree.get(node.id) ?? 0, 10),
        color: lit(node.id) ? colour(node.type) : GREY,
      });
    }
    for (const edge of edges) {
      const derived = edge.type === "DERIVED_FROM";
      const on = lit(edge.from) && lit(edge.to);
      graph.addEdge(edge.from, edge.to, { label: edge.type, size: derived ? 3 : 2, color: !on ? GREY : derived ? "#b48ad6" : "#a9a79e" });
    }
    if (graph.order > 1) forceAtlas2.assign(graph, { iterations: 300, settings: { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: graph.order > 500 } });

    const text = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#1d1d1b";
    const renderer = new Sigma(graph, container.current, {
      defaultEdgeType: "arrow",
      renderEdgeLabels: true,
      labelColor: { color: text },
      edgeLabelColor: { color: text },
      labelRenderedSizeThreshold: 4,
    });
    renderer.on("clickNode", ({ node }) => {
      if (onNode === undefined) window.location.hash = pageHref(node);
      else onNode(node);
    });
    renderer.on("enterNode", () => container.current?.classList.add("pointing"));
    renderer.on("leaveNode", () => container.current?.classList.remove("pointing"));
    return () => renderer.kill();
  }, [nodes, edges, focus, highlighted, onNode]);

  return (
    <>
      <ul className="legend">
        {types.map((type) => (
          <li key={type}>
            <span className="dot" style={{ background: colour(type) }} /> {type}
          </li>
        ))}
      </ul>
      <div className="canvas" ref={container} />
    </>
  );
}

export function GraphView({ store, focus }: { store: Store; focus?: string }) {
  // Laid out again only when the graph or the focus changes, not on every render.
  const { nodes, edges } = useMemo(() => neighbourhood(store, focus), [store, focus]);
  const centre = focus === undefined ? undefined : store.nodes.get(focus);
  return (
    <section className="graph-view">
      <h1>{centre === undefined ? (focus === undefined ? "The graph you may read" : "Not found") : nameOf(centre)}</h1>
      <p className="hint">
        {focus === undefined ? (
          "Every node you may read. Click one to open it."
        ) : centre === undefined ? (
          <>
            There is no node <code>{focus}</code>, or you may not read it.
          </>
        ) : (
          <>
            Two hops around it, either way. <a href={pageHref(focus)}>Open the page</a> · <a href={graphHref()}>Whole graph</a>
          </>
        )}
      </p>
      <GraphCanvas nodes={nodes} edges={edges} {...(focus === undefined ? {} : { focus })} />
    </section>
  );
}
