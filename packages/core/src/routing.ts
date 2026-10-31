import { z } from "zod";
import { recorder, type AuditLog } from "./audit.js";
import type { LLMProvider, LLMRequest } from "./ask.js";
import type { Principal } from "./scope.js";

// Model routing by source sensitivity (issue #28). Every request to a model names the provenance
// sources of the content in its prompt. A request holding content of a confidential source goes to
// the local model only, one running where the graph does (Ollama, vLLM), never to a remote
// provider; when there is no local model, it is refused. A request that names no sources is treated
// as confidential: content of unknown origin is never sent out. Every routing decision is audited
// before the model is called.

export type Sensitivity = "confidential" | "internal";

export interface SensitivityPolicy {
  of(source: string): Sensitivity;
}

// The policy file (GWARDEN_SENSITIVITY): sources listed under `confidential` and `internal`, a
// trailing `*` matching any suffix (`docs:hr*`), and the sensitivity of every other source.
// A source matching both lists is confidential.
export const SensitivityConfigSchema = z
  .object({
    default: z.enum(["confidential", "internal"]).default("internal"),
    confidential: z.array(z.string().min(1)).readonly().default([]),
    internal: z.array(z.string().min(1)).readonly().default([]),
  })
  .strict()
  .readonly();

export type SensitivityConfig = z.input<typeof SensitivityConfigSchema>;

export function createSensitivityPolicy(config: SensitivityConfig = {}): SensitivityPolicy {
  const parsed = SensitivityConfigSchema.parse(config);
  const matcher = (patterns: readonly string[]) => (source: string) =>
    patterns.some((pattern) => (pattern.endsWith("*") ? source.startsWith(pattern.slice(0, -1)) : source === pattern));
  const confidential = matcher(parsed.confidential);
  const internal = matcher(parsed.internal);
  return { of: (source) => (confidential(source) ? "confidential" : internal(source) ? "internal" : parsed.default) };
}

export class Unroutable extends Error {
  override readonly name = "Unroutable";
}

export interface RouterOptions {
  // A provider outside the organisation's infrastructure: content of internal sources only.
  readonly remote?: LLMProvider;
  // A model run where the graph runs: any content.
  readonly local?: LLMProvider;
  readonly policy: SensitivityPolicy;
  readonly audit: AuditLog;
  readonly now?: () => Date;
}

// Audited as the principal the request is made for, or as the service itself (the worker
// revalidating a commit).
export const SERVICE: Principal = { user: "graph-warden", teams: [] };

export function createRouter(options: RouterOptions): LLMProvider {
  const { remote, local, policy, audit, now } = options;
  if (remote === undefined && local === undefined) throw new Error("A router needs a remote or a local model");
  const record = recorder(audit, now);
  return {
    // With no remote model, everything stays local whatever it holds.
    narrows: (source) => remote !== undefined && policy.of(source) === "confidential",
    async complete(request: LLMRequest) {
      const sources = [...new Set(request.sources ?? [])].sort();
      const confidential = request.sources === undefined ? ["(unnamed)"] : sources.filter((source) => policy.of(source) === "confidential");
      const model = confidential.length === 0 && remote !== undefined ? "remote" : "local";
      const principal = request.principal ?? SERVICE;
      const provider = model === "remote" ? remote : local;
      if (provider === undefined) {
        await record({ action: "route", model, sources, confidential, returned: [], denied: true }, principal);
        throw new Unroutable(`No local model to send content of ${confidential.join(", ")} to: it is confidential`);
      }
      await record({ action: "route", model, sources, confidential, returned: [] }, principal);
      return provider.complete(request);
    },
  };
}

// The model the services use: the remote one alone when neither a local model nor a policy is
// configured, as before; a router otherwise. A policy without a local model refuses confidential
// content; a local model without a policy takes everything, nothing being remote-safe by default.
export function routeModels(options: {
  readonly remote: LLMProvider | undefined;
  readonly local: LLMProvider | undefined;
  readonly policy?: SensitivityPolicy | undefined;
  readonly audit: AuditLog;
}): LLMProvider | undefined {
  const { remote, local, policy, audit } = options;
  if (local === undefined && policy === undefined) return remote;
  if (remote === undefined && local === undefined) return undefined;
  return createRouter({
    ...(remote === undefined ? {} : { remote }),
    ...(local === undefined ? {} : { local }),
    policy: policy ?? createSensitivityPolicy({ default: "confidential" }),
    audit,
  });
}
