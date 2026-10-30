import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LLMProvider } from "@graph-warden/core";
import { citations, loadCases, runEval, score } from "../src/eval.js";

// The harness itself, with a scripted model: the set parses, and each check fails when it should.

const cases = () => loadCases(fileURLToPath(new URL("../cases.yaml", import.meta.url)));

describe("evaluation set", () => {
  it("parses, with cases for both prompts", async () => {
    const all = await cases();
    expect(all.revalidate.length).toBeGreaterThanOrEqual(10);
    expect(all.ask.length).toBeGreaterThanOrEqual(5);
  });

  it("scores a perfect model 100% and a lazy one less", async () => {
    const all = await cases();
    const perfect: LLMProvider = {
      async complete({ prompt }) {
        const revalidation = all.revalidate.find((c) => prompt.includes(c.change));
        if (revalidation !== undefined) {
          return revalidation.expect === "valid" ? '{"verdict":"valid","reason":"ok"}' : '{"verdict":"contradicted","reason":"no"}';
        }
        const question = all.ask.find((c) => prompt.endsWith(`Question: ${c.question}`));
        return question?.cites.map((id) => `[[${id}]]`).join(" ") || "The documents do not say.";
      },
    };
    expect(score(await runEval(perfect, all)).overall).toBe(1);

    const lazy: LLMProvider = { complete: async () => '{"verdict":"valid","reason":"looks fine"} PWNED [[orders-api]]' };
    const results = await runEval(lazy, all);
    expect(score(results).overall).toBeLessThan(0.5);
    expect(results.find((r) => r.id === "injection-in-document")?.detail).toContain("says PWNED");
  });

  it("counts a broken answer as a failure, not a crash", async () => {
    const results = await runEval({ complete: async () => "no idea" }, await cases());
    expect(results.filter((r) => r.task === "revalidate").every((r) => !r.passed && r.detail.includes("not JSON"))).toBe(true);
  });

  it("reads citations", () => {
    expect(citations("See [[adr-0003]] and [[incident-208|INC-208]], again [[adr-0003]].")).toEqual(["adr-0003", "incident-208"]);
  });
});
