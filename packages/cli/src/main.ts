#!/usr/bin/env node
import {
  createGraph,
  createReader,
  createWriter,
  deriveScopes,
  formatScope,
  AuditEntrySchema,
  NodeSchema,
  PullResponseSchema,
  type AuditEntry,
  type Node,
} from "@graph-warden/core";
import { readDocuments } from "@graph-warden/documents";
import { createNeo4jAuditLog, createNeo4jEventLog, createNeo4jStore, ensureConstraints } from "@graph-warden/neo4j";
import neo4j from "neo4j-driver";
import { z } from "zod";
import { parseCommand, type Command, type Remote } from "./args.js";

async function run(command: Command): Promise<void> {
  if (command.name === "pull") return pull(command);
  if (command.name === "cache") return listCache(command.cache);
  if (command.name === "traverse" && command.through.kind === "api") return traverseRemote(command, command.through);
  if (command.name === "audit" && command.through.kind === "api") return auditRemote(command, command.through);
  const driver = neo4j.driver(
    process.env.NEO4J_URI ?? "bolt://localhost:7687",
    neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", process.env.NEO4J_PASSWORD ?? "graph-warden"),
  );
  try {
    const store = createNeo4jStore(driver);
    const audit = createNeo4jAuditLog(driver);
    switch (command.name) {
      case "ingest": {
        await ensureConstraints(driver);
        const read = await readDocuments(command.dir, command);
        // A document derived from others is never readable by someone who cannot read its sources.
        const ids = read.nodes.map((node) => node.id);
        const nodes = deriveScopes(createGraph(read.nodes, read.edges), command.author, ids);
        const narrowed = nodes.filter((node, i) => formatScope(node.scope) !== formatScope(read.nodes[i]?.scope ?? node.scope));
        // Through the writer, so that every change lands in the event log that pulls read.
        const writer = createWriter(store, createNeo4jEventLog(driver));
        await writer.upsertNodes(nodes);
        await writer.upsertEdges(read.edges);
        console.log(`Ingested ${nodes.length} nodes and ${read.edges.length} edges from ${command.source}.`);
        for (const node of narrowed) console.log(`Narrowed ${node.id} to ${formatScope(node.scope)}, the readers of all its sources.`);
        break;
      }
      case "traverse": {
        // Reads go through the domain, which checks the principal's scopes on every hop and records
        // the read in the audit log before returning it.
        if (command.principal === undefined) throw new Error("--user is required without --api");
        await ensureConstraints(driver);
        const reader = createReader(store, audit);
        printNodes(await reader.traverse(command.principal, command.start, command.options), command.principal.user);
        break;
      }
      case "audit": {
        printAudit(await audit.entries(command.user === undefined ? {} : { user: command.user }));
        break;
      }
    }
  } finally {
    await driver.close();
  }
}

function printNodes(nodes: readonly Node[], user: string): void {
  for (const node of nodes) console.log(`${node.type.padEnd(9)} ${node.id}  [${formatScope(node.scope)}]`);
  console.log(`${nodes.length} nodes reachable as ${user}.`);
}

function printAudit(entries: readonly AuditEntry[]): void {
  for (const entry of entries) {
    const { principal } = entry;
    const teams = principal.teams.length === 0 ? "" : ` (${principal.teams.join(", ")})`;
    console.log(`${entry.at}  ${principal.user}${teams}  ${describe(entry)}`);
  }
  console.log(`${entries.length} audit entries.`);
}

async function traverseRemote(command: Extract<Command, { name: "traverse" }>, remote: Remote): Promise<void> {
  const { direction = "out", maxDepth, edgeTypes = [] } = command.options;
  const query = new URLSearchParams({ direction });
  if (maxDepth !== undefined) query.set("depth", String(maxDepth));
  for (const edge of edgeTypes) query.append("edge", edge);
  const { user } = MeSchema.parse(await fetchJson(remote, "/v1/me"));
  const { nodes } = z.object({ nodes: z.array(NodeSchema) }).parse(
    await fetchJson(remote, `/v1/nodes/${encodeURIComponent(command.start)}/neighbours?${query}`),
  );
  printNodes(nodes, user);
}

async function auditRemote(command: Extract<Command, { name: "audit" }>, remote: Remote): Promise<void> {
  const query = command.user === undefined ? "" : `?user=${encodeURIComponent(command.user)}`;
  printAudit(z.object({ entries: z.array(AuditEntrySchema) }).parse(await fetchJson(remote, `/v1/audit${query}`)).entries);
}

const MeSchema = PullResponseSchema.unwrap().shape.principal;

function describe(entry: AuditEntry): string {
  switch (entry.action) {
    case "traverse": {
      const { options } = entry;
      const how = [
        options.direction ?? "out",
        ...(options.maxDepth === undefined ? [] : [`depth ${options.maxDepth}`]),
        ...(options.edgeTypes ?? []),
      ].join(" ");
      return `traverse ${entry.start} [${how}] -> ${entry.returned.length} nodes`;
    }
    case "pull":
      return `pull after ${entry.after} -> ${entry.returned.length} nodes`;
    case "audit":
      return `audit${entry.user === undefined ? "" : ` of ${entry.user}`}${entry.denied === true ? " DENIED" : ""}`;
  }
}

// node:sqlite is loaded only by the commands that use the cache: it prints an experimental warning.
const openCache = async (path: string) => (await import("./cache.js")).openCache(path);

async function pull(command: Extract<Command, { name: "pull" }>): Promise<void> {
  const cache = await openCache(command.cache);
  try {
    let after = cache.cursor(command.api);
    let { principal, delta } = PullResponseSchema.parse(await fetchJson(command, `/v1/pull?after=${after}`));
    if (after > 0 && !cache.ownedBy(command.api, principal)) {
      // Another user, or the same one with other groups: start over.
      after = 0;
      ({ principal, delta } = PullResponseSchema.parse(await fetchJson(command, "/v1/pull?after=0")));
    }
    // A pull from scratch replaces whatever the cache held, another API's data included.
    if (after === 0) cache.clear();
    cache.apply(command.api, principal, delta);
    console.log(
      `Pulled as ${principal.user}${after === 0 ? " from scratch" : ` since ${after}`}: ` +
        `${delta.nodes.length} nodes, ${delta.edges.length} edges, ${delta.removed.length} removed. ` +
        `Cache: ${cache.nodes().length} nodes, ${cache.edgeCount()} edges, cursor ${delta.cursor}.`,
    );
  } finally {
    cache.close();
  }
}

async function fetchJson(command: Remote, path: string): Promise<unknown> {
  const response = await fetch(`${command.api}${path}`, { headers: { authorization: `Bearer ${command.token}` } });
  if (!response.ok) throw new Error(`${command.api}${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function listCache(path: string): Promise<void> {
  const cache = await openCache(path);
  try {
    for (const node of cache.nodes()) console.log(`${node.type.padEnd(9)} ${node.id}  [${formatScope(node.scope)}]`);
    console.log(`${cache.nodes().length} nodes, ${cache.edgeCount()} edges in ${path}.`);
  } finally {
    cache.close();
  }
}

try {
  await run(parseCommand(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
