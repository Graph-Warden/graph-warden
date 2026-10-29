# 0010 — Rights come from the identity provider; derived nodes require every source team

Stage: to be reviewed

## Context
Proposal 0002 gives every node one scope and says a derived node takes "the most restrictive scope of its sources". With teams alone that rule has no answer for a summary built from a `team:bff` page and a `team:front` page: neither scope is narrower than the other.

Companies already manage who belongs where, and who oversees whom, in their directory: LDAP or Active Directory, Entra ID, Google Cloud Identity. A second copy of that in Graph-Warden would drift, and a security review would ask why it exists.

## Decision
- **Graph-Warden keeps no hierarchy and no roles.** A principal's teams are the groups the identity provider reports for them, nested groups resolved (LDAP `memberOf` with `LDAP_MATCHING_RULE_IN_CHAIN`, Cloud Identity transitive memberships, an OIDC `groups` claim). Oversight is set up there: adding the `dev-leads` group to the `bff` and `front` groups lets leads read both.
- **A new scope, `teams:<a>,<b>…`**, is read by someone in every listed team. Its list is sorted, without duplicates and has at least two teams, so one set of readers has one spelling.
- **A derived node's scope** (`DERIVED_FROM`) is computed from its sources on behalf of the author, the principal it is derived for:
  - `shared` adds no restriction;
  - teams add up: a `bff` page and a `front` page give `teams:bff,front`;
  - anything private gives `private:<author>`;
  - the node's own declared scope counts as one more source, so derivation never widens it.
- **Nobody derives from what they cannot read**: the author must read every source, or the derivation is refused. A declared scope private to someone other than the author is refused too.
- Chains of derivation are followed; a cycle of `DERIVED_FROM` is refused.

## Consequences
- The scope is exact: its readers are exactly the people who read every source team. Who they are is the directory's business; with leads in every team group, a cross-team summary is read by the leads and not by either team alone.
- Widening a derived node (publishing a summary to a whole team) is a deliberate promotion by someone who reads every source, recorded in the audit log (issue #27), not a side effect of ingestion.
- A node private to its author keeps what the author read even after they leave a group, as any copy they made would.
- Scopes are derived at ingestion. When a source's scope or someone's groups change later, derived nodes must be revalidated; that belongs with `findRelated` (proposal 0005).
- Until the API reads identities from a provider (issue #11, behind an `IdentityProvider` port), the CLI takes the groups as `--team` flags.
