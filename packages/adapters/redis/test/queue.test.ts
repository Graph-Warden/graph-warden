import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { createRedisQueue } from "../src/index.js";

// Runs against a throwaway Redis, flushed by every test: REDIS_TEST_URL=redis://localhost:6380
// (`docker compose --profile test up -d --wait redis-test`).
const url = process.env.REDIS_TEST_URL;

const waitFor = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
};

describe.skipIf(url === undefined)("Redis queue", () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(url ?? "");
  });
  afterAll(() => redis.quit());
  beforeEach(() => redis.flushdb());

  it("handles the jobs of one repository one at a time across workers, others in parallel", async () => {
    const queue = createRedisQueue(redis, { lockMs: 2000 });
    const busy = new Map<string, number>();
    let overlap = false;
    const handled: string[] = [];
    const handler = async (repo: string, sha: string) => {
      if ((busy.get(repo) ?? 0) > 0) overlap = true;
      busy.set(repo, (busy.get(repo) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      busy.set(repo, (busy.get(repo) ?? 1) - 1);
      handled.push(`${repo} ${sha}`);
    };
    const workers = await Promise.all([1, 2, 3].map(() => queue.start(handler)));
    const jobs = ["a 1", "a 2", "b 1", "a 3", "b 2", "a 4"];
    await Promise.all(jobs.map((job) => queue.enqueue(...(job.split(" ") as [string, string]))));
    await waitFor(() => handled.length >= jobs.length);
    await Promise.all(workers.map((worker) => worker.stop()));
    expect(overlap).toBe(false);
    expect(handled.sort()).toEqual([...jobs].sort());
    expect(await redis.scard("gwarden:pending:a")).toBe(0);
  });

  it("keeps a failed job, and hands it to the next worker that starts", async () => {
    const queue = createRedisQueue(redis);
    const errors: unknown[] = [];
    const failing = await queue.start(async () => {
      throw new Error("boom");
    }, (error) => errors.push(error));
    await queue.enqueue("a", "1");
    await waitFor(() => errors.length > 0);
    await failing.stop();

    const handled: string[] = [];
    const next = await queue.start(async (repo, sha) => void handled.push(`${repo} ${sha}`));
    await waitFor(() => handled.length > 0);
    await next.stop();
    expect(handled).toEqual(["a 1"]);
  });
});
