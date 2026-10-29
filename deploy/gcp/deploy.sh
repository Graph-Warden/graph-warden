#!/bin/sh
# Deploys the Graph-Warden API to Cloud Run, in front of a Neo4j Aura database. Idempotent: run it
# again to roll out a new image. See README.md in this directory for what to prepare first.
#
# Required: PROJECT_ID, BILLING_ACCOUNT, NEO4J_URI (neo4j+s://…), GOOGLE_DOMAIN (your Workspace /
# Cloud Identity domain). The Aura password is read from NEO4J_PASSWORD or prompted, and stored in
# Secret Manager, never in the service's environment.
# Optional: REGION (europe-west1), GOOGLE_CLIENT_ID (the OAuth client the ID tokens are issued for),
# GWARDEN_AUDITORS (groups that may read the audit log, comma-separated).
set -eu
: "${PROJECT_ID:?}" "${BILLING_ACCOUNT:?}" "${NEO4J_URI:?}" "${GOOGLE_DOMAIN:?}"
REGION=${REGION:-europe-west1}
# Until `gwarden login` exists, readers use `gcloud auth print-identity-token`, issued for the gcloud
# CLI's own OAuth client. Replace it with your own client id when you have one.
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-32555940559.apps.googleusercontent.com}
GWARDEN_AUDITORS=${GWARDEN_AUDITORS:-auditors}
REPO=graph-warden
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/graph-warden:$(git rev-parse --short HEAD)"
SA="graph-warden-api@$PROJECT_ID.iam.gserviceaccount.com"
cd "$(dirname "$0")/../.."

step() { printf '\n== %s\n' "$*"; }

step "Project $PROJECT_ID"
gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1 || gcloud projects create "$PROJECT_ID"
gcloud billing projects link "$PROJECT_ID" --billing-account "$BILLING_ACCOUNT" >/dev/null
gcloud config set project "$PROJECT_ID" >/dev/null
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com cloudidentity.googleapis.com

step "Image $IMAGE"
gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO" --location "$REGION" --repository-format docker
gcloud builds submit --tag "$IMAGE" .

step "Neo4j password in Secret Manager"
if ! gcloud secrets describe neo4j-password >/dev/null 2>&1; then
  if [ -z "${NEO4J_PASSWORD:-}" ]; then
    printf 'Aura password: ' && stty -echo && read -r NEO4J_PASSWORD && stty echo && echo
  fi
  printf '%s' "$NEO4J_PASSWORD" | gcloud secrets create neo4j-password --data-file=-
fi

step "Service account $SA"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create graph-warden-api --display-name "Graph-Warden API"
gcloud secrets add-iam-policy-binding neo4j-password --member "serviceAccount:$SA" \
  --role roles/secretmanager.secretAccessor >/dev/null

step "Cloud Run service"
# --allow-unauthenticated lets requests reach the API, which then refuses any without a valid token
# from $GOOGLE_DOMAIN: authentication is the API's job (groups come from Cloud Identity). "^|^" makes |
# the separator of --set-env-vars, since GWARDEN_AUDITORS holds commas.
gcloud run deploy graph-warden-api --image "$IMAGE" --region "$REGION" --service-account "$SA" \
  --allow-unauthenticated --min-instances 0 --max-instances 3 \
  --set-env-vars "^|^GWARDEN_IDENTITY=google|GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID|GOOGLE_DOMAIN=$GOOGLE_DOMAIN|NEO4J_URI=$NEO4J_URI|NEO4J_USER=neo4j|GWARDEN_AUDITORS=$GWARDEN_AUDITORS" \
  --set-secrets NEO4J_PASSWORD=neo4j-password:latest

URL=$(gcloud run services describe graph-warden-api --region "$REGION" --format 'value(status.url)')
step "Done: $URL"
echo "Grant $SA the Groups Reader role in the Admin console (see README.md), then:"
echo "  GWARDEN_API=$URL GWARDEN_TOKEN=\$(gcloud auth print-identity-token) pnpm gwarden pull"
