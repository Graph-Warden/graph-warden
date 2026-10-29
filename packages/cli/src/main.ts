#!/usr/bin/env node
import { createGraph, createReader, deriveScopes, formatScope } from "@graph-warden/core";
import { readDocuments } from "@graph-warden/documents";
import { createNeo4jAuditLog, createNeo4jStore, ensureConstraints } from "@graph-warden/neo4j";
import neo4j from "neo4j-driver";
import { parseCommand, type Command } from "./args.js";

async function run(command: Command): Promise<void> {
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
        await store.upsertNodes(nodes);
        await store.upsertEdges(read.edges);
        console.log(`Ingested ${nodes.length} nodes and ${read.edges.length} edges from ${command.source}.`);
        for (const node of narrowed) console.log(`Narrowed ${node.id} to ${formatScope(node.scope)}, the readers of all its sources.`);
        break;
      }
      case "traverse": {
        // Reads go through the domain, which checks the principal's scopes on every hop and records
        // the read in the audit log before returning it.
        await ensureConstraints(driver);
        const reader = createReader(store, audit);
        const reached = await reader.traverse(command.principal, command.start, command.options);
        for (const node of reached) {
          console.log(`${node.type.padEnd(9)} ${node.id}  [${formatScope(node.scope)}]`);
        }
        console.log(`${reached.length} nodes reachable as ${command.principal.user}.`);
        break;
      }
      case "audit": {
        const entries = await audit.entries(command.user === undefined ? {} : { user: command.user });
        for (const entry of entries) {
          const { principal, options } = entry;
          const teams = principal.teams.length === 0 ? "" : ` (${principal.teams.join(", ")})`;
          const how = [
            options.direction ?? "out",
            ...(options.maxDepth === undefined ? [] : [`depth ${options.maxDepth}`]),
            ...(options.edgeTypes ?? []),
          ].join(" ");
          console.log(`${entry.at}  ${principal.user}${teams}  ${entry.action} ${entry.start} [${how}] -> ${entry.returned.length} nodes`);
        }
        console.log(`${entries.length} audit entries.`);
        break;
      }
    }
  } finally {
    await driver.close();
  }
}

try {
  await run(parseCommand(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
