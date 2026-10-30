import { expect, it } from "vitest";
import { checkStore } from "@graph-warden/core";
import { createMemoryStore } from "../src/index.js";

it("passes the store conformance suite", async () => {
  expect(await checkStore(() => createMemoryStore())).toEqual([]);
});
