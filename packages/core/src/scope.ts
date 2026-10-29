import { z } from "zod";

// Visibility scopes. A node belongs to exactly one scope; a reader sees a node only if one of
// their grants covers that scope. Teams are the groups the identity provider reports for the
// reader, nested groups included (proposal 0010): Graph-Warden keeps no hierarchy of its own.
//
// `teams` is the scope of a node derived from several teams' nodes: only someone in every one of
// them reads it. Its list is sorted, without duplicates and has at least two teams, so that one
// set of readers has one spelling; `teamsScope` builds it.

const TeamNameSchema = z.string().min(1);

export const ScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shared") }).readonly(),
  z.object({ kind: z.literal("team"), team: TeamNameSchema }).readonly(),
  z
    .object({
      kind: z.literal("teams"),
      teams: z
        .array(TeamNameSchema)
        .min(2)
        .refine((teams) => teams.every((team, i) => i === 0 || (teams[i - 1] ?? "") < team), {
          message: "teams must be sorted and distinct",
        })
        .readonly(),
    })
    .readonly(),
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
    case "teams":
      return scope.teams.every((team) => principal.teams.includes(team));
    case "private":
      return principal.user === scope.user;
  }
}

// The scope read by members of every given team: `team` for one, `teams` for several.
export function teamsScope(teams: readonly string[]): Scope {
  const names = [...new Set(teams)].sort();
  const [only] = names;
  if (only === undefined) throw new Error("A team scope needs at least one team");
  return names.length === 1 ? { kind: "team", team: only } : { kind: "teams", teams: names };
}

// The teams a scope requires a reader to be in.
export function requiredTeams(scope: Scope): readonly string[] {
  return scope.kind === "team" ? [scope.team] : scope.kind === "teams" ? scope.teams : [];
}

// `shared`, `team:<name>`, `teams:<a>,<b>…` or `private:<user>`.
export function parseScope(value: string): Scope {
  const at = value.indexOf(":");
  const kind = at < 0 ? value : value.slice(0, at);
  const owner = at < 0 ? "" : value.slice(at + 1);
  if (kind === "teams") return teamsScope(owner.split(",").map((team) => TeamNameSchema.parse(team.trim())));
  const scope = kind === "team" ? { kind, team: owner } : kind === "private" ? { kind, user: owner } : { kind };
  return ScopeSchema.parse(scope);
}

export function formatScope(scope: Scope): string {
  switch (scope.kind) {
    case "shared":
      return "shared";
    case "team":
      return `team:${scope.team}`;
    case "teams":
      return `teams:${scope.teams.join(",")}`;
    case "private":
      return `private:${scope.user}`;
  }
}
