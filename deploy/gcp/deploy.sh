#!/bin/sh
# Deploys the Graph-Warden API to Cloud Run, in front of a Neo4j Aura database. Idempotent: run it
# again to roll out a new image. See README.md in this directory for what to prepare first.
#
# Required: PROJECT_ID, BILLING_ACCOUNT, NEO4J_URI (neo4j+s://…). The Aura password is read from
# NEO4J_PASSWORD or prompted, and stored in Secret Manager, never in the service's environment.
# Optional: REGION (europe-west1), GWARDEN_AUDITORS (groups that may read the audit log,
# comma-separated), IDENTITY (google or demo, google by default).
#
# IDENTITY=google needs GOOGLE_DOMAIN (your Workspace / Cloud Identity domain) and takes
# GOOGLE_CLIENT_ID (the OAuth client the ID tokens are issued for).
# IDENTITY=demo needs no domain: it serves the users of DEMO_USERS (examples/shop/users.yaml) with
# fresh random tokens, kept in Secret Manager. Anyone holding a token is that user: demo data only.
set -eu
: "${PROJECT_ID:?}" "${BILLING_ACCOUNT:?}" "${NEO4J_URI:?}"
REGION=${REGION:-europe-west1}
IDENTITY=${IDENTITY:-google}
GWARDEN_AUDITORS=${GWARDEN_AUDITORS:-auditors}
cd "$(dirname "$0")/../.."

case "$IDENTITY" in
  google)
    : "${GOOGLE_DOMAIN:?}"
    # Until `gwarden login` exists, readers use `gcloud auth print-identity-token`, issued for the
    # gcloud CLI's own OAuth client. Replace it with your own client id when you have one.
    GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-32555940559.apps.googleusercontent.com}
    IDENTITY_ENV="GWARDEN_IDENTITY=google|GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID|GOOGLE_DOMAIN=$GOOGLE_DOMAIN"
    IDENTITY_SECRETS=""
    IDENTITY_APIS=cloudidentity.googleapis.com
    ;;
  demo)
    DEMO_USERS=${DEMO_USERS:-examples/shop/users.yaml}
    [ -f "$DEMO_USERS" ] || { echo "No demo users at $DEMO_USERS" >&2; exit 1; }
    IDENTITY_ENV="GWARDEN_IDENTITY=demo|GWARDEN_DEMO=i-understand-anyone-with-a-token-is-that-user|GWARDEN_DEMO_USERS=/etc/gwarden/users.yaml"
    IDENTITY_SECRETS=",/etc/gwarden/users.yaml=demo-users:latest"
    IDENTITY_APIS=""
    ;;
  *) echo "IDENTITY must be google or demo, not $IDENTITY" >&2; exit 1 ;;
esac

REPO=graph-warden
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/graph-warden:$(git rev-parse --short HEAD)"
SA="graph-warden-api@$PROJECT_ID.iam.gserviceaccount.com"

step() { printf '\n== %s\n' "$*"; }

step "Project $PROJECT_ID"
gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1 || gcloud projects create "$PROJECT_ID"
gcloud billing projects link "$PROJECT_ID" --billing-account "$BILLING_ACCOUNT" >/dev/null
gcloud config set project "$PROJECT_ID" >/dev/null
# $IDENTITY_APIS is empty or one word.
# shellcheck disable=SC2086
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com $IDENTITY_APIS

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

if [ "$IDENTITY" = demo ]; then
  step "Demo users in Secret Manager"
  # The tokens of the repository are public: each user gets a new random one, created once and kept
  # across deployments. Delete the secret to issue new tokens.
  if ! gcloud secrets describe demo-users >/dev/null 2>&1; then
    while IFS= read -r line; do
      case "$line" in
        "#"*) ;;
        "- token: "*) printf -- '- token: demo-%s\n' "$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')" ;;
        *) printf '%s\n' "$line" ;;
      esac
    done <"$DEMO_USERS" | gcloud secrets create demo-users --data-file=-
  fi
  gcloud secrets add-iam-policy-binding demo-users --member "serviceAccount:$SA" \
    --role roles/secretmanager.secretAccessor >/dev/null
fi

step "Cloud Run service"
# --allow-unauthenticated lets requests reach the API, which then refuses any without a valid token:
# authentication is the API's job. "^|^" makes | the separator of --set-env-vars, since
# GWARDEN_AUDITORS holds commas.
gcloud run deploy graph-warden-api --image "$IMAGE" --region "$REGION" --service-account "$SA" \
  --allow-unauthenticated --min-instances 0 --max-instances 3 \
  --set-env-vars "^|^$IDENTITY_ENV|NEO4J_URI=$NEO4J_URI|NEO4J_USER=neo4j|GWARDEN_AUDITORS=$GWARDEN_AUDITORS" \
  --set-secrets "NEO4J_PASSWORD=neo4j-password:latest$IDENTITY_SECRETS"

URL=$(gcloud run services describe graph-warden-api --region "$REGION" --format 'value(status.url)')
step "Done: $URL"
if [ "$IDENTITY" = google ]; then
  echo "Grant $SA the Groups Reader role in the Admin console (see README.md), then:"
  echo "  GWARDEN_API=$URL GWARDEN_TOKEN=\$(gcloud auth print-identity-token) pnpm gwarden pull"
else
  echo "The demo users and their tokens: gcloud secrets versions access latest --secret demo-users"
  echo "  GWARDEN_API=$URL GWARDEN_TOKEN=<a token> pnpm gwarden pull"
fi
