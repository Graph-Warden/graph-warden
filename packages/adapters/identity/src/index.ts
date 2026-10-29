import { Unauthenticated, type IdentityProvider, type Principal } from "@graph-warden/core";
import { GoogleAuth } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

// Identity providers (proposal 0010). Each turns a bearer token into a principal whose teams are the
// groups the provider reports, nested groups resolved. None keeps users or groups of its own.

// The groups a user belongs to, directly or through nested groups.
export type GroupLookup = (user: string) => Promise<readonly string[]>;

export interface OidcOptions {
  // One issuer, or the spellings an issuer uses (Google signs with both).
  readonly issuer: string | readonly string[];
  // This service's client id: a token issued for another application is refused.
  readonly audience: string;
  // Defaults to the issuer's published keys, found once through its discovery document.
  readonly keys?: JWTVerifyGetKey;
  // The claim naming the user. Default `email`, which must then be verified.
  readonly userClaim?: string;
  // The claim listing the user's groups (Entra ID, Keycloak, Okta…). Default `groups`. Ignored when
  // `groups` is given.
  readonly groupsClaim?: string;
  // Where to get the groups when the token does not carry them (Google).
  readonly groups?: GroupLookup;
  // Claims the token must carry with exactly these values, e.g. Google's `hd` (hosted domain).
  readonly requiredClaims?: Readonly<Record<string, string>>;
}

// Any OpenID Connect provider: Entra ID, Keycloak, Okta, Dex, Google…
export function createOidcIdentity(options: OidcOptions): IdentityProvider {
  const { audience, userClaim = "email", groupsClaim = "groups" } = options;
  const issuers = typeof options.issuer === "string" ? [options.issuer] : [...options.issuer];
  let keys = options.keys;

  return {
    async principalFor(token) {
      keys ??= await discoverKeys(issuers[0] ?? "");
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, keys, { issuer: issuers, audience }));
      } catch (error) {
        throw new Unauthenticated(`Invalid token: ${error instanceof Error ? error.message : String(error)}`);
      }
      const user = payload[userClaim];
      if (typeof user !== "string" || user === "") throw new Unauthenticated(`The token has no ${userClaim} claim`);
      if (userClaim === "email" && payload.email_verified !== true) throw new Unauthenticated("The token's email is not verified");
      for (const [claim, value] of Object.entries(options.requiredClaims ?? {})) {
        if (payload[claim] !== value) throw new Unauthenticated(`The token's ${claim} claim is not ${value}`);
      }

      if (options.groups !== undefined) return { user, teams: [...(await options.groups(user))] };
      const claimed = z.array(z.string().min(1)).safeParse(payload[groupsClaim] ?? []);
      if (!claimed.success) throw new Unauthenticated(`The token's ${groupsClaim} claim is not a list of names`);
      return { user, teams: claimed.data };
    },
  };
}

async function discoverKeys(issuer: string): Promise<JWTVerifyGetKey> {
  const response = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`OIDC discovery failed for ${issuer}: ${response.status}`);
  const { jwks_uri } = z.object({ jwks_uri: z.url() }).parse(await response.json());
  return createRemoteJWKSet(new URL(jwks_uri));
}

// Google sign-in. Google is one issuer for every Google account in the world, so the token must
// come from the organisation's Workspace / Cloud Identity domain (`hd` claim): otherwise any Google
// user would get a principal, and with it every `shared` node. Google ID tokens carry no groups, so
// they come from Cloud Identity.
export function createGoogleIdentity(options: {
  readonly audience: string;
  readonly domain: string;
  readonly groups: GroupLookup;
  readonly keys?: JWTVerifyGetKey;
}): IdentityProvider {
  return createOidcIdentity({
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: options.audience,
    keys: options.keys ?? createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
    groups: options.groups,
    requiredClaims: { hd: options.domain },
  });
}

export interface CloudIdentityOptions {
  // `acme.com`: groups of that domain are named without it (`bff@acme.com` becomes `bff`). Groups
  // of other domains keep their full address, so they can never collide with a local name.
  readonly domain?: string;
  // An OAuth access token with the `cloud-identity.groups.readonly` scope. Defaults to Application
  // Default Credentials: the Cloud Run service account, or `gcloud auth application-default login`.
  readonly accessToken?: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

// Every group the user belongs to in Cloud Identity / Google Workspace, nested groups included
// (`searchTransitiveGroups`). Needs an organisation: a plain gmail account has no groups.
export function createCloudIdentityGroups(options: CloudIdentityOptions = {}): GroupLookup {
  const fetchFn = options.fetch ?? fetch;
  const accessToken =
    options.accessToken ??
    (() => {
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-identity.groups.readonly"] });
      return async () => {
        const token = await auth.getAccessToken();
        if (token === null || token === undefined) throw new Error("No Google credentials for Cloud Identity");
        return token;
      };
    })();
  const Page = z.object({
    memberships: z.array(z.object({ groupKey: z.object({ id: z.string().min(1) }) })).default([]),
    nextPageToken: z.string().optional(),
  });

  return async (user) => {
    const query = `member_key_id == '${user.replaceAll("'", "")}' && 'cloudidentity.googleapis.com/groups.discussion_forum' in labels`;
    const groups: string[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL("https://cloudidentity.googleapis.com/v1/groups/-/memberships:searchTransitiveGroups");
      url.searchParams.set("query", query);
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const response = await fetchFn(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
      if (!response.ok) throw new Error(`Cloud Identity: ${response.status} ${await response.text()}`);
      const page = Page.parse(await response.json());
      groups.push(...page.memberships.map((m) => localName(m.groupKey.id, options.domain)));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return [...new Set(groups)];
  };
}

function localName(group: string, domain: string | undefined): string {
  const suffix = domain === undefined ? undefined : `@${domain.toLowerCase()}`;
  return suffix !== undefined && group.toLowerCase().endsWith(suffix) ? group.slice(0, -suffix.length) : group;
}

export const DemoUsersSchema = z
  .array(z.object({ token: z.string().min(16), user: z.string().min(1), teams: z.array(z.string().min(1)).default([]) }))
  .min(1);

// Fixed tokens for the local demo and tests. Anyone holding a token is that user: never use it where
// the API can be reached by others. The API refuses it unless explicitly put in demo mode.
export function createDemoIdentity(users: z.input<typeof DemoUsersSchema>): IdentityProvider {
  const byToken = new Map<string, Principal>(DemoUsersSchema.parse(users).map(({ token, user, teams }) => [token, { user, teams }]));
  return {
    async principalFor(token) {
      const principal = byToken.get(token);
      if (principal === undefined) throw new Unauthenticated("Unknown demo token");
      return principal;
    },
  };
}
