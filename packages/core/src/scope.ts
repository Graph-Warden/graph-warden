import { z } from "zod";

// Visibility scopes. A node belongs to exactly one scope; a reader sees a node only if one of
// their grants covers that scope. Traversal rules land in M0-3.

export const ScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shared") }).readonly(),
  z.object({ kind: z.literal("team"), team: z.string().min(1) }).readonly(),
  z.object({ kind: z.literal("private"), user: z.string().min(1) }).readonly(),
]);

export type Scope = z.infer<typeof ScopeSchema>;

export interface Principal {
  readonly user: string;
  readonly teams: readonly string[];
}

export function canRead(principal: Principal, scope: Scope): boolean {
  switch (scope.kind) {
    case "shared":
      return true;
    case "team":
      return principal.teams.includes(scope.team);
    case "private":
      return principal.user === scope.user;
  }
}
