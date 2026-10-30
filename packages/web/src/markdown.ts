import DOMPurify from "dompurify";
import { marked } from "marked";

// A node's text is written by its authors, not by Graph-Warden: it is rendered as Markdown and then
// sanitised, so no script, handler or javascript: URL reaches the page.
//
// `[[id]]` and `[[id|label]]` become links to the node's page. Every such link renders the same,
// whether the node exists, is readable or not: a link that looked different for a node the reader
// may not see would reveal that it exists, the leak per-hop traversal closes (proposal 0012). The
// page it leads to says "not found or not readable" for both.

const WIKILINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g;

export const pageHref = (id: string) => `#/node/${encodeURIComponent(id)}`;

export function renderMarkdown(text: string): string {
  const linked = text.replace(WIKILINK, (_match, id: string, label: string | undefined) => {
    const target = id.trim();
    const shown = (label ?? target).trim().replace(/[[\]]/g, "");
    return `[${shown}](${pageHref(target)})`;
  });
  const html = marked.parse(linked, { async: false, gfm: true });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

// The page shows the node's title above its text; a text opening with that same heading would show
// it twice.
export function withoutTitle(text: string, title: string | undefined): string {
  if (title === undefined) return text;
  const first = /^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(text);
  return first !== null && first[1] === title ? text.slice(first[0].length) : text;
}
