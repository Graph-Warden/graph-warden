import Anthropic from "@anthropic-ai/sdk";
import { AnthropicGoogleCloud } from "@anthropic-ai/google-cloud-sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { LLMProvider } from "@graph-warden/core";

// `LLMProvider` on Claude (proposal 0007), on one of three platforms. Each client reads its own
// settings from the environment:
// - `anthropic`, the Claude API: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login`
//   profile.
// - `google-cloud`, Claude on Google Cloud run by Anthropic: Google credentials (the attached
//   service account on Cloud Run, `gcloud auth application-default login` locally), no API key;
//   ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID, and the project from ANTHROPIC_GOOGLE_CLOUD_PROJECT,
//   GOOGLE_CLOUD_PROJECT or the credentials.
// - `vertex`, Claude on Google's Vertex AI: Google credentials too; CLOUD_ML_REGION (`global` or a
//   region) and the project from the credentials.
//
// A request the model declines for policy reasons is retried server-side on the model's default
// fallback where the platform offers it (not on Vertex AI); if the answer is still a refusal, the
// call fails rather than return an empty answer.

export const DEFAULT_MODEL = "claude-opus-5-5";

export type ClaudePlatform = "anthropic" | "google-cloud" | "vertex";

// What the provider calls: the clients of all three platforms have it.
type Client = { readonly beta: { readonly messages: Pick<Anthropic["beta"]["messages"], "create"> } };

export interface ClaudeOptions {
  readonly platform?: ClaudePlatform;
  readonly model?: string;
  // Thinking depth: answering from a handful of documents rarely needs more than the default.
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly client?: Client;
}

export class Declined extends Error {
  override readonly name = "Declined";
}

export function createClaudeProvider(options: ClaudeOptions = {}): LLMProvider {
  const { platform = "anthropic", model = DEFAULT_MODEL, effort = "medium" } = options;
  const client: Client =
    options.client ??
    (platform === "google-cloud" ? new AnthropicGoogleCloud() : platform === "vertex" ? new AnthropicVertex() : new Anthropic());
  const fallback: { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: "default" } =
    platform === "vertex" ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
  return {
    async complete({ system, prompt }) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: prompt }],
        output_config: { effort },
        ...fallback,
      });
      if (response.stop_reason === "refusal") throw new Declined(`${response.model} declined to answer`);
      return response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim();
    },
  };
}
