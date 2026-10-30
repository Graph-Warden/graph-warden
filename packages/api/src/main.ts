#!/usr/bin/env node
import { createClaudeProvider } from "@graph-warden/anthropic";
import { createAsker, createEditor, createPages, createReader, createWriter } from "@graph-warden/core";
import { createNeo4jAuditLog, createNeo4jEventLog, createNeo4jStore, ensureConstraints } from "@graph-warden/neo4j";
import neo4j from "neo4j-driver";
import { buildApi } from "./app.js";
import { loadConfig } from "./config.js";

const config = await loadConfig(process.env);
const driver = neo4j.driver(config.NEO4J_URI, neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD));
await ensureConstraints(driver);

const store = createNeo4jStore(driver);
const audit = createNeo4jAuditLog(driver);
const events = createNeo4jEventLog(driver);
const writer = createWriter(store, events);
const writers = config.GWARDEN_WRITERS;
const reader = createReader(store, audit, { events, auditors: config.GWARDEN_AUDITORS });
const editor = createEditor(store, writer, audit, { writers });
const pages = createPages(store, writer, audit, { writers });
const llm =
  config.GWARDEN_LLM === "claude"
    ? createClaudeProvider({
        platform: config.GWARDEN_LLM_PLATFORM,
        ...(config.GWARDEN_LLM_MODEL === undefined ? {} : { model: config.GWARDEN_LLM_MODEL }),
      })
    : undefined;
const asker = llm === undefined ? undefined : createAsker(store, writer, audit, llm, { writers });
const app = buildApi({
  reader,
  editor,
  pages,
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
