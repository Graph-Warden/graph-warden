#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  createGraph,
  createOrganisation,
  createReader,
  deriveScopes,
  resolvePrincipal,
  type Organisation,
} from "@graph-warden/core";
import { readDocuments } from "@graph-warden/documents";
import { createNeo4jAuditLog, createNeo4jStore, ensureConstraints } from "@graph-warden/neo4j";
import neo4j from "neo4j-driver";
import { parse as parseYaml } from "yaml";
import { parseCommand, type Command } from "./args.js";

// The organisation chart from a YAML file mapping each team to its parent; without one, teams are flat.
async function loadOrganisation(path: string | undefined): Promise<Organisation> {
  if (path === undefined) return createOrganisation();
  try {
    return createOrganisation((parseYaml(await readFile(path, "utf8")) as Record<string, string | null> | null) ?? {});
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
        const org = await loadOrganisation(command.org);
        const author = resolvePrincipal(org, command.user, command.teams);
        const read = await readDocuments(command.dir, command);
        // A document derived from others never stays wider than its sources.
        const nodes = deriveScopes(createGraph(read.nodes, read.edges), org, author, read.nodes.map((node) => node.id));
        const narrowed = nodes.filter((node, i) => JSON.stringify(node.scope) !== JSON.stringify(read.nodes[i]?.scope));
        await store.upsertNodes(nodes);
        await store.upsertEdges(read.edges);
        console.log(`Ingested ${nodes.length} nodes and ${read.edges.length} edges from ${command.source}.`);
        if (narrowed.length > 0) console.log(`Narrowed to their sources' scope: ${narrowed.map((node) => node.id).join(", ")}.`);
        break;
      }
      case "traverse": {
        // Reads go through the domain, which checks the principal's scopes on every hop and records
        // the read in the audit log before returning it.
        await ensureConstraints(driver);
        const reader = createReader(store, audit);
        const principal = resolvePrincipal(await loadOrganisation(command.org), command.user, command.teams);
        const reached = await reader.traverse(principal, command.start, command.options);
        for (const node of reached) {
          const { scope } = node;
          const owner = scope.kind === "team" ? `:${scope.team}` : scope.kind === "private" ? `:${scope.user}` : "";
          console.log(`${node.type.padEnd(9)} ${node.id}  [${scope.kind}${owner}]`);
        }
        console.log(`${reached.length} nodes reachable as ${principal.user}.`);
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
