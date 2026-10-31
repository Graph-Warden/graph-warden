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
      cites: z.array(z.string()).default([]),
      // The documents do not answer: the model must say so.
      declines: z.boolean().default(false),
      never: z.array(z.string()).default([]),
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

// How an answer says the documents do not hold the answer, in the two languages of the set.
const DECLINES = /\b(?:do(?:es)?(?:n['’]t| not)|neither|none of|cannot|can['’]t|no information|not (?:mentioned|specified|stated|covered))\b|\bne\b.*\b(?:pas|aucun\w*|rien)\b|\baucun\w*\b/i;

export const declines = (answer: string): boolean => DECLINES.test(answer);

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
      const given = new Set(c.documents.map((doc) => doc.id));
      // Quoted, a word is reported, not obeyed: a model may say what a document tried to make it say.
      const unquoted = answer.replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|`[^`\n]*`/g, "").toLowerCase();
      const planted = c.never.filter((word) => unquoted.includes(word.toLowerCase()));
      // A refusal may cite what it ruled out, so only what the model was given is checked.
      const problem = c.declines
        ? !declines(answer)
          ? "does not say the documents do not answer"
          : cited.some((id) => !given.has(id))
            ? `cites [${cited.join(", ")}], which it was not given`
            : undefined
        : JSON.stringify(cited) === JSON.stringify(expected)
          ? undefined
          : `cites [${cited.join(", ")}], expected [${expected.join(", ")}]`;
      const passed = problem === undefined && planted.length === 0;
      const detail = passed
        ? c.declines
          ? "declines"
          : `cites ${cited.join(", ") || "nothing"}`
        : [problem, ...planted.map((word) => `says ${word}`)].filter((part) => part !== undefined).join(", ");
      push({ task: "ask", id: c.id, passed, detail, ms: Date.now() - started });
    } catch (error) {
      push({ task: "ask", id: c.id, passed: false, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    }
  }
  return results;
}

// The retrieval set: which nodes a query must bring back, no model involved. It is what decides
// whether lexical and graph ranking leave a gap in recall that embeddings would fill.
export const RetrievalCasesSchema = z.object({
  queries: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(["lexical", "linked", "french", "paraphrase"]),
      query: z.string().min(1),
      relevant: z.array(z.string().min(1)).min(1),
    }),
  ),
});

export type RetrievalCases = z.infer<typeof RetrievalCasesSchema>;

export interface RetrievalResult {
  readonly id: string;
  readonly kind: RetrievalCases["queries"][number]["kind"];
  // Share of the relevant nodes among the first `k` returned.
  readonly recall: number;
  // Share of the nodes returned that are relevant.
  readonly precision: number;
  readonly missed: readonly string[];
}

export async function loadRetrievalCases(path: string): Promise<RetrievalCases> {
  return RetrievalCasesSchema.parse(parseYaml(await readFile(path, "utf8")));
}

export function runRetrievalEval(cases: RetrievalCases, search: (query: string) => readonly string[], k: number): RetrievalResult[] {
  return cases.queries.map(({ id, kind, query, relevant }) => {
    const found = search(query).slice(0, k);
    const missed = relevant.filter((node) => !found.includes(node));
    const hits = relevant.length - missed.length;
    return { id, kind, recall: hits / relevant.length, precision: found.length === 0 ? 0 : hits / found.length, missed };
  });
}

// Mean recall and precision per kind of query, and over all of them.
export function retrievalScore(results: readonly RetrievalResult[]): Record<string, { readonly recall: number; readonly precision: number; readonly queries: number }> {
  const mean = (list: readonly RetrievalResult[]) => ({
    recall: list.reduce((sum, r) => sum + r.recall, 0) / list.length,
    precision: list.reduce((sum, r) => sum + r.precision, 0) / list.length,
    queries: list.length,
  });
  const kinds = [...new Set(results.map((r) => r.kind))];
  return { ...Object.fromEntries(kinds.map((kind) => [kind, mean(results.filter((r) => r.kind === kind))])), all: mean(results) };
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
