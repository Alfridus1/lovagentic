// Pure helpers for the `doctor` command. Kept in a stand-alone module so
// they can be imported and unit-tested without booting Commander / the CLI
// entrypoint in `src/cli.js`.

import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the canonical path of the macOS LaunchAgent plist that
 * `scripts/launchd/install-auth-refresh.sh` installs. Pure path math; no I/O.
 */
export function getDoctorLaunchAgentPlistPath({ homeDir = os.homedir() } = {}) {
  return path.join(
    homeDir,
    "Library",
    "LaunchAgents",
    "com.lovagentic.auth-refresh.plist"
  );
}

/**
 * Detect whether the auth-refresh LaunchAgent's plist exists for the current
 * user. Soft-fails on filesystem errors (returns `false`) so doctor never
 * hard-errors during environment inspection.
 *
 * The function accepts `homeDir` and `stat` overrides so unit tests can
 * exercise both branches without touching the real filesystem.
 */
export function isDoctorLaunchAgentInstalled({
  homeDir = os.homedir(),
  stat = statSync,
} = {}) {
  try {
    const plistPath = getDoctorLaunchAgentPlistPath({ homeDir });
    return stat(plistPath).isFile();
  } catch {
    return false;
  }
}
