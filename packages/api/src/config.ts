import { readFile } from "node:fs/promises";
import { CORE_ONTOLOGY, type IdentityProvider, type Ontology } from "@graph-warden/core";
import { readOntology } from "@graph-warden/documents";
import {
  createCloudIdentityGroups,
  createDemoIdentity,
  createGoogleIdentity,
  createOidcIdentity,
  DemoUsersSchema,
} from "@graph-warden/identity";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { WebLogin, WebOptions } from "./web.js";

// Configuration from the environment, validated once at start-up: a missing or contradictory
// setting stops the API instead of leaving it half secured.

const list = z
  .string()
  .optional()
  .transform((value) => (value ?? "").split(",").map((item) => item.trim()).filter((item) => item !== ""));

// docker compose passes an unset variable as an empty one.
const setting = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value));

const EnvSchema = z.discriminatedUnion("GWARDEN_IDENTITY", [
  z.object({
    GWARDEN_IDENTITY: z.literal("oidc"),
    OIDC_ISSUER: z.url(),
    OIDC_AUDIENCE: z.string().min(1),
    OIDC_USER_CLAIM: z.string().min(1).default("email"),
    OIDC_GROUPS_CLAIM: z.string().min(1).default("groups"),
  }),
  z.object({
    GWARDEN_IDENTITY: z.literal("google"),
    // The OAuth client id the ID tokens are issued for.
    GOOGLE_CLIENT_ID: z.string().min(1),
    // The Workspace / Cloud Identity domain. Only its accounts are let in, and its groups are named
    // without it (`bff@acme.com` is the team `bff`).
    GOOGLE_DOMAIN: z.string().min(1),
  }),
  z.object({
    GWARDEN_IDENTITY: z.literal("demo"),
    // A YAML list of { token, user, teams }.
    GWARDEN_DEMO_USERS: z.string().min(1),
    // Demo tokens let anyone holding them be that user. They must be asked for twice.
    GWARDEN_DEMO: z.literal("i-understand-anyone-with-a-token-is-that-user", {
      error: "GWARDEN_IDENTITY=demo also needs GWARDEN_DEMO=i-understand-anyone-with-a-token-is-that-user",
    }),
  }),
]);

const CommonSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  NEO4J_URI: z.string().min(1).default("bolt://localhost:7687"),
  NEO4J_USER: z.string().min(1).default("neo4j"),
  NEO4J_PASSWORD: z.string().min(1),
  // A YAML file of the organisation's node and edge types, added to the core ones (proposal 0001):
  // `nodeTypes: [Microservice]`, `edgeTypes: [OWNS]`. The CLI's ingest reads the same variable.
  GWARDEN_ONTOLOGY: setting,
  // Groups whose members may read the audit log through the API.
  GWARDEN_AUDITORS: list,
  // Groups whose members may delete nodes and file answers. None by default: nobody writes.
  GWARDEN_WRITERS: list,
  // The model behind /v1/ask: none (the route answers 501), claude or openai.
  // - claude, on the platform below with its credentials from the environment: anthropic
  //   (ANTHROPIC_API_KEY or an `ant auth login` profile), google-cloud (Claude on Google Cloud run
  //   by Anthropic) or vertex (Google's Vertex AI). Both Google platforms use Google credentials,
  //   never an API key.
  // - openai, any OpenAI-compatible API at GWARDEN_LLM_BASE_URL (OpenAI by default): Azure OpenAI,
  //   Mistral, Ollama, vLLM, LM Studio. OPENAI_API_KEY if the server asks for one.
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
  ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID: setting,
  ANTHROPIC_GOOGLE_CLOUD_BASE_URL: setting,
  CLOUD_ML_REGION: setting,
  // The web app (proposal 0012): on when a session secret is set. Browsers sign in with the
  // identity provider (OIDC authorization code; Google for google), or with a demo token.
  GWARDEN_WEB_SECRET: z.string().min(32).optional(),
  GWARDEN_PUBLIC_URL: z.url().default("http://localhost:8080"),
  GWARDEN_WEB_DIR: z.string().min(1).optional(),
  // The OAuth client browsers sign in with; its ID tokens must be accepted by the identity
  // provider, so its id defaults to OIDC_AUDIENCE or GOOGLE_CLIENT_ID.
  WEB_OIDC_CLIENT_ID: z.string().min(1).optional(),
  WEB_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
});

export type Config = z.infer<typeof CommonSchema> & {
  readonly identity: IdentityProvider;
  readonly identityKind: string;
  readonly ontology: Ontology;
  readonly web?: WebOptions;
};

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<Config> {
  const common = CommonSchema.parse(env);
  // Checked here because the clients only fail on the first question without them.
  if (common.GWARDEN_LLM === "claude" && common.GWARDEN_LLM_PLATFORM === "google-cloud") {
    if (common.ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID === undefined && common.ANTHROPIC_GOOGLE_CLOUD_BASE_URL === undefined) {
      throw new Error("GWARDEN_LLM_PLATFORM=google-cloud needs ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID (wrkspc_…, in the Claude Console)");
    }
  }
  if (common.GWARDEN_LLM === "claude" && common.GWARDEN_LLM_PLATFORM === "vertex" && common.CLOUD_ML_REGION === undefined) {
    throw new Error("GWARDEN_LLM_PLATFORM=vertex needs CLOUD_ML_REGION (global, or a region where the model is enabled)");
  }
  if (common.GWARDEN_LLM === "openai" && common.GWARDEN_LLM_MODEL === undefined) {
    throw new Error("GWARDEN_LLM=openai needs GWARDEN_LLM_MODEL, the name of the model on its server");
  }
  if (common.GWARDEN_LLM === "openai" && common.GWARDEN_LLM_BASE_URL === undefined && common.OPENAI_API_KEY === undefined) {
    throw new Error("GWARDEN_LLM=openai needs OPENAI_API_KEY for OpenAI, or GWARDEN_LLM_BASE_URL for another server");
  }
  const settings = EnvSchema.parse(env);
  const web = common.GWARDEN_WEB_SECRET === undefined ? undefined : webFrom(common, settings, common.GWARDEN_WEB_SECRET);
  const ontology = common.GWARDEN_ONTOLOGY === undefined ? CORE_ONTOLOGY : await readOntology(common.GWARDEN_ONTOLOGY);
  return {
    ...common,
    identity: await identityFrom(settings),
    identityKind: settings.GWARDEN_IDENTITY,
    ontology,
    ...(web === undefined ? {} : { web }),
  };
}

function webFrom(common: z.infer<typeof CommonSchema>, settings: z.infer<typeof EnvSchema>, secret: string): WebOptions {
  const secretFor = (clientId: string) => {
    if (common.WEB_OIDC_CLIENT_SECRET === undefined) throw new Error("The web app needs WEB_OIDC_CLIENT_SECRET to sign users in");
    return { clientId: common.WEB_OIDC_CLIENT_ID ?? clientId, clientSecret: common.WEB_OIDC_CLIENT_SECRET };
  };
  const login: WebLogin =
    settings.GWARDEN_IDENTITY === "demo"
      ? { kind: "demo" }
      : settings.GWARDEN_IDENTITY === "oidc"
        ? { kind: "oidc", issuer: settings.OIDC_ISSUER, ...secretFor(settings.OIDC_AUDIENCE) }
        : { kind: "oidc", issuer: "https://accounts.google.com", ...secretFor(settings.GOOGLE_CLIENT_ID) };
  return { secret, publicUrl: common.GWARDEN_PUBLIC_URL, login, ...(common.GWARDEN_WEB_DIR === undefined ? {} : { dir: common.GWARDEN_WEB_DIR }) };
}

async function identityFrom(settings: z.infer<typeof EnvSchema>): Promise<IdentityProvider> {
  switch (settings.GWARDEN_IDENTITY) {
    case "oidc":
      return createOidcIdentity({
        issuer: settings.OIDC_ISSUER,
        audience: settings.OIDC_AUDIENCE,
        userClaim: settings.OIDC_USER_CLAIM,
        groupsClaim: settings.OIDC_GROUPS_CLAIM,
      });
    case "google":
      return createGoogleIdentity({
        audience: settings.GOOGLE_CLIENT_ID,
        domain: settings.GOOGLE_DOMAIN,
        groups: createCloudIdentityGroups({ domain: settings.GOOGLE_DOMAIN }),
      });
    case "demo":
      return createDemoIdentity(DemoUsersSchema.parse(parseYaml(await readFile(settings.GWARDEN_DEMO_USERS, "utf8"))));
  }
}
