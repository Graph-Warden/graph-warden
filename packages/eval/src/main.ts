#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClaudeProvider } from "@graph-warden/anthropic";
import { createGraph, retrieve, type LLMProvider, type Principal } from "@graph-warden/core";
import { readDocuments } from "@graph-warden/documents";
import { createOpenAICompatibleProvider } from "@graph-warden/openai";
import { loadCases, loadRetrievalCases, retrievalScore, runEval, runRetrievalEval, score } from "./eval.js";

// gwarden-eval --llm claude [--platform anthropic|google-cloud|vertex] [--model <id>]
// gwarden-eval --llm openai --model <name> [--base-url http://localhost:11434/v1]
// gwarden-eval --retrieval [--k 8] [--corpus <dir>] [--queries <yaml>] [--teams a,b]
// Prints each case, then the scores; --out writes them as JSON. --retrieval needs no model.

const { values } = parseArgs({
  options: {
    llm: { type: "string" },
    model: { type: "string" },
    platform: { type: "string", default: "anthropic" },
    "base-url": { type: "string" },
    cases: { type: "string", default: fileURLToPath(new URL("../cases.yaml", import.meta.url)) },
    out: { type: "string" },
    retrieval: { type: "boolean", default: false },
    k: { type: "string", default: "8" },
    teams: { type: "string" },
    corpus: { type: "string", default: fileURLToPath(new URL("../../../examples/shop/docs", import.meta.url)) },
    queries: { type: "string", default: fileURLToPath(new URL("../retrieval.yaml", import.meta.url)) },
  },
});

function provider(): { llm: LLMProvider; name: string } {
  if (values.llm === "claude") {
    const platform = values.platform;
    if (platform !== "anthropic" && platform !== "google-cloud" && platform !== "vertex" && platform !== "foundry") throw new Error("--platform: anthropic, google-cloud, vertex or foundry");
    return { llm: createClaudeProvider({ platform, ...(values.model === undefined ? {} : { model: values.model }) }), name: `claude ${values.model ?? "default"} (${platform})` };
  }
  if (values.llm === "openai") {
    if (values.model === undefined) throw new Error("--llm openai needs --model");
    const baseUrl = values["base-url"];
    const apiKey = process.env.OPENAI_API_KEY;
    return {
      llm: createOpenAICompatibleProvider({ model: values.model, ...(baseUrl === undefined ? {} : { baseUrl }), ...(apiKey === undefined ? {} : { apiKey }) }),
      name: `${values.model}${baseUrl === undefined ? "" : ` at ${baseUrl}`}`,
    };
  }
  throw new Error("--llm claude or --llm openai");
}

// Reads like the demo's Lea, who may read every document of the example corpus.
const READER: Principal = { user: "lea", teams: values.teams?.split(",").map((team) => team.trim()) ?? ["bff", "data", "front-a", "front-b", "front-c", "shopping-front", "user"] };

async function evaluateRetrieval(): Promise<void> {
  const { nodes, edges } = await readDocuments(values.corpus, { source: "docs:shop", defaultScope: { kind: "shared" } });
  const graph = createGraph(nodes, edges);
  const k = Number(values.k);
  const results = runRetrievalEval(await loadRetrievalCases(values.queries), (query) => retrieve(graph, READER, query, { limit: k }).map((node) => node.id), k);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  for (const r of results) console.log(`${pct(r.recall).padStart(4)}  ${r.kind.padEnd(10)} ${r.id.padEnd(20)} ${r.missed.length === 0 ? "" : `missed ${r.missed.join(", ")}`}`);
  const scores = retrievalScore(results);
  console.log(`\n${Object.entries(scores).map(([kind, s]) => `${kind}: recall ${pct(s.recall)}, precision ${pct(s.precision)} (${s.queries})`).join("\n")}`);
  if (values.out !== undefined) await writeFile(values.out, `${JSON.stringify({ k, at: new Date().toISOString(), scores, results }, null, 2)}\n`);
}

try {
  if (values.retrieval) await evaluateRetrieval();
  else await evaluatePrompts();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function evaluatePrompts(): Promise<void> {
  const { llm, name } = provider();
  const results = await runEval(llm, await loadCases(values.cases), (r) =>
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.task.padEnd(10)} ${r.id.padEnd(24)} ${String(r.ms).padStart(6)} ms  ${r.detail}`),
  );
  const scores = score(results);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  console.log(`\n${name}: revalidate ${pct(scores.revalidate)}, ask ${pct(scores.ask)}, overall ${pct(scores.overall)}`);
  if (values.out !== undefined) await writeFile(values.out, `${JSON.stringify({ provider: name, at: new Date().toISOString(), scores, results }, null, 2)}\n`);
}
