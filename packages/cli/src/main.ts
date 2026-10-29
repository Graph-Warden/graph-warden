#!/usr/bin/env node
import { traverse } from "@graph-warden/core";
import { readDocuments } from "@graph-warden/documents";
import { createNeo4jStore, ensureConstraints } from "@graph-warden/neo4j";
import neo4j from "neo4j-driver";
import { parseCommand, type Command } from "./args.js";

async function run(command: Command): Promise<void> {
  const driver = neo4j.driver(
    process.env.NEO4J_URI ?? "bolt://localhost:7687",
    neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", process.env.NEO4J_PASSWORD ?? "graph-warden"),
  );
  try {
    const store = createNeo4jStore(driver);
    switch (command.name) {
      case "ingest": {
        await ensureConstraints(driver);
        const { nodes, edges } = await readDocuments(command.dir, command);
        await store.upsertNodes(nodes);
        await store.upsertEdges(edges);
        console.log(`Ingested ${nodes.length} nodes and ${edges.length} edges from ${command.source}.`);
        break;
      }
      case "traverse": {
        // Reads go through the domain, which checks the principal's scopes on every hop.
        const reached = traverse(await store.snapshot(), command.principal, command.start, command.options);
        for (const node of reached) {
          const { scope } = node;
          const owner = scope.kind === "team" ? `:${scope.team}` : scope.kind === "private" ? `:${scope.user}` : "";
          console.log(`${node.type.padEnd(9)} ${node.id}  [${scope.kind}${owner}]`);
        }
        console.log(`${reached.length} nodes reachable as ${command.principal.user}.`);
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
