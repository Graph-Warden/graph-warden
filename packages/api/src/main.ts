#!/usr/bin/env node
import { createClaudeProvider } from "@graph-warden/anthropic";
import { createAsker, createEditor, createHistory, createPages, createReader, createRevalidator, createAgentSessions, createWriter, routeModels } from "@graph-warden/core";
import { createDocumentExtractor, readSensitivity } from "@graph-warden/documents";
import { createNeo4jAuditLog, createNeo4jEventLog, createNeo4jStaleMarks, createNeo4jStore, createNeo4jTextIndex, ensureConstraints } from "@graph-warden/neo4j";
import { createOpenAICompatibleProvider, LOCAL_BASE_URL } from "@graph-warden/openai";
import { createOpenApiExtractor } from "@graph-warden/openapi";
import { createTypeScriptExtractor } from "@graph-warden/typescript";
import neo4j from "neo4j-driver";
import { buildApi } from "./app.js";
import { loadConfig } from "./config.js";
import { createGitPast } from "./history.js";

const config = await loadConfig(process.env);
const driver = neo4j.driver(config.NEO4J_URI, neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD));
await ensureConstraints(driver);

const store = createNeo4jStore(driver);
const audit = createNeo4jAuditLog(driver);
const events = createNeo4jEventLog(driver);
const writer = createWriter(store, events, { ontology: config.ontology });
const writers = config.GWARDEN_WRITERS;
const remote =
  config.GWARDEN_LLM === "claude"
    ? createClaudeProvider({
        platform: config.GWARDEN_LLM_PLATFORM,
        ...(config.GWARDEN_LLM_MODEL === undefined ? {} : { model: config.GWARDEN_LLM_MODEL }),
      })
    : config.GWARDEN_LLM === "openai" && config.GWARDEN_LLM_MODEL !== undefined
      ? createOpenAICompatibleProvider({
          model: config.GWARDEN_LLM_MODEL,
          ...(config.GWARDEN_LLM_BASE_URL === undefined ? {} : { baseUrl: config.GWARDEN_LLM_BASE_URL }),
          ...(config.OPENAI_API_KEY === undefined ? {} : { apiKey: config.OPENAI_API_KEY }),
        })
      : undefined;
const llm = routeModels({
  remote,
  local:
    config.GWARDEN_LOCAL_LLM_MODEL === undefined
      ? undefined
      : createOpenAICompatibleProvider({ model: config.GWARDEN_LOCAL_LLM_MODEL, baseUrl: config.GWARDEN_LOCAL_LLM_BASE_URL ?? LOCAL_BASE_URL }),
  ...(config.GWARDEN_SENSITIVITY === undefined ? {} : { policy: await readSensitivity(config.GWARDEN_SENSITIVITY) }),
  audit,
});
// Knowledge the worker marked stale is revalidated on its first read (proposal 0005).
const revalidator = llm === undefined ? undefined : createRevalidator({ store, writer, llm, marks: createNeo4jStaleMarks(driver) });
const index = createNeo4jTextIndex(driver);
const reader = createReader(store, audit, {
  events,
  index,
  auditors: config.GWARDEN_AUDITORS,
  ...(revalidator === undefined ? {} : { refresh: revalidator.refresh }),
});
const editor = createEditor(store, writer, audit, { writers });
const pages = createPages(store, writer, audit, { writers });
const agentSessions = createAgentSessions(store, writer, audit);
const asker = llm === undefined ? undefined : createAsker(store, writer, audit, llm, { writers, index, ...(config.GWARDEN_ASK_BUDGET === undefined ? {} : { budget: config.GWARDEN_ASK_BUDGET }) });
// The same extractors as the worker's, so that the past is extracted as the present was.
const history =
  config.repositories.length === 0
    ? undefined
    : createHistory(
        store,
        audit,
        createGitPast({
          repositories: config.repositories,
          extractors: [createDocumentExtractor({ ontology: config.ontology }), createTypeScriptExtractor(), createOpenApiExtractor()],
          ontology: config.ontology,
        }),
      );
const app = buildApi({
  reader,
  editor,
  pages,
  agentSessions,
  ...(history === undefined ? {} : { history }),
  ontology: config.ontology,
  ...(asker === undefined ? {} : { asker }),
  ...(config.web === undefined ? {} : { web: config.web }),
  identity: config.identity,
  logger: true,
});
if (config.identityKind === "demo") app.log.warn("Demo identity: anyone holding a demo token is that user. Never expose this API.");

const stop = async () => {
  await app.close();
  await driver.close();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

await app.listen({ port: config.PORT, host: config.HOST });
