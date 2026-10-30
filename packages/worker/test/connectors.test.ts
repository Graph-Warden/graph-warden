import { expect, it } from "vitest";
import { parseConnectors } from "../src/connectors.js";

it("reads the connectors file, tokens from the environment only", () => {
  const yaml = `
- kind: jira
  baseUrl: https://acme.atlassian.net
  email: ci@acme.example
  tokenEnv: JIRA_TOKEN
  projects: [SHOP]
  scopes: { HR: "team:hr" }
- kind: confluence
  baseUrl: https://acme.atlassian.net
  email: ci@acme.example
  tokenEnv: JIRA_TOKEN
  spaces: [ENG]
  permissionSeconds: 60
- kind: gitlab
  baseUrl: https://gitlab.example.com
  tokenEnv: GITLAB_TOKEN
  projects: [acme/shop]
`;
  const connectors = parseConnectors(yaml, { JIRA_TOKEN: "j", GITLAB_TOKEN: "g" });
  expect(connectors.map((c) => [c.connector.source, c.syncSeconds, c.permissionSeconds])).toEqual([
    ["jira:acme.atlassian.net", 900, 300],
    ["confluence:acme.atlassian.net", 900, 60],
    ["gitlab:gitlab.example.com", 900, 300],
  ]);
  expect(() => parseConnectors(yaml, { JIRA_TOKEN: "j" })).toThrow(/GITLAB_TOKEN is not set/);
  expect(() => parseConnectors("- kind: jira\n  baseUrl: https://a.example\n  email: e\n  tokenEnv: T\n  projects: [X]\n  token: inline", { T: "t" })).toThrow();
  expect(() => parseConnectors('- kind: jira\n  baseUrl: https://a.example\n  email: e\n  tokenEnv: T\n  projects: [X]\n  scopes: { X: "nope:" }', { T: "t" })).toThrow();
});
