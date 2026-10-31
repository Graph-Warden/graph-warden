# Deploying on AKS

The same Helm chart (`deploy/helm/graph-warden`) on Azure Kubernetes Service: the image in Azure Container Registry, the graph in Neo4j Aura on Azure, identities from Microsoft Entra ID, clones on Azure Files (issue #26).

```
gwarden pull / web app ──HTTPS + Entra token──▶ Ingress ──▶ graph-warden-api ──bolt+s──▶ Neo4j Aura
git push ──webhook──▶ graph-warden-worker ── clones on Azure Files (RWX, read by the API too) ─┘
```

This guide has not been run end to end by the project yet: the chart is checked in CI (`helm lint`, `helm template` with `ci/production-values.yaml`, written for AKS), not on a cluster. Report what fails.

## What you need first

1. An Azure subscription, and `az`, `kubectl` and `helm` 3, authenticated by you (`az login`).
2. A Neo4j Aura instance in an Azure region (<https://console.neo4j.io>). Keep its `neo4j+s://…` URI and password.
3. Rights to register an application in your Entra tenant.

```sh
RG=graph-warden LOCATION=westeurope ACR=acmegraphwarden
az group create -n $RG -l $LOCATION
az acr create -g $RG -n $ACR --sku Basic
az aks create -g $RG -n graph-warden --node-count 2 --attach-acr $ACR \
  --enable-oidc-issuer --enable-workload-identity --enable-app-routing --generate-ssh-keys
az aks get-credentials -g $RG -n graph-warden

TAG=$(git rev-parse --short HEAD)
az acr build -r $ACR -t graph-warden:$TAG .
```

`--attach-acr` lets the nodes pull the image without a pull secret. `--enable-app-routing` installs a managed NGINX ingress, class `webapprouting.kubernetes.azure.com`.

## Identities from Entra ID

Register an application for the API (**Entra ID → App registrations → New**), with an Application ID URI such as `api://graph-warden`. In **Token configuration**, add the `groups` claim. Teams are group names, so emit them as `sAMAccountName` for groups synced from Active Directory, or use app roles and set `OIDC_GROUPS_CLAIM: roles`. Entra emits group object ids by default, and they would become team names nobody recognises.

For the web app, give the same application a web redirect URI `https://graph-warden.example.com/auth/callback` and a client secret. The secret goes in the `graph-warden` Secret as `web-oidc-client-secret`.

```yaml
api:
  env:
    GWARDEN_IDENTITY: oidc
    OIDC_ISSUER: https://login.microsoftonline.com/<tenant id>/v2.0
    OIDC_AUDIENCE: api://graph-warden
    GWARDEN_PUBLIC_URL: https://graph-warden.example.com
    GWARDEN_AUDITORS: auditors
  secretEnv:
    GWARDEN_WEB_SECRET: { secret: graph-warden, key: web-secret }
    WEB_OIDC_CLIENT_ID: { secret: graph-warden, key: web-oidc-client-id }
    WEB_OIDC_CLIENT_SECRET: { secret: graph-warden, key: web-oidc-client-secret }
```

A user in more than 200 groups gets no `groups` claim from Entra, only a link to Microsoft Graph, which the API does not follow. Such a user reads `shared` nodes only. Prefer app roles if your users are in many groups.

## Secrets

```sh
kubectl create namespace graph-warden
kubectl -n graph-warden create secret generic graph-warden \
  --from-literal neo4j-password='…' \
  --from-literal web-secret="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" \
  --from-literal web-oidc-client-id='<application (client) id>' \
  --from-literal web-oidc-client-secret='…' \
  --from-literal github-webhook-secret="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
```

For production, keep them in Key Vault and mount them with the Key Vault provider for the Secrets Store CSI driver (`--enable-addons azure-keyvault-secrets-provider`), synced to a Kubernetes Secret: the chart only needs the Secret to exist.

## Models

**Claude through Microsoft Foundry is not available yet.** Foundry needs Anthropic's `@anthropic-ai/foundry-sdk`. Its 0.x line requires the Claude SDK below 1.0, which this project left behind. Its 1.0 release came out on 2026-10-21, and the project takes no dependency less than two weeks old, so it becomes eligible on 2026-11-04. Until then, use one of these:

- `GWARDEN_LLM: none`: everything but `/v1/ask` and revalidation works.
- **A model served by Azure OpenAI**, through the OpenAI-compatible provider. Put the key in the Secret as `openai-api-key`:

  ```yaml
  api:
    env:
      GWARDEN_LLM: openai
      GWARDEN_LLM_MODEL: <deployment name>
      GWARDEN_LLM_BASE_URL: https://<resource>.openai.azure.com/openai/v1
    secretEnv:
      OPENAI_API_KEY: { secret: graph-warden, key: openai-api-key }
  ```

- **Claude through the Claude API** with an API key: `GWARDEN_LLM: claude` and `ANTHROPIC_API_KEY` in `secretEnv`.
- **A local model** for sensitive nodes (`GWARDEN_LOCAL_LLM_MODEL`, `GWARDEN_LOCAL_LLM_BASE_URL`), in a pod of its own on a GPU node pool.

When the Foundry provider lands, it will authenticate with Workload Identity (`azure.workload.identity/client-id` on the service account, `azure.workload.identity/use: "true"` on the pods) rather than a key.

## Install

`values.yaml`, with the identity and model settings above:

```yaml
image: { repository: acmegraphwarden.azurecr.io/graph-warden, tag: "<TAG>" }
neo4j: { uri: "neo4j+s://xxxxxxxx.databases.neo4j.io" }
api:
  history: true
  ingress:
    enabled: true
    className: webapprouting.kubernetes.azure.com
    host: graph-warden.example.com
    tls: [{ secretName: graph-warden-tls, hosts: [graph-warden.example.com] }]
worker:
  env: { GWARDEN_POLL_SECONDS: "300" }
  secretEnv:
    GITHUB_WEBHOOK_SECRET: { secret: graph-warden, key: github-webhook-secret }
  repositories:
    - name: github:acme/shop
      url: https://github.com/acme/shop.git
      scope: team:dev
      author: { user: ingestion, teams: [dev] }
clones: { accessMode: ReadWriteMany, storageClass: azurefile-csi }
```

```sh
helm install graph-warden deploy/helm/graph-warden -n graph-warden -f values.yaml
```

`azurefile-csi` is AKS's built-in Azure Files class. It lets the worker write the clones and the API read them from other nodes, which the web app's history needs (`api.history`). Without history, the worker alone can use `managed-csi` (an Azure disk) with `ReadWriteOnce`. The certificate in `graph-warden-tls` comes from cert-manager or from Key Vault through app routing.

The worker takes GitHub webhooks on `/webhooks/github`, port 8081. To let GitHub reach it, expose the worker's Service through an Ingress of its own; or keep it private and rely on polling.

The demo (`demo.enabled`, with the demo users' Secret) works on AKS as it does on GKE: see `deploy/gke`.

## Upgrade, remove

```sh
az acr build -r $ACR -t graph-warden:$NEW_TAG .
helm upgrade graph-warden deploy/helm/graph-warden -n graph-warden -f values.yaml --set image.tag=$NEW_TAG
helm uninstall graph-warden -n graph-warden      # keeps the clones' volume and the Secrets
```
