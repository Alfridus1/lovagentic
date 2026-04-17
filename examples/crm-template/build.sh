#!/usr/bin/env bash
# CRM Dashboard — end-to-end build with lovagentic.
#
# Requires:
#   npm install -g lovagentic
#   lovagentic doctor     # all green
#
# Safe to re-run: reuses the last-created project ID.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="${HERE}/.last-project-id"

log() { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }

if [[ -f "$STATE_FILE" ]]; then
  PROJECT_ID="$(cat "$STATE_FILE")"
  log "Reusing existing project: ${PROJECT_ID}"
else
  log "Creating a new Lovable project from prompts/01-initial.md"
  PROJECT_ID="$(
    lovagentic create \
      --prompt-file "${HERE}/prompts/01-initial.md" \
      --wait-for-idle \
      --name "crm-dashboard" \
      --json \
    | jq -r '.projectId'
  )"
  echo "$PROJECT_ID" > "$STATE_FILE"
  log "Created project: ${PROJECT_ID}"
fi

log "Refining UI (dark mode + a11y)"
lovagentic chat \
  --id "$PROJECT_ID" \
  --prompt-file "${HERE}/prompts/02-refine-ui.md" \
  --wait-for-idle

log "Adding customer search"
lovagentic chat \
  --id "$PROJECT_ID" \
  --prompt-file "${HERE}/prompts/03-add-search.md" \
  --wait-for-idle

log "Capturing preview snapshot"
lovagentic verify \
  --id "$PROJECT_ID" \
  --output-dir "${HERE}/.snapshots"

log "Running Lighthouse (desktop + mobile)"
lovagentic speed \
  --id "$PROJECT_ID" \
  --device both \
  --min-performance 80 \
  --min-accessibility 90 \
  --output-dir "${HERE}/.lighthouse"

log "Publishing to default Lovable domain"
lovagentic publish --id "$PROJECT_ID"

log "Done. Project: https://lovable.dev/projects/${PROJECT_ID}"
