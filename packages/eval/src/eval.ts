import { readFile } from "node:fs/promises";
import { ASK_SYSTEM, askPrompt, askVerdict, NodeSchema, type LLMProvider, type Node } from "@graph-warden/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Runs the shared evaluation set (proposal 0007) against one provider: the same prompts the
// revalidator and the asker send, the same validation of what comes back.

const DocumentSchema = z
  .object({ id: z.string().min(1), type: z.string().min(1), title: z.string().optional(), body: z.string() })
  .transform((doc): Node => NodeSchema.parse({ ...doc, scope: { kind: "shared" }, provenance: { source: "eval", path: doc.id } }));

export const CasesSchema = z.object({
  revalidate: z.array(
    z.object({
      id: z.string().min(1),
      document: DocumentSchema,
      change: z.string().min(1),
      expect: z.enum(["valid", "stale"]),
      mentions: z.array(z.string()).default([]),
    }),
  ),
  ask: z.array(
    z.object({
      id: z.string().min(1),
      documents: z.array(DocumentSchema).min(1),
      question: z.string().min(1),
      cites: z.array(z.string()),
      never: z.string().optional(),
    }),
  ),
});

export type Cases = z.infer<typeof CasesSchema>;

export interface CaseResult {
  readonly task: "revalidate" | "ask";
  readonly id: string;
  readonly passed: boolean;
  // What was wrong, or what the model said.
  readonly detail: string;
  readonly ms: number;
}

export async function loadCases(path: string): Promise<Cases> {
  return CasesSchema.parse(parseYaml(await readFile(path, "utf8")));
}

export const citations = (answer: string): string[] => [...new Set([...answer.matchAll(/\[\[([^\]|#]+)/g)].map((m) => (m[1] ?? "").trim()))].sort();

export async function runEval(llm: LLMProvider, cases: Cases, onResult: (result: CaseResult) => void = () => {}): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const push = (result: CaseResult) => {
    results.push(result);
    onResult(result);
  };
  for (const c of cases.revalidate) {
    const started = Date.now();
    try {
      const verdict = await askVerdict(llm, c.document, c.change);
      const got = verdict.verdict === "valid" ? "valid" : "stale";
      const missing = verdict.verdict === "updated" ? c.mentions.filter((word) => !(verdict.body ?? "").toLowerCase().includes(word.toLowerCase())) : [];
      const passed = got === c.expect && missing.length === 0;
      const detail = passed ? verdict.verdict : `${verdict.verdict}, expected ${c.expect}${missing.length > 0 ? `, body lacks ${missing.join(", ")}` : ""}: ${verdict.reason}`;
      push({ task: "revalidate", id: c.id, passed, detail, ms: Date.now() - started });
    } catch (error) {
      push({ task: "revalidate", id: c.id, passed: false, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    }
  }
  for (const c of cases.ask) {
    const started = Date.now();
    try {
      const answer = await llm.complete({ system: ASK_SYSTEM, prompt: askPrompt(c.question, c.documents) });
      const cited = citations(answer);
      const expected = [...c.cites].sort();
      const injected = c.never !== undefined && answer.includes(c.never);
      const passed = JSON.stringify(cited) === JSON.stringify(expected) && !injected;
      const detail = passed ? `cites ${cited.join(", ") || "nothing"}` : `cites [${cited.join(", ")}], expected [${expected.join(", ")}]${injected ? `, says ${c.never}` : ""}`;
      push({ task: "ask", id: c.id, passed, detail, ms: Date.now() - started });
    } catch (error) {
      push({ task: "ask", id: c.id, passed: false, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    }
  }
  return results;
}

export interface Score {
  readonly revalidate: number;
  readonly ask: number;
  readonly overall: number;
}

export function score(results: readonly CaseResult[]): Score {
  const rate = (list: readonly CaseResult[]) => (list.length === 0 ? 0 : list.filter((r) => r.passed).length / list.length);
  return {
    revalidate: rate(results.filter((r) => r.task === "revalidate")),
    ask: rate(results.filter((r) => r.task === "ask")),
    overall: rate(results),
  };
}
