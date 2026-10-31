import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("asks Vertex AI, which has no server-side fallback, without one", async () => {
    const response = { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] };
    const vertex = fake(response);
    await createClaudeProvider({ platform: "vertex", client: vertex.client }).complete({ system: "", prompt: "q" });
    expect(vertex.requests[0]).not.toHaveProperty("fallbacks");
    expect(vertex.requests[0]).not.toHaveProperty("betas");
    const google = fake(response);
    await createClaudeProvider({ platform: "google-cloud", client: google.client }).complete({ system: "", prompt: "q" });
    expect(google.requests[0]).toMatchObject({ fallbacks: "default" });
    const foundry = fake(response);
    await createClaudeProvider({ platform: "foundry", client: foundry.client }).complete({ system: "", prompt: "q" });
    expect(foundry.requests[0]).not.toHaveProperty("fallbacks");
  });

  it("fails when the model declines instead of returning an empty answer", async () => {
    const { client } = fake({ model: "claude-opus-5-5", stop_reason: "refusal", content: [] });
    await expect(createClaudeProvider({ client }).complete({ system: "", prompt: "q" })).rejects.toThrow(Declined);
  });
});

describe("Claude on Microsoft Foundry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("calls the resource's endpoint with the key from the environment", async () => {
    // Built at run time: not a real key.
    const key = ["test", "foundry", "key"].join("-");
    vi.stubEnv("ANTHROPIC_FOUNDRY_API_KEY", key);
    vi.stubEnv("ANTHROPIC_FOUNDRY_RESOURCE", "acme-ai");
    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      const body = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const answer = await createClaudeProvider({ platform: "foundry" }).complete({ system: "", prompt: "q" });
    expect(answer).toBe("ok");
    expect(calls[0]?.url).toMatch(/^https:\/\/acme-ai\.services\.ai\.azure\.com\/anthropic\/v1\/messages/);
    expect([calls[0]?.headers.get("api-key"), calls[0]?.headers.get("x-api-key")]).toContain(key);
  });
});
