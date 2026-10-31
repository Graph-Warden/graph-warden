#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClaudeProvider } from "@graph-warden/anthropic";
import type { LLMProvider } from "@graph-warden/core";
import { createOpenAICompatibleProvider } from "@graph-warden/openai";
import { loadCases, runEval, score } from "./eval.js";

// gwarden-eval --llm claude [--platform anthropic|google-cloud|vertex] [--model <id>]
// gwarden-eval --llm openai --model <name> [--base-url http://localhost:11434/v1]
// Prints each case, then the scores; --out writes them as JSON.

const { values } = parseArgs({
  options: {
    llm: { type: "string" },
    model: { type: "string" },
    platform: { type: "string", default: "anthropic" },
    "base-url": { type: "string" },
    cases: { type: "string", default: fileURLToPath(new URL("../cases.yaml", import.meta.url)) },
    out: { type: "string" },
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

try {
  const { llm, name } = provider();
  const results = await runEval(llm, await loadCases(values.cases), (r) =>
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.task.padEnd(10)} ${r.id.padEnd(24)} ${String(r.ms).padStart(6)} ms  ${r.detail}`),
  );
  const scores = score(results);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  console.log(`\n${name}: revalidate ${pct(scores.revalidate)}, ask ${pct(scores.ask)}, overall ${pct(scores.overall)}`);
  if (values.out !== undefined) await writeFile(values.out, `${JSON.stringify({ provider: name, at: new Date().toISOString(), scores, results }, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
