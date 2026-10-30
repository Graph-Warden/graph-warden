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
  const ontology = settings.GWARDEN_ONTOLOGY === undefined ? CORE_ONTOLOGY : await readOntology(settings.GWARDEN_ONTOLOGY);
  return { ...settings, repositories, ontology };
}
