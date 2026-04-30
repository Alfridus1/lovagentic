#!/usr/bin/env bash
# Install a macOS LaunchAgent that refreshes the cached Lovable bearer token
# every 50 minutes, so api.lovable.dev calls always see a fresh JWT.
#
# Usage:
#   ./install-auth-refresh.sh              # default: writes ~/.lovagentic/lovable.env
#   ./install-auth-refresh.sh /path/.env   # custom env-file output
#
# Requirements:
#   - `lovagentic` must be on PATH (npm/pnpm global install or repo `npm link`).
#   - `lovagentic auth bootstrap` must have been run at least once so a refresh
#     token is cached at ~/.lovagentic/auth.json.
#
# To uninstall: ./uninstall-auth-refresh.sh

set -euo pipefail

LABEL="com.lovagentic.auth-refresh"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
TEMPLATE_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/com.lovagentic.auth-refresh.plist.template"
LOG_DIR="${HOME}/.lovagentic/logs"
ENV_FILE="${1:-${HOME}/.lovagentic/lovable.env}"

LOVAGENTIC_BIN="$(command -v lovagentic || true)"
if [[ -z "${LOVAGENTIC_BIN}" ]]; then
  echo "❌ lovagentic not found on PATH. Run 'npm link' in the repo or 'npm i -g lovagentic'." >&2
  exit 1
fi

# Resolve symlinks to a real CLI path. Some macOS launchd builds invoke a
# symlinked script through the wrong shebang resolver and pass arguments to
# `node` literally, which makes shebang-style invocation fragile. Resolving the
# symlink and calling node + script directly avoids that footgun.
if command -v realpath >/dev/null 2>&1; then
  CLI_REAL="$(realpath "${LOVAGENTIC_BIN}")"
elif command -v readlink >/dev/null 2>&1 && readlink -f "${LOVAGENTIC_BIN}" >/dev/null 2>&1; then
  CLI_REAL="$(readlink -f "${LOVAGENTIC_BIN}")"
else
  CLI_REAL="${LOVAGENTIC_BIN}"
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "❌ node not found on PATH." >&2
  exit 1
fi

mkdir -p "${PLIST_DIR}" "${LOG_DIR}" "$(dirname "${ENV_FILE}")"

# Resolve a stable PATH that includes brew, npm globals, and the user's PATH.
DEFAULT_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
EFFECTIVE_PATH="$(printf '%s' "${PATH}:${DEFAULT_PATH}" | tr ':' '\n' | awk 'NF && !seen[$0]++' | paste -sd: -)"

# Render the template.
sed \
  -e "s|__NODE_BIN__|${NODE_BIN}|g" \
  -e "s|__CLI_REAL__|${CLI_REAL}|g" \
  -e "s|__ENV_FILE__|${ENV_FILE}|g" \
  -e "s|__LOG_DIR__|${LOG_DIR}|g" \
  -e "s|__PATH__|${EFFECTIVE_PATH}|g" \
  -e "s|__HOME__|${HOME}|g" \
  "${TEMPLATE_PATH}" > "${PLIST_PATH}"

# Reload the agent (bootout is a no-op if it wasn't loaded yet).
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
launchctl enable   "gui/$(id -u)/${LABEL}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "✅ Installed LaunchAgent: ${PLIST_PATH}"
echo "   • node:              ${NODE_BIN}"
echo "   • lovagentic script: ${CLI_REAL}"
echo "   • Env file written:  ${ENV_FILE}"
echo "   • Logs:              ${LOG_DIR}/auth-refresh.{out,err}.log"
echo "   • Interval:          3000s (50 min) + on every login"
echo
echo "Inspect logs with:"
echo "  tail -f ${LOG_DIR}/auth-refresh.err.log"
