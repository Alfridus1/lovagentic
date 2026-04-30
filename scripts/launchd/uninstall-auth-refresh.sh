#!/usr/bin/env bash
# Uninstall the lovagentic auth-refresh LaunchAgent.

set -euo pipefail

LABEL="com.lovagentic.auth-refresh"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "${PLIST_PATH}"

echo "✅ Removed LaunchAgent: ${PLIST_PATH}"
echo "   The cached auth file at ~/.lovagentic/auth.json was NOT touched."
echo "   Run \`lovagentic auth clear\` to wipe it."
