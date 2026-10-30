import { readFile } from "node:fs/promises";
import type { IdentityProvider } from "@graph-warden/core";
import {
  createCloudIdentityGroups,
  createDemoIdentity,
  createGoogleIdentity,
  createOidcIdentity,
  DemoUsersSchema,
} from "@graph-warden/identity";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Configuration from the environment, validated once at start-up: a missing or contradictory
// setting stops the API instead of leaving it half secured.

const list = z
  .string()
  .optional()
  .transform((value) => (value ?? "").split(",").map((item) => item.trim()).filter((item) => item !== ""));

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
  // Groups whose members may read the audit log through the API.
  GWARDEN_AUDITORS: list,
  // Groups whose members may delete nodes and file answers. None by default: nobody writes.
  GWARDEN_WRITERS: list,
  // The model behind /v1/ask: none (the route answers 501) or claude, with the Anthropic
  // credentials of the environment.
  GWARDEN_LLM: z.enum(["none", "claude"]).default("none"),
  GWARDEN_LLM_MODEL: z.string().min(1).optional(),
});

export type Config = z.infer<typeof CommonSchema> & { readonly identity: IdentityProvider; readonly identityKind: string };

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<Config> {
  const common = CommonSchema.parse(env);
  const settings = EnvSchema.parse(env);
  return { ...common, identity: await identityFrom(settings), identityKind: settings.GWARDEN_IDENTITY };
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
