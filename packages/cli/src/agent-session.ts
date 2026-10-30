import { readFile } from "node:fs/promises";
import { z } from "zod";

// Claude Code's transcript (a JSONL file, one entry per line) as the Markdown of a Session node.
// What the developer and the agent wrote is kept; for tools, the call and a bounded result, since
// tool results hold whole files. Lines that are not messages (summaries, snapshots) are skipped.

const Block = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_use"), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_result"), content: z.unknown() }),
  z.object({ type: z.string() }).loose(),
]);
const Entry = z
  .object({
    type: z.enum(["user", "assistant"]),
    message: z.object({ content: z.union([z.string(), z.array(Block)]) }).loose(),
  })
  .loose();

export const HookInput = z.object({ session_id: z.string().min(1), transcript_path: z.string().min(1) }).loose();

const RESULT_LIMIT = 2000;
const bounded = (text: string) => (text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n… (${text.length - RESULT_LIMIT} more characters)` : text);
const asText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((item) => (typeof item === "object" && item !== null && "text" in item ? String(item.text) : "")).join("\n")
      : JSON.stringify(value);

export function renderTranscript(jsonl: string): { title?: string; transcript: string } {
  const sections: string[] = [];
  let title: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let parsed;
    try {
      parsed = Entry.safeParse(JSON.parse(line));
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    const { type, message } = parsed.data;
    const parts = (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content).flatMap((block) => {
      if (block.type === "text" && "text" in block && typeof block.text === "string") return [block.text.trim()];
      if (block.type === "tool_use" && "name" in block) return [`> tool ${String(block.name)}: ${bounded(JSON.stringify("input" in block ? block.input : {}))}`];
      if (block.type === "tool_result" && "content" in block) return [`> result:\n${bounded(asText(block.content))}`];
      return [];
    });
    const text = parts.filter((part) => part !== "").join("\n\n");
    if (text === "") continue;
    if (title === undefined && type === "user" && !text.startsWith("> result")) title = text.split("\n")[0]?.slice(0, 120);
    sections.push(`## ${type}\n\n${text}`);
  }
  return { ...(title === undefined ? {} : { title }), transcript: sections.join("\n\n") };
}

export async function readTranscript(path: string): Promise<{ title?: string; transcript: string }> {
  return renderTranscript(await readFile(path, "utf8"));
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
