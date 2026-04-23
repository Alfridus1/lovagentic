#!/usr/bin/env bash
# CRM Dashboard — end-to-end build with lovagentic.
#
# Requires:
#   npm install -g lovagentic
#   lovagentic doctor     # all green
#
# Safe to re-run: reuses the last-created project URL.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="${HERE}/.last-project-url"

log() { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }
fail() { printf "\n\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

normalize_project_url() {
  local value="$1"
  if [[ "$value" == http* ]]; then
    printf '%s\n' "$value"
  else
    printf 'https://lovable.dev/projects/%s\n' "$value"
  fi
}

send_prompt_and_wait() {
  local file="$1"
  lovagentic prompt "$PROJECT_URL" --prompt-file "$file"
  lovagentic wait-for-idle "$PROJECT_URL" --auto-resume
}

if [[ -n "${LOVABLE_PROJECT_URL:-}" ]]; then
  PROJECT_URL="$(normalize_project_url "$LOVABLE_PROJECT_URL")"
  log "Using project from LOVABLE_PROJECT_URL: ${PROJECT_URL}"
elif [[ -f "$STATE_FILE" ]]; then
  PROJECT_URL="$(normalize_project_url "$(cat "$STATE_FILE")")"
  log "Reusing existing project: ${PROJECT_URL}"
else
  [[ -n "${LOVABLE_API_KEY:-}${LOVABLE_BEARER_TOKEN:-}" ]] || fail "Set LOVABLE_API_KEY for unattended project creation, or set LOVABLE_PROJECT_URL to reuse an existing project."
  log "Creating a new Lovable project from prompts/01-initial.md through the API backend"
  INITIAL_PROMPT="$(<"${HERE}/prompts/01-initial.md")"
  PROJECT_JSON="$(lovagentic create "$INITIAL_PROMPT" --json)"
  PROJECT_URL="$(jq -r '.projectUrl' <<< "$PROJECT_JSON")"
  [[ -n "$PROJECT_URL" && "$PROJECT_URL" != "null" ]] || fail "Create did not return a projectUrl."
  echo "$PROJECT_URL" > "$STATE_FILE"
  log "Created project: ${PROJECT_URL}"
fi

log "Refining UI (dark mode + a11y)"
send_prompt_and_wait "${HERE}/prompts/02-refine-ui.md"

log "Adding customer search"
send_prompt_and_wait "${HERE}/prompts/03-add-search.md"

log "Capturing preview snapshot"
lovagentic verify \
  "$PROJECT_URL" \
  --output-dir "${HERE}/.snapshots"

log "Running Lighthouse (desktop + mobile)"
LIGHTHOUSE_SUMMARY="${HERE}/.lighthouse/summary.json"
mkdir -p "${HERE}/.lighthouse"
lovagentic speed \
  "$PROJECT_URL" \
  --device both \
  --output-dir "${HERE}/.lighthouse" \
  --json > "$LIGHTHOUSE_SUMMARY"

jq -e '
  all(.audits[];
    ((.scores.performance // 0) >= 80) and
    ((.scores.accessibility // 0) >= 90)
  )
' "$LIGHTHOUSE_SUMMARY" > /dev/null

log "Publishing to default Lovable domain"
lovagentic publish "$PROJECT_URL"

log "Done. Project: ${PROJECT_URL}"
