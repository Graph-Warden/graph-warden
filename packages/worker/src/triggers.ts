import { createHmac, timingSafeEqual } from "node:crypto";
import type { IngestionQueue } from "@graph-warden/core";
import { gitlabEvent } from "@graph-warden/gitlab";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

// Three ways to learn that a repository moved (issue #5), all feeding the same queue, so that no
// deployment needs a tunnel to the worker:
// - a GitHub webhook, when GitHub can reach the worker: its signature is checked against the
//   shared secret before anything in it is read; or a GitLab one (issue #19), push or merge
//   request, carrying its secret in X-Gitlab-Token;
// - a push from CI, when it cannot: a step on a self-hosted runner inside the network (the
//   published action in `action/ingest`) posts the repository and sha with a token;
// - polling, when nothing can reach the worker: it fetches each clone and compares the branch.
// A trigger only says which commit a repository reached. The ingester resumes from the last
// commit it ingested, so a missed or repeated notification loses or duplicates nothing.

export interface WatchedRepository {
  // `github:acme/shop` (or `gitlab:acme/shop`): a webhook for acme/shop is matched to it.
  readonly name: string;
  readonly branch: string;
}

export interface TriggerOptions {
  readonly queue: IngestionQueue;
  readonly repositories: readonly WatchedRepository[];
  // The webhook's secret; without it, the webhook route answers 404.
  readonly webhookSecret?: string;
  // The GitLab webhook's secret token; without it, the GitLab route answers 404.
  readonly gitlabSecret?: string;
  // The token CI pushes with; without it, the push route answers 404.
  readonly pushToken?: string;
  readonly logger?: boolean;
}

const SHA = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
// A push that deletes the branch has an all-zero `after`.
const DELETED = /^0+$/;

const PushEvent = z.object({
  ref: z.string(),
  after: z.string(),
  repository: z.object({ full_name: z.string().min(1) }),
});

const PushJob = z.object({ repo: z.string().min(1), sha: SHA, ref: z.string().optional() }).strict();

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (header === undefined || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const sameSecret = (expected: string, given: string) => {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function buildTriggers(options: TriggerOptions): FastifyInstance {
  const { queue, repositories, webhookSecret, gitlabSecret, pushToken } = options;
  const app = Fastify({ logger: options.logger ?? false });
  const byName = new Map(repositories.map((repo) => [repo.name, repo]));

  // The signature covers the exact bytes sent: keep them.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/webhooks/github", async (request, reply) => {
    if (webhookSecret === undefined) return reply.code(404).send();
    const body = request.body as Buffer;
    if (!verifySignature(webhookSecret, body, request.headers["x-hub-signature-256"] as string | undefined)) {
      return reply.code(401).send({ error: "invalid signature" });
    }
    const event = request.headers["x-github-event"];
    if (event === "ping") return reply.code(204).send();
    if (event !== "push") return reply.code(202).send({ ignored: `event ${String(event)}` });
    const push = PushEvent.safeParse(JSON.parse(body.toString("utf8")));
    if (!push.success) return reply.code(400).send({ error: "not a push event" });
    const repo = byName.get(`github:${push.data.repository.full_name}`);
    if (repo === undefined) return reply.code(202).send({ ignored: "repository not watched" });
    if (push.data.ref !== `refs/heads/${repo.branch}`) return reply.code(202).send({ ignored: `ref ${push.data.ref}` });
    if (DELETED.test(push.data.after) || !SHA.safeParse(push.data.after).success) {
      return reply.code(202).send({ ignored: "no commit" });
    }
    await queue.enqueue(repo.name, push.data.after);
    return reply.code(202).send({ queued: { repo: repo.name, sha: push.data.after } });
  });

  app.post("/webhooks/gitlab", async (request, reply) => {
    if (gitlabSecret === undefined) return reply.code(404).send();
    const given = request.headers["x-gitlab-token"];
    if (typeof given !== "string" || !sameSecret(gitlabSecret, given)) return reply.code(401).send({ error: "invalid token" });
    let parsed: unknown;
    try {
      parsed = JSON.parse((request.body as Buffer).toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    const event = gitlabEvent(parsed);
    if (event === undefined) return reply.code(202).send({ ignored: `event ${String(request.headers["x-gitlab-event"])}` });
    const repo = byName.get(`gitlab:${event.project}`);
    if (repo === undefined) return reply.code(202).send({ ignored: "repository not watched" });
    if (event.branch !== repo.branch) return reply.code(202).send({ ignored: `branch ${event.branch}` });
    if (!SHA.safeParse(event.sha).success) return reply.code(202).send({ ignored: "no commit" });
    await queue.enqueue(repo.name, event.sha);
    return reply.code(202).send({ queued: { repo: repo.name, sha: event.sha } });
  });

  app.post("/v1/jobs", async (request, reply) => {
    if (pushToken === undefined) return reply.code(404).send();
    const header = request.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || !sameSecret(pushToken, header.slice("Bearer ".length))) {
      return reply.code(401).send({ error: "invalid token" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse((request.body as Buffer).toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    const job = PushJob.safeParse(parsed);
    if (!job.success) return reply.code(400).send({ error: z.prettifyError(job.error) });
    const repo = byName.get(job.data.repo);
    if (repo === undefined) return reply.code(404).send({ error: `repository not watched: ${job.data.repo}` });
    // CI may run on any branch; only the watched one is ingested.
    if (job.data.ref !== undefined && job.data.ref !== `refs/heads/${repo.branch}`) {
      return reply.code(202).send({ ignored: `ref ${job.data.ref}` });
    }
    await queue.enqueue(repo.name, job.data.sha);
    return reply.code(202).send({ queued: { repo: repo.name, sha: job.data.sha } });
  });

  return app;
}

export interface Polled {
  readonly name: string;
  readonly branch: string;
  fetch(): Promise<void>;
  head(ref: string): Promise<string>;
}

// One round of polling: fetches every clone and queues the branch's commit when it moved since the
// previous round. The first round queues every branch: the ingester knows what it already has.
export function createPoller(queue: IngestionQueue, repositories: readonly Polled[], onError: (error: unknown, repo: string) => void = () => {}) {
  const seen = new Map<string, string>();
  return async function poll(): Promise<void> {
    await Promise.all(
      repositories.map(async (repo) => {
        try {
          await repo.fetch();
          const sha = await repo.head(`origin/${repo.branch}`);
          if (seen.get(repo.name) === sha) return;
          await queue.enqueue(repo.name, sha);
          seen.set(repo.name, sha);
        } catch (error) {
          onError(error, repo.name);
        }
      }),
    );
  };
}
