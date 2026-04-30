// Lovable authentication module.
//
// The Lovable web/desktop app authenticates users via Firebase Identity Platform
// against the Google Cloud project `gpt-engineer-390607`. After sign-in, Firebase
// stores both:
//   - a short-lived (1h) Bearer ID token (used as `Authorization: Bearer ...`
//     against api.lovable.dev/v1/* and the internal lovable.dev/v2/* surfaces)
//   - a long-lived refresh token
// in IndexedDB under `firebaseLocalStorageDb` -> `firebaseLocalStorage`, keyed
// `firebase:authUser:<firebaseApiKey>:[DEFAULT]`.
//
// This module exposes a small toolkit:
//   1. extractFromProfile(profileDir): launch a Playwright context against a
//      logged-in profile and pull the auth state straight out of IndexedDB.
//   2. refreshAccessToken({ refreshToken, firebaseApiKey }): exchange a refresh
//      token for a fresh ID token via the public Google Secure Token endpoint.
//      No browser involved.
//   3. loadAuthState() / saveAuthState(): persist the resolved auth state to
//      ~/.lovagentic/auth.json (mode 0600) so subsequent invocations are stateless.
//   4. getValidAccessToken({ skewMs }): returns a non-expired access token,
//      refreshing automatically if the cached one is stale.
//   5. writeEnvFile(path): write a shell-sourceable file with the current
//      bearer + refresh values for downstream scripts (curl, etc.).
//
// Compatible with the official `@lovable.dev/sdk` `bearerToken` constructor option.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import { getProfileDir, getPlaywrightDefaultProfileDir } from "./config.js";

const SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";
const DEFAULT_AUTH_FILE = path.join(os.homedir(), ".lovagentic", "auth.json");
const DEFAULT_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const DEFAULT_FIREBASE_API_KEY =
  process.env.LOVABLE_FIREBASE_API_KEY || "AIzaSyBQNjlw9Vp4tP4VVeANzyPJnqbG2wLbYPw";

export const AUTH_FILE_PATH = DEFAULT_AUTH_FILE;

export class AuthError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = "AuthError";
    if (code) this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * Decode a JWT payload without verifying the signature. Returns null if the
 * token does not look like a JWT.
 */
export function decodeJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Check if an access token is expired (or near expiry, accounting for skew).
 */
export function isAccessTokenExpired(token, skewMs = DEFAULT_SKEW_MS) {
  const claims = decodeJwt(token);
  if (!claims?.exp) return true;
  const expMs = claims.exp * 1000;
  return Date.now() + skewMs >= expMs;
}

export function summarizeAuthState(state) {
  if (!state) return { configured: false };
  const claims = decodeJwt(state.accessToken);
  return {
    configured: Boolean(state.accessToken),
    userId: state.userId || claims?.user_id || claims?.sub || null,
    email: state.email || claims?.email || null,
    accessTokenExpiresAt: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
    accessTokenSecondsRemaining:
      claims?.exp ? Math.max(0, Math.round(claims.exp - Date.now() / 1000)) : null,
    hasRefreshToken: Boolean(state.refreshToken),
    firebaseApiKey: state.firebaseApiKey || null,
    source: state.source || null,
  };
}

/**
 * Read auth state from disk. Returns null if absent.
 */
export async function loadAuthState({ filePath = DEFAULT_AUTH_FILE } = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write auth state to disk with mode 0600. Creates parent dir as needed.
 */
export async function saveAuthState(state, { filePath = DEFAULT_AUTH_FILE } = {}) {
  if (!state) throw new AuthError("Cannot save empty auth state");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const json = JSON.stringify(
    { ...state, savedAt: new Date().toISOString() },
    null,
    2
  );
  await fs.writeFile(filePath, json, { mode: 0o600 });
  return filePath;
}

/**
 * Pull `firebase:authUser:<key>:[DEFAULT]` out of a logged-in profile's IndexedDB.
 *
 * Requires the profile to already be authenticated (e.g. via
 * `import-desktop-session` from a logged-in Lovable Desktop app, or via
 * `login`).
 */
export async function extractFromProfile({
  profileDir,
  headless = true,
  navigationTimeoutMs = 15_000,
  hydrateMs = 2_500,
} = {}) {
  const dir = getProfileDir(profileDir);
  if (!existsSync(dir)) {
    throw new AuthError(`Profile directory does not exist: ${dir}`);
  }

  const ctx = await chromium.launchPersistentContext(dir, {
    headless,
    viewport: { width: 1024, height: 768 },
  });

  let auth = null;
  try {
    const page = await ctx.newPage();
    await page.goto("https://lovable.dev/", {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeoutMs,
    });
    await page.waitForTimeout(hydrateMs);
    auth = await page.evaluate(async () => {
      return await new Promise((resolve, reject) => {
        try {
          const req = indexedDB.open("firebaseLocalStorageDb");
          req.onerror = () => reject(new Error(req.error?.message || "indexedDB open failed"));
          req.onsuccess = () => {
            try {
              const db = req.result;
              const tx = db.transaction("firebaseLocalStorage", "readonly");
              const store = tx.objectStore("firebaseLocalStorage");
              const all = store.getAll();
              all.onsuccess = () => {
                const items = all.result || [];
                const user = items.find(
                  (it) =>
                    typeof it?.fbase_key === "string" &&
                    it.fbase_key.startsWith("firebase:authUser:")
                );
                if (!user) {
                  resolve(null);
                  return;
                }
                const parts = user.fbase_key.split(":");
                resolve({
                  firebaseApiKey: parts[2] || null,
                  refreshToken: user?.value?.stsTokenManager?.refreshToken || null,
                  accessToken: user?.value?.stsTokenManager?.accessToken || null,
                  expirationTime: user?.value?.stsTokenManager?.expirationTime || null,
                  userId: user?.value?.uid || null,
                  email: user?.value?.email || null,
                  displayName: user?.value?.displayName || null,
                });
              };
              all.onerror = () => reject(new Error(all.error?.message || "indexedDB read failed"));
            } catch (e) {
              reject(e);
            }
          };
        } catch (e) {
          reject(e);
        }
      });
    });
  } finally {
    await ctx.close();
  }

  if (!auth || !auth.refreshToken || !auth.firebaseApiKey) {
    throw new AuthError(
      `No Firebase auth state found in profile ${dir}. Are you logged into lovable.dev?`,
      { code: "NO_AUTH_STATE" }
    );
  }

  return {
    ...auth,
    source: "profile",
    profileDir: dir,
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Exchange a Firebase refresh token for a fresh ID token. Pure HTTPS, no browser.
 */
export async function refreshAccessToken({
  refreshToken,
  firebaseApiKey = DEFAULT_FIREBASE_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!refreshToken) throw new AuthError("refreshToken is required to refresh the access token");
  if (!firebaseApiKey) throw new AuthError("firebaseApiKey is required to refresh the access token");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const url = `${SECURE_TOKEN_URL}?key=${encodeURIComponent(firebaseApiKey)}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      try { detail = await res.text(); } catch { /* ignore */ }
    }
    throw new AuthError(`Refresh failed: HTTP ${res.status} ${detail}`, { code: "REFRESH_FAILED" });
  }

  const json = await res.json();
  // Google response uses snake_case
  return {
    accessToken: json.id_token || json.access_token,
    refreshToken: json.refresh_token || refreshToken,
    expiresInSeconds: Number(json.expires_in) || 3600,
    expirationTime: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    userId: json.user_id || null,
    projectId: json.project_id || null,
  };
}

/**
 * High-level helper: bootstrap auth state from a logged-in profile (one-time)
 * and persist it to disk.
 */
export async function bootstrapFromProfile(opts = {}) {
  const extracted = await extractFromProfile(opts);
  // Refresh once on bootstrap so the cached token is fresh and we know the
  // refresh token still works.
  let refreshed;
  try {
    refreshed = await refreshAccessToken({
      refreshToken: extracted.refreshToken,
      firebaseApiKey: extracted.firebaseApiKey,
    });
  } catch (err) {
    // If the refresh fails right after extraction, keep the access token we
    // pulled out of IDB (it might still be valid for a short window).
    refreshed = {
      accessToken: extracted.accessToken,
      refreshToken: extracted.refreshToken,
      expiresInSeconds: null,
      expirationTime: extracted.expirationTime || null,
    };
  }

  const state = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    firebaseApiKey: extracted.firebaseApiKey,
    expirationTime: refreshed.expirationTime,
    userId: extracted.userId,
    email: extracted.email,
    displayName: extracted.displayName,
    source: extracted.source,
    profileDir: extracted.profileDir,
    extractedAt: extracted.extractedAt,
    refreshedAt: new Date().toISOString(),
  };
  await saveAuthState(state, { filePath: opts.filePath });
  return state;
}

/**
 * Refresh the cached auth state and write it back. No-op if cache is missing.
 */
export async function refreshCached({ filePath = DEFAULT_AUTH_FILE } = {}) {
  const state = await loadAuthState({ filePath });
  if (!state) {
    throw new AuthError(
      `No auth state found at ${filePath}. Run \`lovagentic auth bootstrap\` first.`,
      { code: "NO_CACHE" }
    );
  }
  if (!state.refreshToken || !state.firebaseApiKey) {
    throw new AuthError("Cached auth state is missing refreshToken or firebaseApiKey.", {
      code: "INVALID_CACHE",
    });
  }
  const refreshed = await refreshAccessToken({
    refreshToken: state.refreshToken,
    firebaseApiKey: state.firebaseApiKey,
  });
  const next = {
    ...state,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expirationTime: refreshed.expirationTime,
    refreshedAt: new Date().toISOString(),
  };
  await saveAuthState(next, { filePath });
  return next;
}

/**
 * Return a non-expired access token, refreshing the cache automatically when
 * the current one is within `skewMs` of expiry. Throws if no cache exists.
 */
export async function getValidAccessToken({
  filePath = DEFAULT_AUTH_FILE,
  skewMs = DEFAULT_SKEW_MS,
} = {}) {
  const state = await loadAuthState({ filePath });
  if (!state) {
    throw new AuthError(
      `No auth state found at ${filePath}. Run \`lovagentic auth bootstrap\` first.`,
      { code: "NO_CACHE" }
    );
  }
  if (state.accessToken && !isAccessTokenExpired(state.accessToken, skewMs)) {
    return { accessToken: state.accessToken, state, refreshed: false };
  }
  const next = await refreshCached({ filePath });
  return { accessToken: next.accessToken, state: next, refreshed: true };
}

/**
 * Materialise the active auth state into a shell-sourceable env file.
 */
export async function writeEnvFile(filePath, {
  authFilePath = DEFAULT_AUTH_FILE,
  refreshIfNeeded = true,
} = {}) {
  let state;
  if (refreshIfNeeded) {
    const result = await getValidAccessToken({ filePath: authFilePath });
    state = result.state;
  } else {
    state = await loadAuthState({ filePath: authFilePath });
    if (!state) throw new AuthError(`No auth state found at ${authFilePath}`);
  }
  const lines = [
    "# Generated by lovagentic — do not commit",
    `# Updated: ${new Date().toISOString()}`,
    `LOVABLE_BEARER_TOKEN=${state.accessToken}`,
    `LOVABLE_REFRESH_TOKEN=${state.refreshToken}`,
    `LOVABLE_FIREBASE_API_KEY=${state.firebaseApiKey}`,
    state.userId ? `LOVABLE_USER_ID=${state.userId}` : null,
    state.email ? `LOVABLE_EMAIL=${state.email}` : null,
  ].filter(Boolean);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.join("\n") + "\n", { mode: 0o600 });
  return { filePath, state };
}

// Re-export the helper view for the CLI (no need to expose the file path elsewhere).
export const __defaults = {
  AUTH_FILE_PATH: DEFAULT_AUTH_FILE,
  SKEW_MS: DEFAULT_SKEW_MS,
  FIREBASE_API_KEY: DEFAULT_FIREBASE_API_KEY,
  PLAYWRIGHT_PROFILE_SUBDIR: getPlaywrightDefaultProfileDir.name, // not used; placeholder
};
