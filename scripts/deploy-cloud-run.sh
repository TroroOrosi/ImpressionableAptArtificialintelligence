#!/usr/bin/env bash
# Run from an authenticated Cloud Shell or local gcloud installation.
# Usage: bash scripts/deploy-cloud-run.sh PROJECT_ID [REGION] [SERVICE]
set -euo pipefail
PROJECT_ID="${1:?An explicit Google Cloud project ID is required}"
REGION="${2:-asia-northeast1}"
SERVICE="${3:-market-intel}"
[[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { echo 'Invalid project ID' >&2; exit 2; }
[[ "$SERVICE" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || { echo 'Invalid service name' >&2; exit 2; }
command -v gcloud >/dev/null
command -v node >/dev/null
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f pnpm-lock.yaml && -f Dockerfile && -f .gcloudignore ]] || { echo 'Run from the complete repository checkout' >&2; exit 2; }
# Billing and deploy/build IAM roles must already be configured by the project owner.
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project "$PROJECT_ID" --quiet
# Keep the service identity separate from the Cloud Build identity. No broad roles are granted here.
SA_NAME="market-intel-runtime"
SERVICE_ACCOUNT="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name 'Market Intel runtime' --project "$PROJECT_ID" --quiet
fi
# Only secret resource references are accepted, never plaintext secret values.
# Grant this service account Secret Accessor on each selected secret before using SECRET_BINDINGS.
EXTRA=()
if [[ -n "${SECRET_BINDINGS:-}" ]]; then EXTRA+=(--update-secrets "$SECRET_BINDINGS"); fi
# Public read-only endpoints; provider quotas/budgets are required before enabling paid sources.
gcloud run deploy "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --source . --port 8080 --allow-unauthenticated --service-account "$SERVICE_ACCOUNT" \
  --min 0 --max 1 --memory 512Mi --cpu 1 --timeout 120 \
  --update-env-vars NODE_ENV=production "${EXTRA[@]}" --quiet
BASE_URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
[[ "$BASE_URL" == https://* ]] || { echo 'Deployment did not return an HTTPS service URL' >&2; exit 1; }
gcloud run services update "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --update-env-vars "PUBLIC_BASE_URL=$BASE_URL" --quiet
node scripts/smoke-chatgpt.mjs "$BASE_URL"
printf '\nMCP endpoint: %s/api/mcp\nChatGPT registration and scheduled-run access still require separate verification.\n' "$BASE_URL"
