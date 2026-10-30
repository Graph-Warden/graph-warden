import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { UnsecuredJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { createReader, createWriter, Unauthenticated, type IdentityProvider } from "@graph-warden/core";
import { createDemoIdentity } from "@graph-warden/identity";
import { createMemoryAuditLog, createMemoryEventLog, createMemoryStore } from "@graph-warden/memory";
import { buildApi } from "../src/index.js";

const secret = "a-test-secret-of-at-least-32-characters";
const token = "lea-token-0123456789";

async function demoApp(dir?: string) {
  const store = createMemoryStore();
  const audit = createMemoryAuditLog();
  await createWriter(store, createMemoryEventLog()).upsertNodes([
    { id: "adr", type: "Decision", scope: { kind: "team", team: "bff" }, provenance: { source: "docs", path: "adr.md" } },
  ]);
  const identity = createDemoIdentity([{ token, user: "lea", teams: ["bff"] }]);
  return buildApi({
    reader: createReader(store, audit),
    identity,
    web: { secret, publicUrl: "http://localhost:8080", login: { kind: "demo" }, ...(dir === undefined ? {} : { dir }) },
  });
}

const sessionOf = (response: { cookies: { name: string; value: string }[] }) => response.cookies.find((c) => c.name === "gw_session")?.value;

describe("serving the web app", () => {
  it("answers every app route with the page, and missing files and API routes with 404", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>app</title>");
    const app = await demoApp(dir);
    // Written after start-up, as a rebuild would.
    await writeFile(join(dir, "app.js"), "console.log(1)");
    const get = (url: string) => app.inject({ method: "GET", url });
    for (const url of ["/", "/anything/else"]) expect((await get(url)).body).toContain("<title>app</title>");
    expect((await get("/app.js")).headers["content-type"]).toContain("javascript");
    expect((await get("/assets/missing.js")).statusCode).toBe(404);
    expect((await get("/v1/unknown")).statusCode).toBe(404);
    expect((await get("/v1/unknown")).body).not.toContain("<title>");
  });
});

describe("browser sessions", () => {
  it("signs in with a demo token and reads with the cookie alone", async () => {
    const app = await demoApp();
    expect((await app.inject({ method: "GET", url: "/auth/config" })).json()).toEqual({ login: "demo" });
    const login = await app.inject({ method: "POST", url: "/auth/demo", payload: { token }, headers: { "x-requested-with": "gwarden" } });
    expect(login.json()).toEqual({ user: "lea", teams: ["bff"] });
    const cookie = login.cookies.find((c) => c.name === "gw_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    expect(cookie?.value).not.toContain(token);
    const me = await app.inject({ method: "GET", url: "/v1/me", cookies: { gw_session: sessionOf(login) ?? "" } });
    expect(me.json()).toEqual({ user: "lea", teams: ["bff"] });
  });

  it("refuses a wrong demo token, a forged cookie, and a sign-in from another site", async () => {
    const app = await demoApp();
    const wrong = await app.inject({ method: "POST", url: "/auth/demo", payload: { token: "nope" }, headers: { "x-requested-with": "gwarden" } });
    expect(wrong.statusCode).toBe(401);
    expect(sessionOf(wrong)).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { gw_session: "forged" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/demo", payload: { token } })).statusCode).toBe(403);
  });

  it("requires the header on writes made with a cookie, and signs out", async () => {
    const app = await demoApp();
    const login = await app.inject({ method: "POST", url: "/auth/demo", payload: { token }, headers: { "x-requested-with": "gwarden" } });
    const cookies = { gw_session: sessionOf(login) ?? "" };
    const ask = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/v1/ask", payload: { question: "q" }, cookies, headers });
    expect((await ask({})).statusCode).toBe(403);
    expect((await ask({ "x-requested-with": "gwarden" })).statusCode).toBe(501);
    const out = await app.inject({ method: "POST", url: "/auth/logout", cookies, headers: { "x-requested-with": "gwarden" } });
    expect(out.cookies.find((c) => c.name === "gw_session")?.value).toBe("");
  });
});

describe("OIDC sign-in", () => {
  // A provider with discovery and a token endpoint that issues an unsigned ID token carrying the
  // nonce it was asked for; the identity provider under test accepts any token.
  const idp = Fastify();
  idp.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, body));
  let nonce = "";
  let issued = "";
  idp.get("/.well-known/openid-configuration", async () => ({
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
  }));
  idp.post("/token", async () => ({ id_token: (issued = new UnsecuredJWT({ nonce, sub: "lea" }).setExpirationTime("1h").encode()) }));
  let issuer = "";
  afterAll(() => idp.close());

  const identity: IdentityProvider = {
    principalFor: async (t) => {
      if (t !== issued) throw new Unauthenticated("unknown token");
      return { user: "lea", teams: ["bff"] };
    },
  };

  it("redirects with state, nonce and PKCE, and opens a session only for the sign-in it started", async () => {
    issuer = await idp.listen({ port: 0, host: "127.0.0.1" });
    const app = buildApi({
      reader: createReader(createMemoryStore(), createMemoryAuditLog()),
      identity,
      web: { secret, publicUrl: "https://gw.example.com", login: { kind: "oidc", issuer, clientId: "web", clientSecret: "s" } },
    });
    const start = await app.inject({ method: "GET", url: "/auth/login" });
    const location = new URL(start.headers.location ?? "");
    expect(location.searchParams.get("redirect_uri")).toBe("https://gw.example.com/auth/callback");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const state = location.searchParams.get("state") ?? "";
    nonce = location.searchParams.get("nonce") ?? "";
    const pending = start.cookies.find((c) => c.name === "gw_login");
    expect(pending).toMatchObject({ httpOnly: true, secure: true });

    const forged = await app.inject({ method: "GET", url: `/auth/callback?code=c&state=other`, cookies: { gw_login: pending?.value ?? "" } });
    expect(forged.statusCode).toBe(401);
    const done = await app.inject({ method: "GET", url: `/auth/callback?code=c&state=${state}`, cookies: { gw_login: pending?.value ?? "" } });
    expect(done.statusCode).toBe(302);
    const session = sessionOf(done) ?? "";
    expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { gw_session: session } })).json()).toEqual({ user: "lea", teams: ["bff"] });

    nonce = "replayed";
    const again = await app.inject({ method: "GET", url: "/auth/login" });
    const replay = await app.inject({
      method: "GET",
      url: `/auth/callback?code=c&state=${new URL(again.headers.location ?? "").searchParams.get("state")}`,
      cookies: { gw_login: again.cookies.find((c) => c.name === "gw_login")?.value ?? "" },
    });
    expect(replay.statusCode).toBe(401);
  });
});
