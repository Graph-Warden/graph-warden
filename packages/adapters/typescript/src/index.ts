import { posix } from "node:path";
import type { Edge, Extractor, Snapshot } from "@graph-warden/core";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

// `Module -IMPORTS-> Module` (proposal 0005, issue #6), resolved by the TypeScript compiler as `tsc`
// resolves them: each file under the nearest tsconfig.json (its `extends`, `paths` and
// `moduleResolution`), workspace packages through their package.json. The repository is read at
// the commit, never from a checkout: there is no node_modules, so a workspace package
// (`@shop/api-client`, listed by pnpm-workspace.yaml or the `workspaces` field) is found in its
// directory, where pnpm or npm would have linked it. Packages from the registry are not in the
// repository and give no edge.
//
// Only the files a commit changed are read again. A change to a tsconfig, a package.json or the
// workspace list may change how any import resolves: then every module is.

const ROOT = "/repo/";
const SOURCE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const CONFIG = /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig\.json|package\.json|pnpm-workspace\.yaml)$/;

export const moduleId = (repo: string, path: string): string => `${repo}:${path}`;

// The node of a source file, the same whichever extractor reads the file.
export const moduleNode = (snapshot: Snapshot, path: string) =>
  ({ id: moduleId(snapshot.repo.name, path), type: "Module", scope: snapshot.repo.scope, title: path, path }) as const;

export interface TypeScriptOptions {
  // Files to read; all source files by default. Generated or vendored code may be left out.
  readonly include?: (path: string) => boolean;
}

export const isSource = (path: string) => SOURCE.test(path) && !DECLARATION.test(path) && !path.split("/").includes("node_modules");
const isConfig = (path: string) => CONFIG.test(path) && !path.split("/").includes("node_modules");

export function createTypeScriptExtractor(options: TypeScriptOptions = {}): Extractor {
  const { include = () => true } = options;
  const wanted = (path: string) => isSource(path) && include(path);
  return {
    edgeTypes: ["IMPORTS"],
    matches: (path) => wanted(path) || isConfig(path),
    async extract(files, snapshot) {
      const all = await snapshot.files();
      const resolver = await createResolver(all, snapshot);
      const changed = files.some((file) => isConfig(file.path)) ? all.filter(wanted) : files.map((file) => file.path).filter(wanted);
      const texts = new Map(files.map((file) => [file.path, file.text]));
      const present = new Set(all.filter(wanted));
      const repo = snapshot.repo.name;
      const edges: Edge[] = [];
      for (const path of changed) {
        const text = texts.get(path) ?? (await snapshot.read(path));
        for (const target of resolver.imports(path, text)) {
          if (target !== path && present.has(target)) edges.push({ type: "IMPORTS", from: moduleId(repo, path), to: moduleId(repo, target) });
        }
      }
      return {
        nodes: changed.map((path) => moduleNode(snapshot, path)),
        edges,
      };
    },
  };
}

// What `tsc` needs to resolve imports, read from the commit: the file list, and the text of every
// tsconfig and package.json (resolution is synchronous, so they are read first).
async function createResolver(all: readonly string[], snapshot: Snapshot) {
  const configs = new Map<string, string>();
  await Promise.all(all.filter(isConfig).map(async (path) => configs.set(path, await snapshot.read(path))));
  const workspaces = findWorkspaces(all, configs);

  const files = new Set(all);
  const directories = new Set<string>([""]);
  for (const path of all) for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) directories.add(dir);

  // From the compiler's absolute path to a path in the repository, through workspace links.
  const local = (absolute: string): string | undefined => {
    if (!absolute.startsWith(ROOT) && absolute !== ROOT.slice(0, -1)) return undefined;
    const path = absolute.slice(ROOT.length);
    const link = /^(?:.*\/)?node_modules\/((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(path);
    if (link === null) return path;
    const dir = workspaces.get(link[1] ?? "");
    return dir === undefined ? undefined : posix.join(dir, link[2] ?? "").replace(/\/$/, "");
  };
  const host: ts.ModuleResolutionHost & ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    fileExists: (absolute) => {
      const path = local(absolute);
      return path !== undefined && files.has(path);
    },
    directoryExists: (absolute) => {
      // node_modules and its scopes exist wherever a workspace package could be linked.
      const link = /(?:^|\/)node_modules(?:\/(@[^/]+))?$/.exec(absolute);
      if (link !== null) return link[1] === undefined ? workspaces.size > 0 : [...workspaces.keys()].some((name) => name.startsWith(`${link[1]}/`));
      const path = local(absolute);
      return path !== undefined && directories.has(path);
    },
    readFile: (absolute) => {
      const path = local(absolute);
      return path === undefined ? undefined : configs.get(path);
    },
    realpath: (absolute) => {
      const path = local(absolute);
      return path === undefined ? absolute : ROOT + path;
    },
    getCurrentDirectory: () => ROOT,
    // Only the compiler options of a tsconfig matter here, not the files it includes.
    readDirectory: () => [],
  };

  const options = new Map<string, ts.CompilerOptions>();
  const optionsFor = (path: string): ts.CompilerOptions => {
    const config = nearest(posix.dirname(path), (dir) => [posix.join(dir, "tsconfig.json"), posix.join(dir, "jsconfig.json")], (p) => configs.has(p));
    if (config === undefined) return { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true };
    let parsed = options.get(config);
    if (parsed === undefined) {
      const { config: json } = ts.readConfigFile(ROOT + config, host.readFile);
      parsed = { ...ts.parseJsonConfigFileContent(json ?? {}, host, ROOT + posix.dirname(config), undefined, ROOT + config).options, allowJs: true };
      options.set(config, parsed);
    }
    return parsed;
  };

  const cache = ts.createModuleResolutionCache(ROOT, (name) => name);
  return {
    imports(path: string, text: string): string[] {
      const compilerOptions = optionsFor(path);
      const targets: string[] = [];
      for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
        const resolved = ts.resolveModuleName(fileName, ROOT + path, compilerOptions, host, cache).resolvedModule;
        const target = resolved === undefined ? undefined : local(resolved.resolvedFileName);
        // Through a workspace link the target is the package's own file; from the registry, nothing.
        if (target !== undefined && !targets.includes(target)) targets.push(target);
      }
      return targets;
    },
  };
}

function nearest(dir: string, candidates: (dir: string) => string[], exists: (path: string) => boolean): string | undefined {
  for (let current = dir; ; current = posix.dirname(current)) {
    const found = candidates(current === "." ? "" : current).map((path) => path.replace(/^\//, "")).find(exists);
    if (found !== undefined) return found;
    if (current === "." || current === "" || current === "/") return undefined;
  }
}

// Workspace packages by name: the directories listed by pnpm-workspace.yaml or the root
// package.json's `workspaces`, as globs of the form `dir/*` or `dir`.
function findWorkspaces(all: readonly string[], configs: ReadonlyMap<string, string>): Map<string, string> {
  const patterns: string[] = [];
  const pnpm = configs.get("pnpm-workspace.yaml");
  if (pnpm !== undefined) patterns.push(...asStrings((parseYaml(pnpm) as { packages?: unknown } | null)?.packages));
  const root = parseJson(configs.get("package.json"));
  const declared = root?.workspaces;
  patterns.push(...asStrings(Array.isArray(declared) ? declared : (declared as { packages?: unknown } | undefined)?.packages));

  const matchers = patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .map((pattern) => new RegExp(`^${pattern.replace(/\/+$/, "").split("/").map((part) => (part === "**" ? ".*" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))).join("/")}$`));
  const workspaces = new Map<string, string>();
  for (const path of all) {
    if (!path.endsWith("/package.json")) continue;
    const dir = posix.dirname(path);
    if (!matchers.some((matcher) => matcher.test(dir))) continue;
    const name = parseJson(configs.get(path))?.name;
    if (typeof name === "string") workspaces.set(name, dir);
  }
  return workspaces;
}

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
