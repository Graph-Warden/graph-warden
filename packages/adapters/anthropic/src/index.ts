import Anthropic from "@anthropic-ai/sdk";
import { AnthropicFoundry } from "@anthropic-ai/foundry-sdk";
import { AnthropicGoogleCloud } from "@anthropic-ai/google-cloud-sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import type { LLMProvider } from "@graph-warden/core";

// `LLMProvider` on Claude (proposal 0007), on one of four platforms. Each client reads its own
// settings from the environment:
// - `anthropic`, the Claude API: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login`
//   profile.
// - `google-cloud`, Claude on Google Cloud run by Anthropic: Google credentials (the attached
//   service account on Cloud Run, `gcloud auth application-default login` locally), no API key;
//   ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID, and the project from ANTHROPIC_GOOGLE_CLOUD_PROJECT,
//   GOOGLE_CLOUD_PROJECT or the credentials.
// - `vertex`, Claude on Google's Vertex AI: Google credentials too; CLOUD_ML_REGION (`global` or a
//   region) and the project from the credentials.
// - `foundry`, Claude on Microsoft Foundry: ANTHROPIC_FOUNDRY_RESOURCE (or ANTHROPIC_FOUNDRY_BASE_URL),
//   and ANTHROPIC_FOUNDRY_API_KEY; without a key, Microsoft Entra ID credentials (Workload Identity
//   on AKS, `az login` locally), so that no key is stored.
//
// A request the model declines for policy reasons is retried server-side on the model's default
// fallback where the platform offers it (not on Vertex AI or Foundry); if the answer is still a refusal, the
// call fails rather than return an empty answer.

export const DEFAULT_MODEL = "claude-opus-5-5";

export type ClaudePlatform = "anthropic" | "google-cloud" | "vertex" | "foundry";

// What the provider calls: the clients of all four platforms have it.
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
    (platform === "google-cloud"
      ? new AnthropicGoogleCloud()
      : platform === "vertex"
        ? new AnthropicVertex()
        : platform === "foundry"
          ? foundry()
          : new Anthropic());
  const fallback: { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: "default" } =
    platform === "vertex" || platform === "foundry" ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
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

// Entra ID's scope for Foundry, when there is no key.
const FOUNDRY_SCOPE = "https://ai.azure.com/.default";

function foundry(): AnthropicFoundry {
  if (process.env.ANTHROPIC_FOUNDRY_API_KEY !== undefined) return new AnthropicFoundry();
  return new AnthropicFoundry({ azureADTokenProvider: getBearerTokenProvider(new DefaultAzureCredential(), FOUNDRY_SCOPE) });
}
