import { describe, expect, it } from "vitest";
import { createOpenAICompatibleProvider, Declined } from "../src/index.js";

// A fetch that records the request and answers with the given status and body.
function fake(body: object, status = 200) {
  const requests: { url: string; init: RequestInit }[] = [];
  const send = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  };
  return { requests, fetch: send as typeof fetch };
}

const answer = (content: string | null, extra: object = {}) => ({
  model: "llama3.3",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content, ...extra } }],
});

describe("OpenAI-compatible provider", () => {
  it("posts the system prompt and the prompt to the chat completions of the base URL", async () => {
    const { requests, fetch } = fake(answer(" See [[a]]. "));
    const provider = createOpenAICompatibleProvider({ model: "llama3.3", baseUrl: "http://localhost:11434/v1/", fetch });
    expect(await provider.complete({ system: "sys", prompt: "q" })).toBe("See [[a]].");
    expect(requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      model: "llama3.3",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
      ],
    });
    expect(requests[0]?.init.headers).not.toHaveProperty("authorization");
  });

  it("sends the API key as a bearer token, to OpenAI by default", async () => {
    const { requests, fetch } = fake(answer("ok"));
    await createOpenAICompatibleProvider({ model: "gpt-5", apiKey: "sk-test", fetch }).complete({ system: "", prompt: "q" });
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0]?.init.headers).toMatchObject({ authorization: "Bearer sk-test" });
    expect(JSON.parse(String(requests[0]?.init.body)).messages).toEqual([{ role: "user", content: "q" }]);
  });

  it("drops the thinking a local reasoning model writes before its answer", async () => {
    const { fetch } = fake(answer("<think>\nThe user wants…\n</think>\n\nCursors, see [[adr]]."));
    const provider = createOpenAICompatibleProvider({ model: "qwen3", baseUrl: "http://localhost:8000/v1", fetch });
    expect(await provider.complete({ system: "", prompt: "q" })).toBe("Cursors, see [[adr]].");
  });

  it("fails when the model declines instead of returning an empty answer", async () => {
    const refused = fake(answer(null, { refusal: "I can't help with that." }));
    await expect(createOpenAICompatibleProvider({ model: "gpt-5", fetch: refused.fetch }).complete({ system: "", prompt: "q" })).rejects.toThrow(Declined);
    const filtered = fake({ model: "gpt-5", choices: [{ finish_reason: "content_filter", message: { content: "" } }] });
    await expect(createOpenAICompatibleProvider({ model: "gpt-5", fetch: filtered.fetch }).complete({ system: "", prompt: "q" })).rejects.toThrow(Declined);
  });

  it("fails with the server's reason when it answers with an error", async () => {
    const { fetch } = fake({ error: { message: "model 'llama9' not found" } }, 404);
    await expect(createOpenAICompatibleProvider({ model: "llama9", fetch }).complete({ system: "", prompt: "q" })).rejects.toThrow(/404.*llama9/);
  });
});
