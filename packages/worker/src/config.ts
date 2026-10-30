import { readFile } from "node:fs/promises";
import { CORE_ONTOLOGY, parseScope, type Ontology, type Principal, type Scope } from "@graph-warden/core";
import { readOntology } from "@graph-warden/documents";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Configuration from the environment, validated once at start-up.

const setting = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8081),
  HOST: z.string().default("0.0.0.0"),
  NEO4J_URI: z.string().min(1).default("bolt://localhost:7687"),
  NEO4J_USER: z.string().min(1).default("neo4j"),
  NEO4J_PASSWORD: z.string().min(1),
  // The repositories to ingest, as a YAML file (see RepositoriesSchema).
  GWARDEN_REPOSITORIES: z.string().min(1),
  GWARDEN_ONTOLOGY: setting,
  // Several workers share a Redis queue; without it, the queue lives in this one process.
  REDIS_URL: setting,
  // Triggers: each one is on when its setting is.
  GITHUB_WEBHOOK_SECRET: setting.pipe(z.string().min(16).optional()),
  GWARDEN_PUSH_TOKEN: setting.pipe(z.string().min(16).optional()),
  GWARDEN_POLL_SECONDS: z.coerce.number().int().nonnegative().default(0),
  // The model that revalidates knowledge after each commit (proposal 0005), as for the API's
  // /v1/ask: none, claude or openai, with the same settings. None: nothing is revalidated.
  GWARDEN_LLM: z.enum(["none", "claude", "openai"]).default("none"),
  GWARDEN_LLM_PLATFORM: z.enum(["anthropic", "google-cloud", "vertex"]).default("anthropic"),
  GWARDEN_LLM_MODEL: setting,
  GWARDEN_LLM_BASE_URL: setting.pipe(z.url({ protocol: /^https?$/ }).optional()),
  OPENAI_API_KEY: setting,
  // Model routing by source sensitivity (issue #28): content of a source GWARDEN_SENSITIVITY (a
  // YAML file: default, confidential, internal) calls confidential goes only to the local model,
  // an OpenAI-compatible server run alongside (Ollama by default) named by GWARDEN_LOCAL_LLM_MODEL.
  // Every routing decision is audited.
  GWARDEN_LOCAL_LLM_MODEL: setting,
  GWARDEN_LOCAL_LLM_BASE_URL: setting.pipe(z.url({ protocol: /^https?$/ }).optional()),
  GWARDEN_SENSITIVITY: setting,
  // Knowledge further than this many hops from a change is marked stale and revalidated on its
  // first read instead.
  GWARDEN_REVALIDATE_DEPTH: z.coerce.number().int().nonnegative().default(3),
});

// - name: github:acme/shop        provenance source of its nodes; matches GitHub webhooks of acme/shop
//   dir: /var/lib/gwarden/shop    a clone whose `origin` is the repository
//   branch: main                  the branch ingested (main by default)
//   scope: team:bff               scope of documents without a scope: field, and of Change nodes
//   author: { user: ingestion, teams: [bff, front-a] }   who derived documents are derived for
const RepositoriesSchema = z.array(
  z
    .object({
      name: z.string().min(1),
      dir: z.string().min(1),
      branch: z.string().min(1).default("main"),
      scope: z.string().transform((value, context): Scope => {
        try {
          return parseScope(value);
        } catch (error) {
          context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
          return z.NEVER;
        }
      }),
      author: z.object({ user: z.string().min(1), teams: z.array(z.string().min(1)).default([]) }),
    })
    .strict(),
);

export interface RepositoryEntry {
  readonly name: string;
  readonly dir: string;
  readonly branch: string;
  readonly scope: Scope;
  readonly author: Principal;
}

export type WorkerConfig = z.infer<typeof EnvSchema> & {
  readonly repositories: readonly RepositoryEntry[];
  readonly ontology: Ontology;
};

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<WorkerConfig> {
  const settings = EnvSchema.parse(env);
  const repositories = RepositoriesSchema.parse(parseYaml(await readFile(settings.GWARDEN_REPOSITORIES, "utf8")) ?? []);
  const names = repositories.map((repo) => repo.name);
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice !== undefined) throw new Error(`${settings.GWARDEN_REPOSITORIES}: ${twice} is listed twice`);
  if (settings.GITHUB_WEBHOOK_SECRET === undefined && settings.GWARDEN_PUSH_TOKEN === undefined && settings.GWARDEN_POLL_SECONDS === 0) {
    throw new Error("No trigger: set GITHUB_WEBHOOK_SECRET, GWARDEN_PUSH_TOKEN or GWARDEN_POLL_SECONDS");
  }
  if (settings.GWARDEN_LLM === "openai" && settings.GWARDEN_LLM_MODEL === undefined) {
    throw new Error("GWARDEN_LLM=openai needs GWARDEN_LLM_MODEL, the name of the model on its server");
  }
  const ontology = settings.GWARDEN_ONTOLOGY === undefined ? CORE_ONTOLOGY : await readOntology(settings.GWARDEN_ONTOLOGY);
  return { ...settings, repositories, ontology };
}
