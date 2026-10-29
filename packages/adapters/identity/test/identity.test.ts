import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createCloudIdentityGroups, createDemoIdentity, createGoogleIdentity, createOidcIdentity } from "../src/index.js";

const issuer = "https://login.example.com";
const audience = "graph-warden";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });

const sign = (claims: JWTPayload, overrides: { issuer?: string; audience?: string; expires?: string } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setIssuedAt()
    .setExpirationTime(overrides.expires ?? "5m")
    .sign(privateKey);

describe("createOidcIdentity", () => {
  const identity = createOidcIdentity({ issuer, audience, keys });

  it("takes the user and the groups from the token", async () => {
    const token = await sign({ email: "lea@acme.com", email_verified: true, groups: ["dev", "bff"] });
    expect(await identity.principalFor(token)).toEqual({ user: "lea@acme.com", teams: ["dev", "bff"] });
  });

  it("refuses a token for another audience, from another issuer, expired or forged", async () => {
    const claims = { email: "lea@acme.com", email_verified: true };
    await expect(identity.principalFor(await sign(claims, { audience: "other-app" }))).rejects.toThrow(/Invalid token/);
    await expect(identity.principalFor(await sign(claims, { issuer: "https://evil.example" }))).rejects.toThrow(/Invalid token/);
    await expect(identity.principalFor(await sign(claims, { expires: "-1m" }))).rejects.toThrow(/Invalid token/);
    const { privateKey: other } = await generateKeyPair("RS256");
    const forged = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(audience).setExpirationTime("5m").sign(other);
    await expect(identity.principalFor(forged)).rejects.toThrow(/Invalid token/);
    await expect(identity.principalFor("not-a-jwt")).rejects.toMatchObject({ name: "Unauthenticated" });
  });

  it("refuses an unverified email and malformed groups", async () => {
    await expect(identity.principalFor(await sign({ email: "lea@acme.com" }))).rejects.toThrow(/not verified/);
    await expect(identity.principalFor(await sign({ email: "lea@acme.com", email_verified: true, groups: "dev" }))).rejects.toThrow(/groups/);
  });

  it("reads another user claim and groups claim", async () => {
    const entra = createOidcIdentity({ issuer, audience, keys, userClaim: "preferred_username", groupsClaim: "roles" });
    const token = await sign({ preferred_username: "lea", roles: ["dev"] });
    expect(await entra.principalFor(token)).toEqual({ user: "lea", teams: ["dev"] });
  });
});

describe("createGoogleIdentity", () => {
  const google = createGoogleIdentity({ audience, keys, domain: "acme.com", groups: async (user) => (user === "lea@acme.com" ? ["dev", "bff"] : []) });
  const googleToken = (claims: JWTPayload) => sign({ email_verified: true, ...claims }, { issuer: "https://accounts.google.com" });

  it("takes the groups from the lookup, not the token", async () => {
    const token = await googleToken({ email: "lea@acme.com", hd: "acme.com", groups: ["admins"] });
    expect(await google.principalFor(token)).toEqual({ user: "lea@acme.com", teams: ["dev", "bff"] });
  });

  it("refuses Google accounts outside the organisation's domain", async () => {
    await expect(google.principalFor(await googleToken({ email: "someone@gmail.com" }))).rejects.toThrow(/hd/);
    await expect(google.principalFor(await googleToken({ email: "eve@evil.com", hd: "evil.com" }))).rejects.toThrow(/hd/);
  });
});

describe("createCloudIdentityGroups", () => {
  it("follows pages and names the organisation's groups without their domain", async () => {
    const asked: URL[] = [];
    const pages = [
      { memberships: [{ groupKey: { id: "bff@acme.com" } }, { groupKey: { id: "dev@ACME.com" } }], nextPageToken: "p2" },
      { memberships: [{ groupKey: { id: "partners@other.org" } }, { groupKey: { id: "bff@acme.com" } }] },
    ];
    const lookup = createCloudIdentityGroups({
      domain: "acme.com",
      accessToken: async () => "t",
      fetch: (async (url: URL) => {
        asked.push(url);
        return new Response(JSON.stringify(pages[asked.length - 1]));
      }) as typeof fetch,
    });
    expect(await lookup("lea@acme.com")).toEqual(["bff", "dev", "partners@other.org"]);
    expect(asked[0]?.searchParams.get("query")).toContain("member_key_id == 'lea@acme.com'");
    expect(asked[1]?.searchParams.get("pageToken")).toBe("p2");
  });

  it("fails rather than returning no groups when Cloud Identity refuses", async () => {
    const lookup = createCloudIdentityGroups({ accessToken: async () => "t", fetch: (async () => new Response("denied", { status: 403 })) as typeof fetch });
    await expect(lookup("lea@acme.com")).rejects.toThrow(/403/);
  });
});

describe("createDemoIdentity", () => {
  it("maps fixed tokens to users", async () => {
    const demo = createDemoIdentity([{ token: "lea-token-0123456789", user: "lea", teams: ["bff"] }]);
    expect(await demo.principalFor("lea-token-0123456789")).toEqual({ user: "lea", teams: ["bff"] });
    await expect(demo.principalFor("guess")).rejects.toMatchObject({ name: "Unauthenticated" });
  });
});
