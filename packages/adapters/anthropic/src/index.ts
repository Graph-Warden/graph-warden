import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider } from "@graph-warden/core";

// `LLMProvider` on Claude (proposal 0007). Credentials come from the environment as the SDK reads
// them: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
//
// A request the model declines for policy reasons is retried server-side on the model's default
// fallback; if the whole chain declines, the call fails rather than return an empty answer.

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface ClaudeOptions {
  readonly model?: string;
  // Thinking depth: answering from a handful of documents rarely needs more than the default.
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly client?: Anthropic;
}

export class Declined extends Error {
  override readonly name = "Declined";
}

export function createClaudeProvider(options: ClaudeOptions = {}): LLMProvider {
  const { model = DEFAULT_MODEL, effort = "medium", client = new Anthropic() } = options;
  return {
    async complete({ system, prompt }) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: prompt }],
        output_config: { effort },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      if (response.stop_reason === "refusal") throw new Declined(`${response.model} declined to answer`);
      return response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim();
    },
  };
}
