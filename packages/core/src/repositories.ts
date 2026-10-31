import { z } from "zod";
import { parseScope, type Principal, type Scope } from "./scope.js";

// The repositories a deployment ingests, as the YAML file GWARDEN_REPOSITORIES names. The worker
// ingests them; the API reads their past (issue #16).
//
// - name: github:acme/shop        provenance source of its nodes; matches GitHub webhooks of acme/shop
//   dir: /var/lib/gwarden/shop    a clone whose `origin` is the repository
//   branch: main                  the branch ingested (main by default)
//   scope: team:bff               scope of documents without a scope: field, and of Change nodes
//   author: { user: ingestion, teams: [bff, front-a] }   who derived documents are derived for
export const RepositoriesSchema = z
  .array(
    z
      .object({
        name: z.string().min(1),
        dir: z.string().min(1),
        branch: z.string().min(1).default("main"),
        scope: z.string().transform((value, context): Scope => {
          try {
            return parseScope(value);
          } catch (error) {
            context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
            return z.NEVER;
          }
        }),
        author: z.object({ user: z.string().min(1), teams: z.array(z.string().min(1)).default([]) }),
      })
      .strict(),
  )
  .superRefine((repositories, context) => {
    const names = repositories.map((repo) => repo.name);
    const twice = names.find((name, i) => names.indexOf(name) !== i);
    if (twice !== undefined) context.addIssue({ code: "custom", message: `${twice} is listed twice` });
  });

export interface RepositoryEntry {
  readonly name: string;
  readonly dir: string;
  readonly branch: string;
  readonly scope: Scope;
  readonly author: Principal;
}
