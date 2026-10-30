import { randomUUID } from "node:crypto";
import type { IngestionQueue } from "@graph-warden/core";
import { Redis } from "ioredis";

// `IngestionQueue` on Redis, for several workers. Per repository:
// - `<prefix>:pending:<repo>`, a set of shas: a job leaves it only once handled, so a worker that
//   dies mid-job leaves it to the next one;
// - `<prefix>:lock:<repo>`, held by the one worker draining the repository, with an expiry that
//   the holder renews: a dead worker's lock lapses;
// - `<prefix>:ready`, a list of repositories with jobs, which idle workers block on.
// A worker that finds the lock taken drops the wake-up: the holder checks the set again after
// releasing the lock and wakes a worker if anything arrived meanwhile.

export interface RedisQueueOptions {
  readonly prefix?: string;
  readonly lockMs?: number;
}

// Deletes or renews the lock only if this worker still holds it.
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const RENEW = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

export function createRedisQueue(redis: Redis, options: RedisQueueOptions = {}): IngestionQueue {
  const { prefix = "gwarden", lockMs = 60_000 } = options;
  const pending = (repo: string) => `${prefix}:pending:${repo}`;
  const lock = (repo: string) => `${prefix}:lock:${repo}`;
  const ready = `${prefix}:ready`;
  const repos = `${prefix}:repos`;

  return {
    async enqueue(repo, sha) {
      await redis.multi().sadd(pending(repo), sha).sadd(repos, repo).lpush(ready, repo).exec();
    },

    async start(handle, onError = () => {}) {
      // Blocking pops need a connection of their own.
      const blocking = redis.duplicate();
      let running = true;

      const drain = async (repo: string) => {
        const token = randomUUID();
        if ((await redis.set(lock(repo), token, "PX", lockMs, "NX")) !== "OK") return;
        const renew = setInterval(() => void redis.eval(RENEW, 1, lock(repo), token, lockMs).catch(() => {}), lockMs / 3);
        try {
          const tried = new Set<string>();
          for (;;) {
            const sha = (await redis.smembers(pending(repo))).find((member) => !tried.has(member));
            if (sha === undefined || !running) break;
            tried.add(sha);
            try {
              await handle(repo, sha);
              await redis.srem(pending(repo), sha);
            } catch (error) {
              onError(error, repo, sha);
            }
          }
        } finally {
          clearInterval(renew);
          await redis.eval(RELEASE, 1, lock(repo), token);
        }
      };

      // Repositories left with jobs by a stopped or dead worker.
      for (const repo of await redis.smembers(repos)) {
        if ((await redis.scard(pending(repo))) > 0) await redis.lpush(ready, repo);
      }

      const loop = (async () => {
        while (running) {
          const popped = await blocking.brpop(ready, 1);
          if (popped === null) continue;
          const [, repo] = popped;
          await drain(repo).catch((error: unknown) => onError(error, repo, ""));
        }
      })();

      return {
        async stop() {
          running = false;
          await loop;
          blocking.disconnect();
        },
      };
    },
  };
}
