#!/usr/bin/env node
import { createReader } from "@graph-warden/core";
import { createNeo4jAuditLog, createNeo4jEventLog, createNeo4jStore, ensureConstraints } from "@graph-warden/neo4j";
import neo4j from "neo4j-driver";
import { buildApi } from "./app.js";
import { loadConfig } from "./config.js";

const config = await loadConfig(process.env);
const driver = neo4j.driver(config.NEO4J_URI, neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD));
await ensureConstraints(driver);

const reader = createReader(createNeo4jStore(driver), createNeo4jAuditLog(driver), {
  events: createNeo4jEventLog(driver),
  auditors: config.GWARDEN_AUDITORS,
});
const app = buildApi({ reader, identity: config.identity, logger: true });
if (config.identityKind === "demo") app.log.warn("Demo identity: anyone holding a demo token is that user. Never expose this API.");

const stop = async () => {
  await app.close();
  await driver.close();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

await app.listen({ port: config.PORT, host: config.HOST });
