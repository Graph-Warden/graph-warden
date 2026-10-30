import { describe, expect, it } from "vitest";
import { redact } from "../src/index.js";
import { CASES } from "./redaction.cases.js";

describe("redact", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const { text } = redact(testCase.text);
      for (const secret of testCase.gone) expect(text).not.toContain(secret);
      for (const kept of testCase.kept) expect(text).toContain(kept);
    });
  }

  it("says what it redacted, by kind", () => {
    expect(redact("mail a@b.example, key AKIAIOSFODNN7EXAMPLE, mail c@d.example").findings).toEqual({ "aws-key": 1, email: 2 });
  });

  it("is idempotent", () => {
    for (const { text } of CASES) expect(redact(redact(text).text).text).toBe(redact(text).text);
  });
});
