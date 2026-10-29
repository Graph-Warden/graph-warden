// Visibility scopes. A node belongs to exactly one scope; a reader sees a node only if one of
// their grants covers that scope. The ontology and the traversal rules land in M0-2 and M0-3.

export type Scope =
  | { readonly kind: "shared" }
  | { readonly kind: "team"; readonly team: string }
  | { readonly kind: "private"; readonly user: string };

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
