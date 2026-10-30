import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createClaudeProvider, Declined } from "../src/index.js";

// A client that records the request and answers with the given response.
function fake(response: object) {
  const requests: unknown[] = [];
  const client = { beta: { messages: { create: async (request: unknown) => (requests.push(request), response) } } };
  return { requests, client: client as unknown as Anthropic };
}

describe("Claude provider", () => {
  it("sends the system prompt and the prompt, and joins the text blocks", async () => {
    const { requests, client } = fake({
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: "See [[a]]" }, { type: "text", text: "." }],
    });
    const answer = await createClaudeProvider({ client }).complete({ system: "sys", prompt: "q" });
    expect(answer).toBe("See [[a]].");
    expect(requests).toMatchObject([{ model: "claude-opus-5-5", system: "sys", messages: [{ role: "user", content: "q" }], fallbacks: "default" }]);
  });

  it("fails when the model declines instead of returning an empty answer", async () => {
    const { client } = fake({ model: "claude-opus-5-5", stop_reason: "refusal", content: [] });
    await expect(createClaudeProvider({ client }).complete({ system: "", prompt: "q" })).rejects.toThrow(Declined);
  });
});
