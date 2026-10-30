import { describe, expect, it } from "vitest";
import { renderTranscript } from "../src/agent-session.js";
import { parseCommand } from "../src/args.js";

// A Claude Code transcript as it is written: one JSON entry per line, messages among others.
const jsonl = [
  { type: "summary", summary: "ignored" },
  { type: "user", message: { role: "user", content: "Fix the pagination of GET /orders\nIt skips the last page." } },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Reading the route." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "apps/bff/src/routes/orders.ts" } }] },
  },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(5000) }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Fixed: the cursor was off by one." }] } },
]
  .map((entry) => JSON.stringify(entry))
  .join("\n")
  .concat("\nnot json\n");

describe("renderTranscript", () => {
  it("keeps what the developer and the agent wrote, tool calls and bounded results", () => {
    const { title, transcript } = renderTranscript(jsonl);
    expect(title).toBe("Fix the pagination of GET /orders");
    expect(transcript).toContain("## user\n\nFix the pagination of GET /orders\nIt skips the last page.");
    expect(transcript).toContain('> tool Read: {"file_path":"apps/bff/src/routes/orders.ts"}');
    expect(transcript).toContain("… (3000 more characters)");
    expect(transcript).toContain("Fixed: the cursor was off by one.");
    expect(transcript).not.toContain("hidden");
    expect(transcript).not.toContain("ignored");
  });
});

describe("agent-session arguments", () => {
  const remote = ["--api", "https://gw.example.com", "--token", "t"];
  it("parses capture, preview and promote", () => {
    expect(parseCommand(["agent-session", "capture", ...remote])).toMatchObject({ name: "agent-session", action: "capture" });
    expect(parseCommand(["agent-session", "capture", "--transcript", "s.jsonl", "--id", "s1", ...remote])).toMatchObject({ transcript: "s.jsonl", id: "s1" });
    expect(() => parseCommand(["agent-session", "capture", "--id", "s1", ...remote])).toThrow(/together/);
    expect(parseCommand(["agent-session", "promote", "session:lea:s1", "--scope", "team:bff", "--digest", "abc", ...remote])).toMatchObject({ id: "session:lea:s1", scope: "team:bff", digest: "abc" });
    expect(() => parseCommand(["agent-session", "promote", "session:lea:s1", "--scope", "team:bff", ...remote])).toThrow(/--digest/);
    expect(() => parseCommand(["agent-session", "promote", "x", "--scope", "nope:", "--digest", "d", ...remote])).toThrow();
  });
});
