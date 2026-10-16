#!/bin/bash
set -euo pipefail
pnpm install --frozen-lockfile
# Development only: the guarded push must confirm completion before later steps.
# Do not use push-force here; destructive decisions require manual review.
pnpm --filter @workspace/db --fail-if-no-match run push
pnpm --filter @workspace/db run migrate:upload-cleanup
