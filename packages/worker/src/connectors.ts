import { readFile } from "node:fs/promises";
import { parseScope, type Connector, type Scope } from "@graph-warden/core";
import { createConfluenceConnector } from "@graph-warden/confluence";
import { createGitLabConnector } from "@graph-warden/gitlab";
import { createJiraConnector } from "@graph-warden/jira";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// The API sources the worker syncs (GWARDEN_CONNECTORS, a YAML list), each on two clocks: content
// every `syncSeconds`, permissions alone every `permissionSeconds` (issue #20). Tokens are named by
// the environment variable that holds them, never written in the file.
//
// - kind: jira
//   baseUrl: https://acme.atlassian.net
//   email: ci@acme.example
//   tokenEnv: JIRA_TOKEN
//   projects: [SHOP, OPS]
//   scopes: { HR: team:hr }          for projects whose permissions are not groups only
// - kind: confluence                 the same, with spaces: [ENG]
// - kind: gitlab
//   baseUrl: https://gitlab.com
//   tokenEnv: GITLAB_TOKEN
//   projects: [acme/shop]

const ScopeValue = z.string().transform((value, context): Scope => {
  try {
    return parseScope(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});
const clocks = { syncSeconds: z.number().int().positive().default(900), permissionSeconds: z.number().int().positive().default(300) };
const atlassian = { baseUrl: z.url({ protocol: /^https?$/ }), email: z.string().min(1), tokenEnv: z.string().min(1), scopes: z.record(z.string(), ScopeValue).default({}), ...clocks };
const ConnectorsSchema = z.array(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("jira"), projects: z.array(z.string().min(1)).min(1), ...atlassian }).strict(),
    z.object({ kind: z.literal("confluence"), spaces: z.array(z.string().min(1)).min(1), ...atlassian }).strict(),
    z.object({ kind: z.literal("gitlab"), baseUrl: z.url({ protocol: /^https?$/ }), tokenEnv: z.string().min(1), projects: z.array(z.string().min(1)).min(1), ...clocks }).strict(),
  ]),
);

export interface ScheduledConnector {
  readonly connector: Connector;
  readonly syncSeconds: number;
  readonly permissionSeconds: number;
}

export function parseConnectors(text: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): ScheduledConnector[] {
  return ConnectorsSchema.parse(parseYaml(text) ?? []).map((entry) => {
    const token = env[entry.tokenEnv];
    if (token === undefined || token === "") throw new Error(`${entry.kind} ${entry.baseUrl}: ${entry.tokenEnv} is not set`);
    const clocks = { syncSeconds: entry.syncSeconds, permissionSeconds: entry.permissionSeconds };
    switch (entry.kind) {
      case "jira":
        return { connector: createJiraConnector({ baseUrl: entry.baseUrl, email: entry.email, token, projects: entry.projects, scopes: entry.scopes, fetch: fetchImpl }), ...clocks };
      case "confluence":
        return { connector: createConfluenceConnector({ baseUrl: entry.baseUrl, email: entry.email, token, spaces: entry.spaces, scopes: entry.scopes, fetch: fetchImpl }), ...clocks };
      case "gitlab":
        return { connector: createGitLabConnector({ baseUrl: entry.baseUrl, token, projects: entry.projects, fetch: fetchImpl }), ...clocks };
    }
  });
}

export async function readConnectors(path: string | undefined, env: NodeJS.ProcessEnv): Promise<ScheduledConnector[]> {
  return path === undefined ? [] : parseConnectors(await readFile(path, "utf8"), env);
}

// Runs `task` now and then every `seconds`, one run at a time, until stopped.
export function every(seconds: number, task: () => Promise<void>): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = () =>
    void task().finally(() => {
      if (!stopped) timer = setTimeout(tick, seconds * 1000);
    });
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
