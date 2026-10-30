// Redaction of secrets and personal data (issue #27), applied to a captured agent session before
// it may leave its author's private scope. Each finding is replaced by `[REDACTED:<kind>]`, so a
// reader sees that something was there and of what kind, never what. Patterns err on the side of
// redacting: a false positive costs a word of context, a false negative a leaked credential.
//
// This is a safety net under a human review, not a guarantee: a promotion shows the redacted text
// to its author, who publishes exactly what they were shown.

export type FindingKind =
  | "private-key"
  | "aws-key"
  | "github-token"
  | "slack-token"
  | "llm-api-key"
  | "google-api-key"
  | "jwt"
  | "bearer-token"
  | "url-credentials"
  | "secret-assignment"
  | "email"
  | "phone"
  | "iban"
  | "card-number"
  | "home-path";

export interface Redacted {
  readonly text: string;
  // How many of each kind were redacted.
  readonly findings: Readonly<Partial<Record<FindingKind, number>>>;
}

interface Rule {
  readonly kind: FindingKind;
  readonly pattern: RegExp;
  // What replaces the match; the whole match by default. Lets a rule keep its context
  // (`password=` stays, the value goes).
  readonly replace?: (match: string, ...groups: string[]) => string;
  readonly accept?: (match: string) => boolean;
}

const mark = (kind: FindingKind) => `[REDACTED:${kind}]`;

// Luhn checksum, so that long numbers that are not card numbers (timestamps, ids) stay.
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

// Order matters: the most specific rules run first, so that a GitHub token inside an assignment
// is reported as a GitHub token.
const RULES: readonly Rule[] = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "aws-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { kind: "slack-token", pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "llm-api-key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "bearer-token", pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/g, replace: (_m, scheme) => `${scheme} ${mark("bearer-token")}` },
  { kind: "url-credentials", pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s/@]+@/gi, replace: (_m, scheme) => `${scheme}${mark("url-credentials")}@` },
  {
    kind: "secret-assignment",
    // `password = "x"`, `API_KEY: x`, `--token x`, `"secret": "x"`: the value goes, the name stays.
    pattern:
      /\b((?:[A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)[A-Za-z0-9_]*)["']?\s*(?:[:=]|\s)\s*)(["']?)([^\s"',;)}]{6,})\2/gi,
    replace: (_m, name, quote) => `${name}${quote}${mark("secret-assignment")}${quote}`,
    // A value that reads like code (a call, a property, an already redacted value) or a word is
    // not a secret.
    accept: (match) => {
      const value = /[:=\s]\s*["']?([^\s"',;)}]+)["']?$/.exec(match)?.[1] ?? "";
      return !/[(]|^\[REDACTED|^(?:process\.env|env|os\.environ|getenv|\$\{?)/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);
    },
  },
  { kind: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  { kind: "iban", pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  {
    kind: "card-number",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (match) => luhn(match.replace(/\D/g, "")),
  },
  {
    kind: "phone",
    // International (+33 6 12 34 56 78, +1 415-555-0100) or French national (06 12 34 56 78).
    pattern: /(?:\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{1,4}(?:[ .-]?\d{2,4}){2,4}|\b0[1-9](?:[ .-]?\d{2}){4})\b/g,
  },
  { kind: "home-path", pattern: /(\/home\/|\/Users\/|[A-Z]:\\Users\\)([^\s/\\'"]+)/g, replace: (_m, root) => `${root}${mark("home-path")}` },
];

export function redact(text: string): Redacted {
  const findings: Partial<Record<FindingKind, number>> = {};
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      if (rule.accept !== undefined && !rule.accept(match)) return match;
      findings[rule.kind] = (findings[rule.kind] ?? 0) + 1;
      // The capture groups come before the offset, a number; unmatched ones are undefined.
      const groups = rest.slice(0, rest.findIndex((value) => typeof value === "number")).map((value) => (typeof value === "string" ? value : ""));
      return rule.replace === undefined ? mark(rule.kind) : rule.replace(match, ...groups);
    });
  }
  return { text: out, findings };
}
