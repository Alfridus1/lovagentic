#!/usr/bin/env bash
# Capture desktop + mobile screenshots of every Lovable project you own.
#
# Useful as a visual regression snapshot before or after a big change,
# or as weekly health-check content for an internal dashboard.
#
# Output layout:
#   ./snapshots/<project-id>/desktop.png
#   ./snapshots/<project-id>/mobile.png
#   ./snapshots/index.json       # summary of every capture
#
# Requires:
#   lovagentic doctor     # all green
#   jq                    # brew install jq

set -euo pipefail

OUT="${1:-./snapshots}"
mkdir -p "$OUT"

log() { printf "\033[1;34m→\033[0m %s\n" "$*"; }

log "Listing projects"
PROJECTS_JSON="$(lovagentic list --json)"
COUNT="$(jq '.projects | length' <<< "$PROJECTS_JSON")"
log "Found $COUNT projects"
echo "[]" > "$OUT/index.json"
if [[ "$COUNT" -eq 0 ]]; then
  log "No projects found."
  exit 0
fi

jq -c '.projects[]' <<< "$PROJECTS_JSON" | while read -r project; do
  ID="$(echo "$project" | jq -r '.id')"
  NAME="$(echo "$project" | jq -r '.title // .name // .id')"
  URL="$(echo "$project" | jq -r '.projectUrl // ("https://lovable.dev/projects/" + .id)')"
  log "[$NAME] verifying $URL"

  mkdir -p "$OUT/$ID"
  if lovagentic verify \
      "$URL" \
      --output-dir "$OUT/$ID" \
      --settle-ms 2000 \
      > "$OUT/$ID/verify.log" 2>&1; then
    STATUS="ok"
  else
    STATUS="failed"
    log "[$NAME] FAILED — see $OUT/$ID/verify.log"
  fi

  ENTRY="$(jq -n --arg id "$ID" --arg name "$NAME" --arg status "$STATUS" \
    '{id: $id, name: $name, status: $status}')"
  jq --argjson e "$ENTRY" '. + [$e]' "$OUT/index.json" > "$OUT/index.json.tmp"
  mv "$OUT/index.json.tmp" "$OUT/index.json"
done

log "Done. Summary: $OUT/index.json"
