import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileChange, Repository } from "@graph-warden/core";

// `Repository` on a local clone, through the git command line: the clone is the worker's, kept up
// to date by whoever fetches (polling, a webhook handler). Shas and paths are passed as arguments,
// never through a shell.

const run = promisify(execFile);

export interface GitOptions {
  readonly git?: string;
}

export interface GitRepository extends Repository {
  // Whether the clone has this commit; a job may name one it has not fetched yet.
  has(sha: string): Promise<boolean>;
  fetch(): Promise<void>;
  // The commit a ref points to: `origin/main`.
  head(ref: string): Promise<string>;
}

export function createGitRepository(dir: string, options: GitOptions = {}): GitRepository {
  const { git: bin = "git" } = options;
  const git = async (...args: string[]) =>
    (await run(bin, ["-C", dir, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" })).stdout;
  const sha = (value: string) => {
    if (!/^[0-9a-f]{7,64}$/.test(value)) throw new Error(`Not a commit sha: ${value}`);
    return value;
  };
  return {
    async contains(ancestor, descendant) {
      try {
        await git("merge-base", "--is-ancestor", sha(ancestor), sha(descendant));
        return true;
      } catch (error) {
        // Exit 1: not an ancestor. Anything else (unknown commit) is an error.
        if ((error as { code?: unknown }).code === 1) return false;
        throw error;
      }
    },
    async commits(from, to) {
      const out = await git("rev-list", "--first-parent", "--reverse", `${sha(from)}..${sha(to)}`);
      return out.split("\n").filter((line) => line !== "");
    },
    async changes(from, to) {
      if (from === undefined) {
        const out = await git("ls-tree", "-r", "-z", "--name-only", sha(to));
        return out.split("\0").filter((path) => path !== "").map((path): FileChange => ({ status: "upserted", path }));
      }
      // -z: paths verbatim, whatever characters they hold. Renames as a deletion and an addition.
      const fields = (await git("diff", "--name-status", "--no-renames", "-z", sha(from), sha(to))).split("\0");
      const changes: FileChange[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const status = fields[i] ?? "";
        const path = fields[i + 1] ?? "";
        changes.push({ status: status === "D" ? "deleted" : "upserted", path });
      }
      return changes;
    },
    read: (commit, path) => git("show", `${sha(commit)}:${path}`),
    message: (commit) => git("log", "-1", "--format=%B", sha(commit)),
    async has(commit) {
      try {
        await git("cat-file", "-e", `${sha(commit)}^{commit}`);
        return true;
      } catch {
        return false;
      }
    },
    async fetch() {
      await git("fetch", "--quiet", "origin");
    },
    async head(ref) {
      return (await git("rev-parse", "--verify", `${ref}^{commit}`)).trim();
    },
  };
}
