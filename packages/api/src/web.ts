import { createHash, randomBytes } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { Unauthenticated, type IdentityProvider } from "@graph-warden/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { decodeJwt, EncryptJWT, jwtDecrypt } from "jose";
import { z } from "zod";

// The web app's side of the API (proposal 0012), a backend for the front end: the browser never
// holds a token. Signing in (OIDC authorization code with PKCE, or a demo token) ends with the API
// setting an HttpOnly cookie that holds the ID token, encrypted with a server secret. Every request
// with that cookie is resolved by the same identity provider as a bearer token, so a session is
// exactly as valid as the token inside it, and no session store is needed: any instance can read
// the cookie. Writes made with the cookie must carry `x-requested-with: gwarden`, a header a
// cross-site form or script cannot send without a CORS preflight the API never grants.

export type WebLogin =
  | { readonly kind: "demo" }
  | {
      readonly kind: "oidc";
      readonly issuer: string;
      readonly clientId: string;
      readonly clientSecret: string;
    };

export interface WebOptions {
  // At least 32 characters; rotating it signs everyone out.
  readonly secret: string;
  // Where browsers reach the API, for the OIDC redirect and the Secure flag.
  readonly publicUrl: string;
  readonly login: WebLogin;
  // The built web app, served at `/`. Without it, only the auth routes are served.
  readonly dir?: string;
}

const SESSION = "gw_session";
const LOGIN = "gw_login";
const MAX_SESSION_SECONDS = 8 * 3600;
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "gwarden";

export class CrossSite extends Error {}

export interface Sessions {
  // The token a browser request carries in its session cookie, if any.
  token(request: FastifyRequest): Promise<string | undefined>;
}

export function registerWeb(app: FastifyInstance, identity: IdentityProvider, options: WebOptions): Sessions {
  if (options.secret.length < 32) throw new Error("The web session secret must have at least 32 characters");
  const key = createHash("sha256").update(options.secret).digest();
  const secure = options.publicUrl.startsWith("https://");
  const cookie = { path: "/", httpOnly: true, sameSite: "lax", secure } as const;

  const seal = (payload: Record<string, string>, seconds: number) =>
    new EncryptJWT(payload).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setIssuedAt().setExpirationTime(`${seconds}s`).encrypt(key);
  const open = async (value: string | undefined): Promise<Record<string, unknown> | undefined> => {
    if (value === undefined || value === "") return undefined;
    try {
      return (await jwtDecrypt(value, key)).payload;
    } catch {
      return undefined;
    }
  };

  // A session lasts as long as its token, and never more than eight hours.
  const startSession = async (reply: FastifyReply, token: string) => {
    let seconds = MAX_SESSION_SECONDS;
    try {
      const { exp } = decodeJwt(token);
      if (exp !== undefined) seconds = Math.min(seconds, exp - Math.floor(Date.now() / 1000));
    } catch {
      // Not a JWT (a demo token): the maximum applies.
    }
    if (seconds <= 0) throw new Unauthenticated("The token has expired");
    reply.setCookie(SESSION, await seal({ token }, seconds), { ...cookie, maxAge: seconds });
  };

  void app.register(fastifyCookie);

  app.get("/auth/config", async () => ({ login: options.login.kind }));

  app.post("/auth/logout", async (request, reply) => {
    if (request.headers[CSRF_HEADER] !== CSRF_VALUE) throw new CrossSite();
    reply.clearCookie(SESSION, cookie);
    return { ok: true };
  });

  if (options.login.kind === "demo") {
    const DemoLogin = z.object({ token: z.string().min(1) });
    app.post("/auth/demo", async (request, reply) => {
      if (request.headers[CSRF_HEADER] !== CSRF_VALUE) throw new CrossSite();
      const parsed = DemoLogin.safeParse(request.body);
      if (!parsed.success) throw new Unauthenticated("No token");
      const principal = await identity.principalFor(parsed.data.token);
      await startSession(reply, parsed.data.token);
      return principal;
    });
  } else {
    const login = options.login;
    const redirectUri = `${options.publicUrl.replace(/\/+$/, "")}/auth/callback`;
    const Discovery = z.object({ authorization_endpoint: z.url(), token_endpoint: z.url() });
    let discovery: Promise<z.infer<typeof Discovery>> | undefined;
    const endpoints = () =>
      (discovery ??= fetch(`${login.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`)
        .then((response) => response.json())
        .then((body) => Discovery.parse(body))
        .catch((error: unknown) => {
          discovery = undefined;
          throw error;
        }));
    const random = () => randomBytes(32).toString("base64url");

    app.get("/auth/login", async (_request, reply) => {
      const state = random();
      const verifier = random();
      const nonce = random();
      reply.setCookie(LOGIN, await seal({ state, verifier, nonce }, 600), { ...cookie, maxAge: 600 });
      const url = new URL((await endpoints()).authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: login.clientId,
        redirect_uri: redirectUri,
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      return reply.redirect(url.toString());
    });

    const Callback = z.object({ code: z.string().min(1), state: z.string().min(1) });
    const Tokens = z.object({ id_token: z.string().min(1) });
    app.get("/auth/callback", async (request, reply) => {
      const query = Callback.safeParse(request.query);
      const pending = await open(request.cookies[LOGIN]);
      reply.clearCookie(LOGIN, cookie);
      if (!query.success || pending === undefined || pending.state !== query.data.state) {
        throw new Unauthenticated("The sign-in did not start here, or took too long");
      }
      const response = await fetch((await endpoints()).token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: query.data.code,
          redirect_uri: redirectUri,
          client_id: login.clientId,
          client_secret: login.clientSecret,
          code_verifier: String(pending.verifier),
        }),
      });
      if (!response.ok) throw new Unauthenticated(`The token endpoint answered ${response.status}`);
      const { id_token: token } = Tokens.parse(await response.json());
      // The provider checks the signature, issuer and audience; the nonce ties the token to this sign-in.
      await identity.principalFor(token);
      if (decodeJwt(token).nonce !== pending.nonce) throw new Unauthenticated("The ID token was not issued for this sign-in");
      await startSession(reply, token);
      return reply.redirect("/");
    });
  }

  if (options.dir !== undefined) {
    const dir = options.dir;
    void app.register(fastifyStatic, { root: dir });
    // The app routes in the browser: any other GET outside the API is the app itself, except a
    // missing file, which must not come back as a page.
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split("?")[0] ?? "";
      const file = /\.[^/]*$/.test(path);
      if (request.method === "GET" && !file && !path.startsWith("/v1/") && !path.startsWith("/auth/")) return reply.sendFile("index.html", dir);
      return reply.code(404).send({ error: "not found" });
    });
  }

  return {
    async token(request) {
      const session = await open(request.cookies[SESSION]);
      if (session === undefined || typeof session.token !== "string") return undefined;
      if (request.method !== "GET" && request.method !== "HEAD" && request.headers[CSRF_HEADER] !== CSRF_VALUE) throw new CrossSite();
      return session.token;
    },
  };
}
