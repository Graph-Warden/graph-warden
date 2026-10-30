#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import {
  createGraph,
  createReader,
  checkOntology,
  CORE_ONTOLOGY,
  createWriter,
  deriveScopes,
  formatScope,
  AuditEntrySchema,
  EdgeSchema,
  NodeSchema,
  PullResponseSchema,
  type AuditEntry,
  type Node,
} from "@graph-warden/core";
import { readDocuments, readOntology } from "@graph-warden/documents";
import { createNeo4jAuditLog, createNeo4jEventLog, createNeo4jStore, ensureConstraints } from "@graph-warden/neo4j";
import neo4j from "neo4j-driver";
import { z } from "zod";
import { parseCommand, type Command, type Remote } from "./args.js";

async function run(command: Command): Promise<void> {
  if (command.name === "pull") return pull(command);
  if (command.name === "cache") return listCache(command.cache);
  if (command.name === "ask") return ask(command);
  if (command.name === "show") return show(command);
  if (command.name === "search") return search(command);
  if (command.name === "delete") return deleteNode(command);
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
        // The organisation's types, if it declared any (GWARDEN_ONTOLOGY, the same file as the API's).
        const ontology = process.env.GWARDEN_ONTOLOGY ? await readOntology(process.env.GWARDEN_ONTOLOGY) : CORE_ONTOLOGY;
        const read = await readDocuments(command.dir, { ...command, ontology });
        // A document derived from others is never readable by someone who cannot read its sources.
        const ids = read.nodes.map((node) => node.id);
        const nodes = deriveScopes(createGraph(read.nodes, read.edges), command.author, ids);
        const narrowed = nodes.filter((node, i) => formatScope(node.scope) !== formatScope(read.nodes[i]?.scope ?? node.scope));
        // Through the writer, so that every change lands in the event log that pulls read.
        const writer = createWriter(store, createNeo4jEventLog(driver), { ontology });
        // Checked before writing anything, so that an unknown edge type leaves no half ingestion.
        checkOntology(ontology, nodes, read.edges);
        await writer.upsertNodes(nodes);
        await writer.upsertEdges(read.edges);
        console.log(`Ingested ${count(nodes.length, "node")} and ${count(read.edges.length, "edge")} from ${command.source}.`);
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

const line = (node: Node) =>
  `${node.type.padEnd(9)} ${node.id}${node.title === undefined ? "" : `  "${node.title}"`}  [${formatScope(node.scope)}]`;
const named = (node: Node) => (node.title === undefined ? node.id : `"${node.title}" (${node.id})`);

function printNodes(nodes: readonly Node[], user: string): void {
  for (const node of nodes) console.log(line(node));
  console.log(`${count(nodes.length, "node")} reachable as ${user}.`);
}

function printAudit(entries: readonly AuditEntry[]): void {
  for (const entry of entries) {
    const { principal } = entry;
    const teams = principal.teams.length === 0 ? "" : ` (${principal.teams.join(", ")})`;
    console.log(`${entry.at}  ${principal.user}${teams}  ${describe(entry)}`);
  }
  console.log(`${count(entries.length, "audit entry", "audit entries")}.`);
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

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

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
      return `traverse ${entry.start} [${how}] -> ${count(entry.returned.length, "node")}`;
    }
    case "pull":
      return `pull after ${entry.after} -> ${count(entry.returned.length, "node")}`;
    case "audit":
      return `audit${entry.user === undefined ? "" : ` of ${entry.user}`}${entry.denied === true ? " DENIED" : ""}`;
    case "delete": {
      const what = entry.planned === true ? "delete preview" : "delete";
      if (entry.denied === true) return `${what} ${entry.target} DENIED`;
      return `${what} ${entry.target} -> ${count(entry.returned.length, "node")}, ${count(entry.detached.length, "edge")} detached`;
    }
    case "read":
      return `read ${entry.target}${entry.returned.length === 0 ? " -> nothing" : ""}`;
    case "search":
      return `search "${entry.query}" -> ${count(entry.returned.length, "node")}`;
    case "ask": {
      if (entry.denied === true) return `ask "${entry.question}" DENIED`;
      return `ask "${entry.question}" -> ${count(entry.returned.length, "node")} read${entry.saved === undefined ? "" : `, filed as ${entry.saved}`}`;
    }
    case "edit":
      return `edit ${entry.target}${entry.denied === true ? " DENIED" : entry.created === true ? " (new page)" : ""}`;
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
        `${count(delta.nodes.length, "node")}, ${count(delta.edges.length, "edge")}, ${delta.removed.length} removed. ` +
        `Cache: ${count(cache.nodes().length, "node")}, ${count(cache.edgeCount(), "edge")}, cursor ${delta.cursor}.`,
    );
  } finally {
    cache.close();
  }
}

async function fetchJson(command: Remote, path: string, init: { method?: string; body?: object } = {}): Promise<unknown> {
  const response = await fetch(`${command.api}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${command.token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) throw new Error(`${command.api}${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function show(command: Extract<Command, { name: "show" }>): Promise<void> {
  const node = NodeSchema.parse(await fetchJson(command, `/v1/nodes/${encodeURIComponent(command.id)}`));
  console.log(line(node));
  console.log(`from ${node.provenance.source} ${node.provenance.path}${node.provenance.sha === undefined ? "" : ` @ ${node.provenance.sha}`}`);
  if (node.body !== undefined) console.log(`\n${node.body}`);
}

async function search(command: Extract<Command, { name: "search" }>): Promise<void> {
  const query = new URLSearchParams({ q: command.query, ...(command.limit === undefined ? {} : { limit: String(command.limit) }) });
  const { nodes } = z.object({ nodes: z.array(NodeSchema) }).parse(await fetchJson(command, `/v1/search?${query}`));
  for (const node of nodes) console.log(line(node));
  console.log(`${count(nodes.length, "node")} found.`);
}

const AnswerSchema = z.object({ answer: z.string(), sources: z.array(NodeSchema), saved: NodeSchema.optional() });

async function ask(command: Extract<Command, { name: "ask" }>): Promise<void> {
  const { answer, sources, saved } = AnswerSchema.parse(
    await fetchJson(command, "/v1/ask", {
      method: "POST",
      body: {
        question: command.question,
        save: command.save,
        ...(command.from === undefined ? {} : { from: command.from }),
        ...(command.scope === undefined ? {} : { scope: command.scope }),
      },
    }),
  );
  console.log(answer);
  if (sources.length > 0) {
    console.log(`\nRead ${count(sources.length, "node")}:`);
    for (const node of sources) console.log(`  ${line(node)}`);
  }
  if (saved !== undefined) console.log(`\nFiled as ${saved.id}  [${formatScope(saved.scope)}]`);
}

const PlanSchema = z.object({ target: z.string(), deleted: z.array(NodeSchema), detached: z.array(EdgeSchema), digest: z.string() });

// Deletion is shown, then confirmed by typing the node id, then made with the digest of what was
// shown: if the graph changed in between, the API refuses and nothing is deleted.
async function deleteNode(command: Extract<Command, { name: "delete" }>): Promise<void> {
  const path = `/v1/nodes/${encodeURIComponent(command.id)}`;
  const plan = PlanSchema.parse(await fetchJson(command, `${path}/deletion`));
  const target = plan.deleted.find((node) => node.id === plan.target);
  const name = target === undefined ? plan.target : named(target);
  console.log(`Deleting ${name} removes:`);
  for (const node of plan.deleted) console.log(`  ${line(node)}${node.id === plan.target ? "" : "  derived only from deleted nodes"}`);
  if (plan.detached.length > 0) {
    console.log("and detaches, keeping these nodes, their other sources and their scope:");
    for (const edge of plan.detached) console.log(`  ${edge.from} -${edge.type}-> ${edge.to}`);
  }
  console.log(`\nAre you sure? It will delete ${count(plan.deleted.length, "entry", "entries")} from ${name}.`);

  let typed = command.confirm;
  if (typed === undefined) {
    if (!process.stdin.isTTY) throw new Error("delete asks for confirmation on a terminal; in a script, pass --confirm <node-id>");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      typed = (await prompt.question(`Type ${plan.target} to confirm: `)).trim();
    } finally {
      prompt.close();
    }
  }
  if (typed !== plan.target) throw new Error(`Not deleted: "${typed}" is not ${plan.target}.`);

  const done = PlanSchema.parse(await fetchJson(command, `${path}?confirm=${encodeURIComponent(plan.digest)}`, { method: "DELETE" }));
  console.log(`Deleted ${count(done.deleted.length, "node")} and detached ${count(done.detached.length, "edge")}.`);
}

async function listCache(path: string): Promise<void> {
  const cache = await openCache(path);
  try {
    for (const node of cache.nodes()) console.log(line(node));
    console.log(`${count(cache.nodes().length, "node")}, ${count(cache.edgeCount(), "edge")} in ${path}.`);
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
