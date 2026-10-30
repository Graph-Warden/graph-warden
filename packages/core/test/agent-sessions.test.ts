import { describe, expect, it } from "vitest";
import { createReader, createAgentSessions, createWriter, Forbidden, sessionId } from "../src/index.js";
import { Conflict } from "../src/editor.js";
import { NotFound } from "../src/deletion.js";
import { Invalid } from "../src/pages.js";
import { memoryAudit, memoryEvents, memoryStore } from "./memory.js";
import { CASES } from "./redaction.cases.js";

// Issue #27: nothing from a session reaches a team scope without promotion, and what promotion
// publishes is the redacted text its author previewed.

const lea = { user: "lea", teams: ["bff"] };
const bob = { user: "bob", teams: ["bff"] };
const secrets = CASES.flatMap((c) => c.gone);
const transcript = CASES.map((c) => `## user\n${c.text}`).join("\n\n");

async function setup() {
  const store = memoryStore();
  const events = memoryEvents();
  const writer = createWriter(store, events);
  const audit = memoryAudit();
  const sessions = createAgentSessions(store, writer, audit);
  const reader = createReader(store, audit, { events });
  const node = await sessions.capture(lea, { id: "a1b2", title: "Fix pagination for lea.martin@acme.example", transcript });
  // Everything bob can get at: by id, neighbours, search, a pull from scratch.
  const seenByBob = async () =>
    JSON.stringify([
      await reader.node(bob, node.id).catch(() => undefined),
      await reader.search(bob, "pagination token password"),
      await reader.pull(bob, 0),
    ]);
  return { store, audit, sessions, node, seenByBob };
}

describe("sessions", () => {
  it("captures a session private to its author, readable by nobody else", async () => {
    const { node, seenByBob } = await setup();
    expect(node).toMatchObject({ id: sessionId("lea", "a1b2"), type: "Session", scope: { kind: "private", user: "lea" }, provenance: { source: "session:lea" } });
    const seen = await seenByBob();
    expect(seen).not.toContain(node.id);
    for (const secret of [...secrets, "lea.martin@acme.example"]) expect(seen).not.toContain(secret);
  });

  it("publishes, on promotion, exactly the redacted text previewed, and nothing else", async () => {
    const { sessions, node, seenByBob, store } = await setup();
    const preview = await sessions.preview(lea, node.id);
    for (const secret of secrets) expect(preview.text).not.toContain(secret);
    expect(preview.findings).toMatchObject({ email: expect.any(Number), "aws-key": 1 });
    expect(await seenByBob()).not.toContain(node.id);

    const promoted = await sessions.promote(lea, node.id, { kind: "team", team: "bff" }, preview.digest);
    expect(promoted.body).toBe(preview.text);
    expect(promoted.title).toBe("Fix pagination for [REDACTED:email]");
    const seen = await seenByBob();
    expect(seen).toContain(node.id);
    for (const secret of [...secrets, "lea.martin@acme.example"]) expect(seen).not.toContain(secret);
    // The private text is gone from the graph, not kept beside the promoted one.
    expect(JSON.stringify([...(await store.snapshot()).nodes.values()])).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("refuses a promotion of another text than the one previewed", async () => {
    const { sessions, node } = await setup();
    const preview = await sessions.preview(lea, node.id);
    await sessions.capture(lea, { id: "a1b2", transcript: `${transcript}\nAnd my key AKIAABCDEFGHIJKLMNOP.` });
    await expect(sessions.promote(lea, node.id, { kind: "shared" }, preview.digest)).rejects.toThrow(Conflict);
  });

  it("lets only the author preview or promote, only to a scope they read, never to a private one", async () => {
    const { sessions, node, audit } = await setup();
    const { digest } = await sessions.preview(lea, node.id);
    await expect(sessions.preview(bob, node.id)).rejects.toThrow(NotFound);
    await expect(sessions.promote(bob, node.id, { kind: "team", team: "bff" }, digest)).rejects.toThrow(NotFound);
    await expect(sessions.promote(lea, node.id, { kind: "team", team: "payments" }, digest)).rejects.toThrow(Forbidden);
    await expect(sessions.promote(lea, node.id, { kind: "private", user: "bob" }, digest)).rejects.toThrow(Invalid);
    expect(audit.written.filter((entry) => entry.action === "promote").map((entry) => ("denied" in entry ? entry.denied : entry.returned.length))).toEqual([1, true]);
  });

  it("does not capture over a promoted session, nor under an unsafe id", async () => {
    const { sessions, node } = await setup();
    await sessions.promote(lea, node.id, { kind: "shared" }, (await sessions.preview(lea, node.id)).digest);
    await expect(sessions.capture(lea, { id: "a1b2", transcript: "new" })).rejects.toThrow(Conflict);
    await expect(sessions.capture(lea, { id: "../x", transcript: "x" })).rejects.toThrow(Invalid);
  });
});
