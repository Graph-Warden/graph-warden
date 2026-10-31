# Deploying on GKE

The Helm chart of `deploy/helm/graph-warden` on Google Kubernetes Engine: the graph in Neo4j Aura, Claude through Vertex AI with Workload Identity, so that no model key is stored anywhere (issue #25). For a single API with no cluster, `deploy/gcp` on Cloud Run is simpler.

```
gwarden pull / web app ──HTTPS──▶ Ingress ──▶ graph-warden-api (2 pods) ──bolt+s──▶ Neo4j Aura
                                                      │                                  ▲
                                                      └── Vertex AI (Claude), as its     │
                                                          Google service account         │
git push ──webhook──▶ graph-warden-worker ─── clones on a volume ──────────────────────┘
```

This guide has not been run end to end by the project yet: the chart is checked in CI (`helm lint`, `helm template` with the values of `ci/`), not on a cluster. Report what fails.

## What you need first

1. A Google Cloud project with billing (`PROJECT_ID`), and `gcloud`, `kubectl` and `helm` 3, authenticated by you (`gcloud auth login`).
2. A Neo4j Aura instance (<https://console.neo4j.io>, in a GCP region close to the cluster). Keep its `neo4j+s://…` URI and password.
3. For Claude: the model enabled in **Vertex AI → Model Garden** for the project.

```sh
PROJECT_ID=graph-warden-demo REGION=europe-west1
gcloud config set project $PROJECT_ID
gcloud services enable container.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com aiplatform.googleapis.com
```

## The cluster and the image

An Autopilot cluster has Workload Identity on and bills by pod:

```sh
gcloud container clusters create-auto graph-warden --region $REGION
gcloud container clusters get-credentials graph-warden --region $REGION

gcloud artifacts repositories create graph-warden --repository-format docker --location $REGION
IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/graph-warden/graph-warden
TAG=$(git rev-parse --short HEAD)
gcloud builds submit --tag $IMAGE:$TAG .
```

## Secrets

The chart reads every secret from Kubernetes Secrets you create; none goes in a values file.

```sh
kubectl create namespace graph-warden
kubectl -n graph-warden create secret generic graph-warden \
  --from-literal neo4j-password='…' \
  --from-literal web-secret="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
```

`web-secret` signs the web app's sessions (`GWARDEN_WEB_SECRET`). For production, keep them in Secret Manager and sync them with the Secret Manager add-on or External Secrets: the chart only needs the Secret to exist.

## Claude through Vertex AI, without a key

The API's pods run as a Kubernetes service account bound to a Google one that may call Vertex AI:

```sh
gcloud iam service-accounts create graph-warden-api
GSA=graph-warden-api@$PROJECT_ID.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT_ID --member serviceAccount:$GSA --role roles/aiplatform.user
gcloud iam service-accounts add-iam-policy-binding $GSA --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:$PROJECT_ID.svc.id.goog[graph-warden/graph-warden]"
```

The last line names the chart's service account, `<namespace>/<release>` when the release is called `graph-warden`. In the values:

```yaml
serviceAccount:
  annotations: { iam.gke.io/gcp-service-account: graph-warden-api@graph-warden-demo.iam.gserviceaccount.com }
api:
  env:
    GWARDEN_LLM: claude
    GWARDEN_LLM_PLATFORM: vertex
    CLOUD_ML_REGION: global          # or a region where the model is enabled
    GOOGLE_CLOUD_PROJECT: graph-warden-demo
```

On Vertex AI a declined answer is not retried on a fallback model: the question fails instead. Claude on Google Cloud run by Anthropic (`GWARDEN_LLM_PLATFORM=google-cloud` with `ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID`, role `roles/claude.user`) has no such limit; see `deploy/gcp` for its setup.

## The demo

The demo loads `examples/shop` and its history into Aura when the API starts, with the demo users instead of real identities. The repository's tokens are public: give each user a new one.

```sh
while IFS= read -r line; do
  case "$line" in
    "#"*) ;;
    "- token: "*) printf -- '- token: demo-%s\n' "$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')" ;;
    *) printf '%s\n' "$line" ;;
  esac
done <examples/shop/users.yaml >users.yaml
kubectl -n graph-warden create secret generic graph-warden-demo-users --from-file users.yaml && rm users.yaml
```

Read them back with `kubectl -n graph-warden get secret graph-warden-demo-users -o jsonpath='{.data.users\.yaml}' | base64 -d`. Anyone holding a token is that user: load demo data only.

`demo.yaml`, with the Workload Identity values above:

```yaml
image: { repository: europe-west1-docker.pkg.dev/graph-warden-demo/graph-warden/graph-warden, tag: "<TAG>" }
neo4j: { uri: "neo4j+s://xxxxxxxx.databases.neo4j.io" }
demo: { enabled: true, usersSecret: graph-warden-demo-users }
worker: { enabled: false }
api:
  env: { GWARDEN_PUBLIC_URL: "https://graph-warden.example.com", GWARDEN_AUDITORS: auditors, GWARDEN_WRITERS: dev-leads }
  secretEnv:
    GWARDEN_WEB_SECRET: { secret: graph-warden, key: web-secret }
  ingress:
    enabled: true
    className: gce
    host: graph-warden.example.com
    annotations: { networking.gke.io/managed-certificates: graph-warden }
```

```sh
helm install graph-warden deploy/helm/graph-warden -n graph-warden -f demo.yaml
kubectl -n graph-warden get ingress graph-warden     # the address to point graph-warden.example.com at
```

A `ManagedCertificate` named `graph-warden` for the host gives the Ingress its TLS certificate (`kubectl apply` one from GKE's documentation). Then open `https://graph-warden.example.com` and sign in with a token.

## Your own repositories

Turn the demo off and the worker on. Identities come from your OIDC provider (`GWARDEN_IDENTITY=oidc`, or `google` with a Workspace domain as in `deploy/gcp`):

```yaml
demo: { enabled: false }
api:
  history: true
  env: { GWARDEN_IDENTITY: oidc, OIDC_ISSUER: "https://accounts.google.com", OIDC_AUDIENCE: "<client id>" }
worker:
  env: { GWARDEN_POLL_SECONDS: "300" }
  secretEnv:
    GITHUB_WEBHOOK_SECRET: { secret: graph-warden, key: github-webhook-secret }
  repositories:
    - name: github:acme/shop
      url: https://github.com/acme/shop.git
      scope: team:dev
      author: { user: ingestion, teams: [dev] }
clones: { accessMode: ReadWriteMany, storageClass: standard-rwx }
```

The worker clones each repository on its volume when it starts, then polls and takes webhooks on port 8081 (expose `/webhooks/github` through an Ingress of its own if GitHub must reach it). `api.history` lets the web app show the past, read from the same clones: with more than one node, that needs a `ReadWriteMany` class, Filestore's `standard-rwx` on GKE. For a private repository, put a token in the URL from a Secret or mount a deploy key; the chart does not manage git credentials yet.

## Upgrade, remove

```sh
gcloud builds submit --tag $IMAGE:$NEW_TAG .
helm upgrade graph-warden deploy/helm/graph-warden -n graph-warden -f demo.yaml --set image.tag=$NEW_TAG
helm uninstall graph-warden -n graph-warden      # keeps the clones' volume and the Secrets
```
