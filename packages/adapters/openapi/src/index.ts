import { posix } from "node:path";
import type { Edge, Extractor } from "@graph-warden/core";
import { isSource, moduleId, moduleNode } from "@graph-warden/typescript";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

// HTTP dependencies, which imports cannot see (proposal 0005, issue #7):
// - an `Endpoint` node per operation of an OpenAPI spec, id `<repo>:GET /orders/{id}`;
// - `Module -EXPOSES-> Endpoint` for a module next to the spec (under the spec's directory) that
//   exports a function named after the operation's `operationId`, the handler;
// - `Module -CONSUMES-> Endpoint` for a module elsewhere that calls the operation, either through a
//   generated client, by importing a function named after its `operationId` from a package or
//   alias (clients generated from a spec name their functions so), or with `fetch` on a URL
//   written in the code, whose path matches the operation's (`${BFF}/orders/${id}` matches
//   `/orders/{id}`), with the method of its `method:` option, GET by default.
// The client's own files are generated from the spec and consume nothing themselves: the modules
// that import them do. A change to a spec changes what every module exposes and consumes, so then
// every module is read again.

const SPEC = /(?:^|\/)(?:openapi|swagger)(?:\.[^/]+)?\.(?:ya?ml|json)$/;
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export const endpointId = (repo: string, method: string, path: string): string => `${repo}:${method.toUpperCase()} ${path}`;

export interface OpenApiOptions {
  readonly include?: (path: string) => boolean;
}

interface Operation {
  readonly spec: string;
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
  readonly summary?: string;
  readonly pattern: RegExp;
}

export function createOpenApiExtractor(options: OpenApiOptions = {}): Extractor {
  const { include = () => true } = options;
  const wanted = (path: string) => isSource(path) && include(path);
  return {
    edgeTypes: ["EXPOSES", "CONSUMES"],
    matches: (path) => SPEC.test(path) || wanted(path),
    async extract(files, snapshot) {
      const all = await snapshot.files();
      const texts = new Map(files.map((file) => [file.path, file.text]));
      const read = async (path: string) => texts.get(path) ?? (await snapshot.read(path));
      const specs = all.filter((path) => SPEC.test(path));
      const operations = (await Promise.all(specs.map(async (spec) => readSpec(spec, await read(spec))))).flat();
      const repo = snapshot.repo.name;

      const sources = files.some((file) => SPEC.test(file.path)) ? all.filter(wanted) : files.map((file) => file.path).filter(wanted);
      const edges: Edge[] = [];
      for (const path of sources) {
        const facts = analyse(path, await read(path));
        const from = moduleId(repo, path);
        for (const operation of operations) {
          const to = endpointId(repo, operation.method, operation.path);
          const home = posix.dirname(operation.spec);
          const inside = home === "." || path.startsWith(`${home}/`);
          if (inside) {
            if (operation.operationId !== undefined && facts.exports.has(operation.operationId)) edges.push({ type: "EXPOSES", from, to });
            continue;
          }
          const imported = operation.operationId !== undefined && facts.imports.has(operation.operationId);
          const fetched = facts.calls.some((call) => call.method === operation.method && operation.pattern.test(call.path));
          if (imported || fetched) edges.push({ type: "CONSUMES", from, to });
        }
      }
      const changedSpecs = files.map((file) => file.path).filter((path) => SPEC.test(path));
      return {
        nodes: [
          ...operations
            .filter((operation) => changedSpecs.includes(operation.spec))
            .map((operation) => ({
              id: endpointId(repo, operation.method, operation.path),
              type: "Endpoint",
              scope: snapshot.repo.scope,
              title: `${operation.method.toUpperCase()} ${operation.path}`,
              ...(operation.summary === undefined ? {} : { body: operation.summary }),
              path: operation.spec,
            })),
          ...sources.map((path) => moduleNode(snapshot, path)),
        ],
        edges,
      };
    },
  };
}

function readSpec(spec: string, text: string): Operation[] {
  let document: unknown;
  try {
    document = spec.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new Error(`${spec}: invalid OpenAPI document: ${error instanceof Error ? error.message : String(error)}`);
  }
  const paths = (document as { paths?: unknown } | null)?.paths;
  if (paths === null || typeof paths !== "object") return [];
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
    if (item === null || typeof item !== "object") continue;
    for (const method of METHODS) {
      const operation = (item as Record<string, unknown>)[method] as { operationId?: unknown; summary?: unknown } | undefined;
      if (operation === undefined || operation === null || typeof operation !== "object") continue;
      operations.push({
        spec,
        method,
        path,
        ...(typeof operation.operationId === "string" ? { operationId: operation.operationId } : {}),
        ...(typeof operation.summary === "string" ? { summary: operation.summary } : {}),
        pattern: new RegExp(`^${path.split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("[^/]+")}/?$`),
      });
    }
  }
  return operations;
}

interface Facts {
  // Names imported from packages or aliases, by their exported name.
  readonly imports: ReadonlySet<string>;
  readonly exports: ReadonlySet<string>;
  readonly calls: readonly { readonly method: string; readonly path: string }[];
}

// A placeholder for whatever an expression in a URL holds; never part of a real path.
const HOLE = "\u0000";

function analyse(path: string, text: string): Facts {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>();
  const exports = new Set<string>();
  const calls: { method: string; path: string }[] = [];
  const exported = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.moduleSpecifier.text.startsWith(".")) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) imports.add((element.propertyName ?? element.name).text);
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && exported(node) && node.name !== undefined) exports.add(node.name.text);
    if (ts.isVariableStatement(node) && exported(node)) {
      for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) exports.add(declaration.name.text);
    }
    if (ts.isExportDeclaration(node) && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) exports.add(element.name.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
      const url = node.arguments[0] === undefined ? undefined : literal(node.arguments[0]);
      const path = url === undefined ? undefined : urlPath(url);
      if (path !== undefined) calls.push({ method: method(node.arguments[1]), path });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { imports, exports, calls };
}

// A string or template literal, its expressions replaced by HOLE.
function literal(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => HOLE + span.literal.text).join("");
  return undefined;
}

// The path of a URL: after the origin of an absolute URL, after a leading expression (a base URL in
// a constant), without query or fragment. Expressions within the path stand for one segment.
function urlPath(url: string): string | undefined {
  let rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  if (rest.startsWith(HOLE)) rest = rest.slice(1);
  rest = rest.split(/[?#]/)[0] ?? "";
  if (!rest.startsWith("/") || rest.includes(`${HOLE}${HOLE}`)) return undefined;
  // A hole inside a segment stands for the whole segment.
  return rest.split("/").map((segment) => (segment.includes(HOLE) ? "x" : segment)).join("/");
}

function method(init: ts.Expression | undefined): string {
  if (init === undefined || !ts.isObjectLiteralExpression(init)) return "get";
  for (const property of init.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "method") {
      const value = literal(property.initializer);
      if (value !== undefined && !value.includes(HOLE)) return value.toLowerCase();
    }
  }
  return "get";
}
