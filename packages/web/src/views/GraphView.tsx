import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Graph from "graphology";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import type { CoreNodeType, Edge, Node, NodeType } from "@graph-warden/core";
import { expand, matches, syncGraph, teamsIn, type Filter } from "../canvas.js";
import { formatScope, nameOf, neighbourhood, type Store } from "../graph.js";
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
// Above this, edge labels and the layout's precision cost more than they show.
const LARGE = 500;

// The graph drawn with WebGL (issue #15). It is built once and updated in place as the readable
// graph changes, so that a live update moves nothing already placed; the layout runs in a web
// worker, for a few seconds after nodes come in. Filters hide nodes without laying out again.
// `highlighted`, when given, is in colour and the rest greyed (a pull request's impact, issue #16).
// A click selects a node; `onExpand`, when given, offers to add its neighbours.
export function GraphCanvas(props: {
  nodes: readonly Node[];
  edges: readonly Edge[];
  focus?: string;
  highlighted?: ReadonlySet<string>;
  onExpand?: (id: string) => void;
}) {
  const { nodes, edges, focus, highlighted, onExpand } = props;
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef(new Graph({ multi: true, type: "directed" }));
  const renderer = useRef<Sigma>(undefined);
  const layout = useRef<FA2Layout>(undefined);
  const [filter, setFilter] = useState<Filter>({});
  const [selected, setSelected] = useState<string>();
  // What the reducers read, without rebuilding the renderer.
  const view = useRef({ filter, highlighted, selected, focus });
  view.current = { filter, highlighted, selected, focus };

  const types = useMemo(() => [...new Set(nodes.map((node) => node.type))].sort(), [nodes]);
  const teams = useMemo(() => teamsIn(nodes), [nodes]);

  useEffect(() => {
    if (container.current === null) return;
    const text = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#1d1d1b";
    const sigma = new Sigma(graph.current, container.current, {
      defaultEdgeType: "arrow",
      labelColor: { color: text },
      edgeLabelColor: { color: text },
      labelRenderedSizeThreshold: 6,
      nodeReducer: (id, data) => {
        const { filter: shown, highlighted: lit, selected: picked } = view.current;
        if (!matches({ type: data.kind as NodeType, scope: data.scope }, shown)) return { ...data, hidden: true };
        const greyed = lit !== undefined && !lit.has(id);
        return { ...data, color: greyed ? GREY : data.color, highlighted: id === picked, zIndex: greyed ? 0 : 1 };
      },
      edgeReducer: (id, data) => {
        const lit = view.current.highlighted;
        const [from, to] = graph.current.extremities(id);
        const on = lit === undefined || (lit.has(from) && lit.has(to));
        return { ...data, color: !on ? GREY : data.kind === "DERIVED_FROM" ? "#b48ad6" : "#a9a79e", size: data.kind === "DERIVED_FROM" ? 3 : 2 };
      },
    });
    sigma.on("clickNode", ({ node }) => setSelected(node));
    sigma.on("clickStage", () => setSelected(undefined));
    sigma.on("enterNode", () => container.current?.classList.add("pointing"));
    sigma.on("leaveNode", () => container.current?.classList.remove("pointing"));
    renderer.current = sigma;
    return () => {
      layout.current?.kill();
      layout.current = undefined;
      sigma.kill();
      renderer.current = undefined;
    };
  }, []);

  // The data, in place; laid out again only when nodes came in.
  useEffect(() => {
    const g = graph.current;
    const fresh = g.order === 0;
    // A running layout sends the whole graph to its worker again on every change to it: thousands
    // of changes at once would freeze the page.
    layout.current?.kill();
    layout.current = undefined;
    const added = syncGraph(g, nodes, edges, (node, degree) => ({
      label: nameOf(node),
      color: colour(node.type),
      size: (node.id === focus ? 12 : 4) + Math.min(degree, 10),
    }));
    renderer.current?.setSetting("renderEdgeLabels", g.size <= LARGE);
    if (added.length === 0 || g.order < 2) return;
    const settings = { ...forceAtlas2.inferSettings(g), barnesHutOptimize: g.order > LARGE };
    if (fresh && g.order <= LARGE) {
      forceAtlas2.assign(g, { iterations: 300, settings });
      return;
    }
    // Large graphs, and newcomers to a graph already laid out, settle in the background. The
    // layout is killed, not stopped, when done: stopped, it would still follow every change.
    const running = new FA2Layout(g, { settings });
    layout.current = running;
    running.start();
    const timer = setTimeout(() => {
      running.kill();
      if (layout.current === running) layout.current = undefined;
    }, fresh ? Math.min(2000 + g.order / 2, 10_000) : 1500);
    return () => clearTimeout(timer);
  }, [nodes, edges, focus]);

  useEffect(() => {
    renderer.current?.refresh();
  }, [filter, highlighted, selected]);

  const picked = selected === undefined ? undefined : nodes.find((node) => node.id === selected);
  const toggle = useCallback(
    (type: NodeType) =>
      setFilter((current) => {
        const on = new Set(current.types ?? types);
        if (on.has(type)) on.delete(type);
        else on.add(type);
        return { ...current, types: on };
      }),
    [types],
  );

  return (
    <>
      <div className="graph-filters">
        <ul className="legend">
          {types.map((type) => (
            <li key={type}>
              <label>
                <input type="checkbox" checked={filter.types?.has(type) ?? true} onChange={() => toggle(type)} />
                <span className="dot" style={{ background: colour(type) }} /> {type}
              </label>
            </li>
          ))}
        </ul>
        {teams.length === 0 ? null : (
          <label>
            Team{" "}
            <select
              value={filter.team ?? ""}
              onChange={(event) => setFilter(event.target.value === "" ? (filter.types === undefined ? {} : { types: filter.types }) : { ...filter, team: event.target.value })}
            >
              <option value="">all</option>
              {teams.map((team) => (
                <option key={team} value={team}>
                  {team}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="count">
          {nodes.length} {nodes.length === 1 ? "node" : "nodes"}
        </span>
      </div>
      {picked === undefined ? null : (
        <p className="picked">
          <strong>{nameOf(picked)}</strong> <span className="badge">{picked.type}</span> <code>{formatScope(picked.scope)}</code> ·{" "}
          <a href={pageHref(picked.id)}>Open the page</a>
          {onExpand === undefined ? null : (
            <>
              {" "}
              ·{" "}
              <button type="button" onClick={() => onExpand(picked.id)}>
                Expand its neighbours
              </button>
            </>
          )}
          {" "}· <a href={graphHref(picked.id)}>Centre on it</a>
        </p>
      )}
      <div className="canvas" ref={container} />
    </>
  );
}

export function GraphView({ store, focus }: { store: Store; focus?: string }) {
  // Around a focus: one hop, then what the reader expands. The whole graph otherwise.
  const [expanded, setExpanded] = useState<{ focus: string; shown: ReadonlySet<string> }>();
  const shown = useMemo(() => {
    if (focus === undefined) return undefined;
    if (expanded?.focus === focus) return expanded.shown;
    return new Set(neighbourhood(store, focus, 1).nodes.map((node) => node.id));
  }, [store, focus, expanded]);
  const { nodes, edges } = useMemo(() => {
    if (shown === undefined) return { nodes: [...store.nodes.values()], edges: store.edges };
    return {
      nodes: [...shown].flatMap((id) => store.nodes.get(id) ?? []),
      edges: store.edges.filter((edge) => shown.has(edge.from) && shown.has(edge.to)),
    };
  }, [store, shown]);
  const onExpand = useCallback(
    (id: string) => {
      if (focus !== undefined && shown !== undefined) setExpanded({ focus, shown: expand(shown, store.edges, id) });
    },
    [focus, shown, store.edges],
  );

  const centre = focus === undefined ? undefined : store.nodes.get(focus);
  return (
    <section className="graph-view">
      <h1>{centre === undefined ? (focus === undefined ? "The graph you may read" : "Not found") : nameOf(centre)}</h1>
      <p className="hint">
        {focus === undefined ? (
          "Every node you may read, updated as it changes. Click one to select it."
        ) : centre === undefined ? (
          <>
            There is no node <code>{focus}</code>, or you may not read it.
          </>
        ) : (
          <>
            Its neighbours, either way: select one to expand it. <a href={pageHref(focus)}>Open the page</a> · <a href={graphHref()}>Whole graph</a>
          </>
        )}
      </p>
      <GraphCanvas nodes={nodes} edges={edges} {...(focus === undefined ? {} : { focus, onExpand })} />
    </section>
  );
}
