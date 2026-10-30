# Deploying on Google Cloud

The API runs on Cloud Run, the graph lives in Neo4j Aura, identities come from Google sign-in and groups from Cloud Identity. Developer machines open no port: they pull what their groups allow.

```
gwarden pull ──HTTPS + Google ID token──▶ Cloud Run (graph-warden-api) ──bolt+s──▶ Neo4j Aura
                                                │
                                                └── Cloud Identity: the caller's groups, nested included
gwarden ingest (operator) ──bolt+s──────────────────────────────────────────────▶ Neo4j Aura
```

## What you need first

1. **A Google organisation with a domain**: Google Workspace or Cloud Identity Free, with a verified domain (`acme.com`). A plain gmail account has no groups, and the API refuses accounts outside `GOOGLE_DOMAIN`: otherwise every Google user in the world would read the `shared` nodes.
2. **Groups for your teams** in the Admin console (`bff@acme.com`, `front-a@acme.com`…). Oversight is a nested group: add `dev-leads@acme.com` as a member of every team group. Groups of your domain become team names without the domain (`bff`), so documents use `scope: team:bff`.
3. **A billing account** (`gcloud billing accounts list`). Cloud Run scales to zero; at demo traffic the cost is close to nothing, but Google requires billing to be enabled.
4. **A Neo4j Aura instance**: create one at <https://console.neo4j.io> (AuraDB Free is enough for a demo; choose a GCP region close to yours). Keep its `neo4j+s://…` URI and password.
5. `gcloud auth login`, run by you.

## Deploy

```sh
PROJECT_ID=graph-warden-demo BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX \
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io GOOGLE_DOMAIN=acme.com \
GWARDEN_AUDITORS=auditors deploy/gcp/deploy.sh
```

The script creates the project if needed and links billing. It enables the APIs, builds the image with Cloud Build, stores the Aura password in Secret Manager and creates a service account for the API. It then deploys to Cloud Run (`europe-west1` unless `REGION` says otherwise). Run it again to roll out a new commit.

Then let the API read groups. In the Admin console, under **Account → Admin roles → Groups Reader → Assign service accounts**, add `graph-warden-api@<project>.iam.gserviceaccount.com`. Without this role, every call fails with a 500 rather than letting someone in without their groups.

## Questions answered by Claude, without an API key

`/v1/ask` needs a model. On Google Cloud the API reaches Claude with its service account: no key to store, rotate or leak, and the usage is billed through your Google Cloud account. Two platforms, set with `LLM`:

- **`vertex`**: Claude on Google's Vertex AI. Enable the Claude model you want in **Vertex AI → Model Garden** for the project, then deploy with `LLM=vertex` (and `LLM_REGION` if the model is not served on the `global` endpoint). The script enables `aiplatform.googleapis.com` and grants the service account `roles/aiplatform.user`.
- **`google-cloud`**: Claude on Google Cloud, run by Anthropic, with the same features as the Claude API. Subscribe in the Google Cloud Marketplace and create its Anthropic organisation (see Anthropic's documentation, *Claude models on Google Cloud*), then deploy with `LLM=google-cloud ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID=wrkspc_…` (the workspace id is in the Claude Console, under Settings → Workspaces). The script enables `claude.googleapis.com` and grants `roles/claude.user`.

```sh
LLM=vertex PROJECT_ID=graph-warden-demo BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX \
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io GOOGLE_DOMAIN=acme.com deploy/gcp/deploy.sh
```

`GWARDEN_LLM_MODEL` picks another model than `claude-opus-5-5`. On Vertex AI, a declined answer is not retried on a fallback model, as it is on the other platforms: the question fails instead.

## Deploy without a domain

With no Workspace or Cloud Identity domain, deploy the demo users of `examples/shop/users.yaml` (lea, bob, alice, carla, dpo) instead of Google accounts. Only the billing account and the Aura instance are needed:

```sh
IDENTITY=demo PROJECT_ID=graph-warden-demo BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX \
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io deploy/gcp/deploy.sh
```

The tokens in the repository are public, so the script gives each user a new random token on the first run and keeps the list in Secret Manager (`demo-users`), mounted into the service as a file. Read them with `gcloud secrets versions access latest --secret demo-users`; delete the secret and deploy again to issue new ones. Anyone holding a token is that user: load demo data only. `DEMO_USERS` points to another list of `{ token, user, teams }`.

## Fill the graph

Ingestion is an operator's job and talks to Aura directly, never through the API:

```sh
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io NEO4J_PASSWORD=… \
pnpm gwarden ingest examples/shop/docs --source docs:shop --user you@acme.com \
  --team dev --team bff --team front-a --team front-b --team front-c
```

## Read it

```sh
export GWARDEN_API=$(gcloud run services describe graph-warden-api --region europe-west1 --format 'value(status.url)')
export GWARDEN_TOKEN=$(gcloud auth print-identity-token)   # expires after an hour
pnpm gwarden traverse orders-api --direction both
pnpm gwarden pull && pnpm gwarden cache
```

## Known limits

- **Tokens.** Until `gwarden login` exists, tokens come from `gcloud auth print-identity-token`, issued for the gcloud CLI's OAuth client, which `deploy.sh` accepts by default. The `hd` check keeps outsiders out, but any tool of your domain that uses gcloud's client could call the API. For anything beyond a demo, create your own OAuth client and pass its id as `GOOGLE_CLIENT_ID`.
- **Groups are looked up on every request.** A cache with a short lifetime will come with real traffic.
- **The audit log and the event log live in Aura** with the graph. Export them to BigQuery or Cloud Logging for retention.
- **No Helm chart yet.** It is for GKE; Cloud Run needs none.
