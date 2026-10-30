#!/usr/bin/env node
import { createIngester, createWriter, type IngestionQueue } from "@graph-warden/core";
import { createDocumentExtractor } from "@graph-warden/documents";
import { createGitRepository } from "@graph-warden/git";
import { createMemoryQueue } from "@graph-warden/memory";
import { createNeo4jEventLog, createNeo4jIngestionState, createNeo4jStore, ensureConstraints } from "@graph-warden/neo4j";
import { createOpenApiExtractor } from "@graph-warden/openapi";
import { createRedisQueue } from "@graph-warden/redis";
import { createTypeScriptExtractor } from "@graph-warden/typescript";
import { Redis } from "ioredis";
import neo4j from "neo4j-driver";
import { loadConfig } from "./config.js";
import { buildTriggers, createPoller } from "./triggers.js";

const config = await loadConfig(process.env);
const driver = neo4j.driver(config.NEO4J_URI, neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD));
await ensureConstraints(driver);

const store = createNeo4jStore(driver);
const clones = new Map(config.repositories.map((repo) => [repo.name, { ...repo, git: createGitRepository(repo.dir) }]));
const ingester = createIngester({
  store,
  writer: createWriter(store, createNeo4jEventLog(driver), { ontology: config.ontology }),
  state: createNeo4jIngestionState(driver),
  repositories: new Map(
    [...clones.values()].map((repo) => [repo.name, { config: { name: repo.name, scope: repo.scope, author: repo.author }, repository: repo.git }]),
  ),
  extractors: [createDocumentExtractor({ ontology: config.ontology }), createTypeScriptExtractor(), createOpenApiExtractor()],
});

const redis = config.REDIS_URL === undefined ? undefined : new Redis(config.REDIS_URL);
const queue: IngestionQueue = redis === undefined ? createMemoryQueue() : createRedisQueue(redis);
const app = buildTriggers({
  queue,
  repositories: config.repositories,
  ...(config.GITHUB_WEBHOOK_SECRET === undefined ? {} : { webhookSecret: config.GITHUB_WEBHOOK_SECRET }),
  ...(config.GWARDEN_PUSH_TOKEN === undefined ? {} : { pushToken: config.GWARDEN_PUSH_TOKEN }),
  logger: true,
});
const log = app.log;

const worker = await queue.start(
  async (repo, sha) => {
    const clone = clones.get(repo);
    if (clone === undefined) throw new Error(`Unknown repository: ${repo}`);
    // A webhook may arrive before anyone fetched the commit.
    if (!(await clone.git.has(sha))) await clone.git.fetch();
    for (const commit of await ingester.ingest(repo, sha)) {
      log.info({ repo, sha: commit.sha, upserted: commit.upserted, deleted: commit.deleted }, "ingested");
    }
  },
  (error, repo, sha) => log.error({ err: error, repo, sha }, "ingestion failed, the job stays queued"),
);

const poll = createPoller(queue, [...clones.values()].map((repo) => ({ name: repo.name, branch: repo.branch, fetch: repo.git.fetch, head: repo.git.head })), (error, repo) =>
  log.error({ err: error, repo }, "polling failed"),
);
let timer: NodeJS.Timeout | undefined;
if (config.GWARDEN_POLL_SECONDS > 0) {
  const tick = () => void poll().finally(() => (timer = setTimeout(tick, config.GWARDEN_POLL_SECONDS * 1000)));
  tick();
}

const stop = async () => {
  clearTimeout(timer);
  await app.close();
  await worker.stop();
  redis?.disconnect();
  await driver.close();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

await app.listen({ port: config.PORT, host: config.HOST });
