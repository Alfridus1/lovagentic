import os from "node:os";
import path from "node:path";

export const DEFAULT_BASE_URL = process.env.LOVABLE_BASE_URL?.trim() || "https://lovable.dev";
export const DEFAULT_PROFILE_DIR = path.join(os.homedir(), ".lovagentic", "profile");
export const DEFAULT_DESKTOP_PROFILE_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "lovable-desktop"
);
export const DEFAULT_DESKTOP_APP_PATH = "/Applications/Lovable.app";
export const PROFILE_SEED_ENTRIES = [
  "Cookies",
  "IndexedDB",
  "Local State",
  "Local Storage",
  "Network Persistent State",
  "Preferences",
  "Session Storage"
];
export const SESSION_COOKIE_NAMES = ["lovable-auth", "lovable-session-id-v2"];
export const PLAYWRIGHT_PROFILE_SUBDIR = "Default";

export function resolvePath(input) {
  return path.resolve(input);
}

export function getProfileDir(explicitPath) {
  return explicitPath ? resolvePath(explicitPath) : DEFAULT_PROFILE_DIR;
}

export function getDesktopProfileDir(explicitPath) {
  return explicitPath ? resolvePath(explicitPath) : DEFAULT_DESKTOP_PROFILE_DIR;
}

export function getPlaywrightDefaultProfileDir(profileDir) {
  return path.join(profileDir, PLAYWRIGHT_PROFILE_SUBDIR);
}
