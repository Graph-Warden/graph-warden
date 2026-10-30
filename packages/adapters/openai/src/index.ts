import type { LLMProvider } from "@graph-warden/core";

// `LLMProvider` on any OpenAI-compatible Chat Completions API (proposal 0007): OpenAI, Azure OpenAI
// (its v1 API, https://<resource>.openai.azure.com/openai/v1), Mistral, and the local servers
// (Ollama, vLLM, LM Studio), which keep a confidential source on the network. Only the
// `/chat/completions` route is used: it is the one every such server implements.
//
// A refusal (`refusal`, or a `content_filter` finish) fails the call rather than return an empty
// answer, as with Claude. Reasoning models served locally may write their thinking in the content
// between <think> tags: it is not part of the answer and is dropped.

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
// Ollama's OpenAI-compatible API on its default port: the default local model (issue #28).
export const LOCAL_BASE_URL = "http://localhost:11434/v1";

export interface OpenAICompatibleOptions {
  // No default: a model name means nothing outside the server it is served by.
  readonly model: string;
  readonly baseUrl?: string;
  // Sent as a bearer token. Local servers need none.
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class Declined extends Error {
  override readonly name = "Declined";
}

interface ChatCompletion {
  readonly model?: string;
  readonly choices?: readonly {
    readonly finish_reason?: string | null;
    readonly message?: { readonly content?: string | null; readonly refusal?: string | null };
  }[];
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): LLMProvider {
  const { model, baseUrl = DEFAULT_BASE_URL, apiKey, timeoutMs = 120_000, fetch: send = fetch } = options;
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async complete({ system, prompt }) {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }) },
        body: JSON.stringify({
          model,
          messages: [
            ...(system === "" ? [] : [{ role: "system", content: system }]),
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // The body of an error names its cause (unknown model, bad key) but may be long: cut it.
      if (!response.ok) throw new Error(`${url} answered ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const completion = (await response.json()) as ChatCompletion;
      const choice = completion.choices?.[0];
      if (choice?.message?.refusal || choice?.finish_reason === "content_filter") {
        throw new Declined(`${completion.model ?? model} declined to answer`);
      }
      const content = choice?.message?.content;
      if (typeof content !== "string") throw new Error(`${url} answered without content`);
      return content.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();
    },
  };
}
