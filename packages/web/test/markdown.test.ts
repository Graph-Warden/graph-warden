// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown, withoutTitle } from "../src/markdown.js";

describe("rendering a node's text", () => {
  it("turns wikilinks into links to node pages", () => {
    const html = renderMarkdown("See [[docs/retry policy|the policy]] and [[adr-7#context]].");
    expect(html).toContain('<a href="#/node/docs%2Fretry%20policy">the policy</a>');
    expect(html).toContain('<a href="#/node/adr-7">adr-7</a>');
  });

  it("renders every wikilink the same, whatever its target", () => {
    const shape = (id: string) => renderMarkdown(`[[${id}]]`).replace(id, "ID").replace(id, "ID");
    expect(shape("exists")).toBe(shape("secret"));
  });

  it("removes scripts, handlers and javascript: links", () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(1)">\n\nA [link](javascript:alert(1)).');
    expect(html).toContain("<a>link</a>");
    expect(html).not.toMatch(/<script|onerror|javascript:/);
  });

  it("drops an opening heading that repeats the title, and only that", () => {
    expect(withoutTitle("# Retries\n\nBody", "Retries")).toBe("\nBody");
    expect(withoutTitle("# Other\n\nBody", "Retries")).toBe("# Other\n\nBody");
    expect(withoutTitle("# Retries", undefined)).toBe("# Retries");
  });
});
