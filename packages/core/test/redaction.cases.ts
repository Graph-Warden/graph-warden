// The redaction test set (issue #27): each case says what must disappear from the text, and what
// must stay. Secrets below are fake, built for these tests, and assembled at run time (`fake`) so
// that no token-shaped literal sits in the repository for secret scanners to flag.
const fake = (...parts: string[]) => parts.join("");
const SLACK = fake("xo", "xb-", "123456789012-abcdefghijklmnop");
const GITHUB = fake("gh", "p_", "1234567890abcdefghijklmnopqrstuvwxyzAB");
const GITHUB_PAT = fake("github", "_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz");
const ANTHROPIC = fake("sk-", "ant-", "api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
const OPENAI = fake("sk-", "proj-", "abcdefghijklmnopqrstuvwxyz012345");
const GOOGLE = fake("AI", "za", "SyA1234567890abcdefghijklmnopqrstuv");
const JWT = fake("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJsZWEiLCJleHAiOjE3MDB9", ".", "c2lnbmF0dXJlLXZhbHVl");
const PRIVATE_KEY = fake("-----BEGIN OPENSSH ", "PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH ", "PRIVATE KEY-----");
export interface RedactionCase {
  readonly name: string;
  readonly text: string;
  readonly gone: readonly string[];
  readonly kept: readonly string[];
}

export const CASES: readonly RedactionCase[] = [
  {
    name: "private key block",
    text: `key:\n${PRIVATE_KEY}\ndone`,
    gone: ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmU", "BEGIN OPENSSH"],
    kept: ["key:", "done"],
  },
  { name: "AWS access key", text: "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", gone: ["AKIAIOSFODNN7EXAMPLE"], kept: ["AWS_ACCESS_KEY_ID"] },
  {
    name: "AWS secret in a config file",
    text: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    gone: ["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    kept: ["aws_secret_access_key"],
  },
  { name: "GitHub token", text: `git clone https://x:${GITHUB}@github.com/acme/shop`, gone: [GITHUB], kept: ["github.com/acme/shop"] },
  { name: "fine-grained GitHub token", text: `GH_TOKEN=${GITHUB_PAT}`, gone: [GITHUB_PAT], kept: ["GH_TOKEN"] },
  { name: "Anthropic key", text: `client = Anthropic(api_key="${ANTHROPIC}")`, gone: [ANTHROPIC], kept: ["Anthropic("] },
  { name: "OpenAI project key", text: `OPENAI_API_KEY=${OPENAI}`, gone: [OPENAI], kept: ["OPENAI_API_KEY"] },
  { name: "Slack token", text: `SLACK=${SLACK}`, gone: [SLACK], kept: ["SLACK"] },
  { name: "Google API key", text: `maps key ${GOOGLE}`, gone: [GOOGLE], kept: ["maps key"] },
  {
    name: "JWT",
    text: `token ${JWT}`,
    gone: ["eyJzdWIiOiJsZWEiLCJleHAiOjE3MDB9", "c2lnbmF0dXJlLXZhbHVl"],
    kept: [],
  },
  { name: "bearer header", text: "curl -H 'Authorization: Bearer abc123def456ghi789' https://api.example.com/v1/me", gone: ["abc123def456ghi789"], kept: ["Authorization: Bearer", "https://api.example.com/v1/me"] },
  { name: "credentials in a URL", text: "DATABASE_URL=postgres://app:s3cretPassw0rd@db.internal:5432/shop", gone: ["s3cretPassw0rd", "app:"], kept: ["postgres://", "db.internal:5432/shop"] },
  { name: "password assignment", text: 'NEO4J_PASSWORD="hunter2hunter2"\npassword: Zx9!mQ2pLw', gone: ["hunter2hunter2", "Zx9!mQ2pLw"], kept: ["NEO4J_PASSWORD", "password:"] },
  { name: "secret in JSON", text: '{"client_secret": "a1b2c3d4e5f6g7h8"}', gone: ["a1b2c3d4e5f6g7h8"], kept: ['"client_secret"'] },
  { name: "CLI flag", text: "gwarden pull --token demo-lea-1b7f3c9e2a4d", gone: ["demo-lea-1b7f3c9e2a4d"], kept: ["gwarden pull --token"] },
  { name: "email address", text: "Ask lea.martin@acme.example for access.", gone: ["lea.martin@acme.example"], kept: ["Ask", "for access."] },
  { name: "French mobile number", text: "Call me on 06 12 34 56 78 or +33 6 12 34 56 78.", gone: ["06 12 34 56 78", "+33 6 12 34 56 78"], kept: ["Call me on"] },
  { name: "international number", text: "US office: +1 415-555-0100", gone: ["415-555-0100"], kept: ["US office:"] },
  { name: "IBAN", text: "IBAN FR76 3000 6000 0112 3456 7890 189 for the refund", gone: ["3000 6000 0112 3456 7890 189"], kept: ["for the refund"] },
  { name: "card number", text: "card 4111 1111 1111 1111 exp 12/29", gone: ["4111 1111 1111 1111"], kept: ["exp 12/29"] },
  { name: "home directory", text: "Read /home/splace/Work/graph-warden/README.md and C:\\Users\\splac\\Documents", gone: ["splace", "splac"], kept: ["/Work/graph-warden/README.md", "Documents"] },

  // What must stay: code, hashes, ids and numbers that look like secrets but are not.
  {
    name: "code reading secrets from the environment",
    text: 'const token = process.env.GWARDEN_TOKEN;\nconst apiKey = getApiKey();\npassword: ${{ secrets.NEO4J_PASSWORD }}',
    gone: [],
    kept: ["process.env.GWARDEN_TOKEN", "getApiKey()", "secrets.NEO4J_PASSWORD"],
  },
  {
    name: "commit shas, UUIDs, versions and timestamps",
    text: "commit a926399f2e6b1c0d3e4f5a6b7c8d9e0f1a2b3c4d, run 41138463270, id 3f2b9c1e-8a7d-4e5f-9b0c-1d2e3f4a5b6c, typescript ~5.9.3, at 1730311380123",
    gone: [],
    kept: ["a926399f2e6b1c0d3e4f5a6b7c8d9e0f1a2b3c4d", "41138463270", "3f2b9c1e-8a7d-4e5f-9b0c-1d2e3f4a5b6c", "~5.9.3", "1730311380123"],
  },
  { name: "prose about tokens", text: "The token is checked on every request; rotate the secret yearly.", gone: [], kept: ["The token is checked on every request; rotate the secret yearly."] },
  { name: "ports, dates and ranges", text: "Listen on 0.0.0.0:8080 from 2026-10-30 to 2026-11-02, lines 120-180.", gone: [], kept: ["0.0.0.0:8080", "2026-10-30", "2026-11-02", "120-180"] },
];
