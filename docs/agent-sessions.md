# Agent sessions

A coding-agent session (what a developer asked, what the agent read, ran and answered) explains a change better than its diff. Graph-Warden captures sessions as `Session` nodes, **private to the developer** whatever the capture says, and lets the developer promote one to a team after it is redacted of secrets and personal data (issue #27).

## Capture from Claude Code

Add a `SessionEnd` hook to `~/.claude/settings.json` (or a project's `.claude/settings.json`), with `GWARDEN_API` and `GWARDEN_TOKEN` in the environment Claude Code runs in:

```json
{
  "hooks": {
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "gwarden agent-session capture" }] }]
  }
}
```

The hook hands `gwarden` its JSON on stdin (`session_id`, `transcript_path`). `gwarden` turns the transcript into Markdown, keeping messages, tool calls and the first 2,000 characters of each tool result, and posts it to `POST /v1/agent-sessions`. The node's id is `session:<user>:<session_id>`; capturing the same session again replaces it while it is private.

Without a hook: `gwarden agent-session capture --transcript <file.jsonl> --id <id>`.

## Promote

```sh
gwarden agent-session preview session:lea:4f1c…        # the redacted text, what was redacted, and a digest
gwarden agent-session promote session:lea:4f1c… --scope team:bff --digest <digest>
```

- Only the author previews and promotes; to anyone else the session does not exist (404).
- The promotion publishes exactly the text previewed: it carries the preview's digest and is refused (409) if the session changed since.
- The scope must be one the author reads, and not private. The private text is replaced by the redacted one, not kept beside it; a promoted session is not captured over.
- Captures, previews and promotions are audited (`capture`, `promote`).

## What is redacted

Each finding becomes `[REDACTED:<kind>]`: private keys, AWS, GitHub, Slack, Google and LLM API keys, JWTs, bearer tokens, credentials in URLs, values assigned to names like `password`, `token`, `secret` or `api_key`, email addresses, phone numbers, IBANs, card numbers (Luhn-checked), and the user name in home directory paths. The test set is [`packages/core/test/redaction.cases.ts`](../packages/core/test/redaction.cases.ts), with what must go and what must stay (code reading secrets from the environment, commit shas, UUIDs, versions, timestamps).

Redaction is a net under the author's review, not a guarantee: a secret in a shape no pattern knows passes through. Read the preview before promoting.
