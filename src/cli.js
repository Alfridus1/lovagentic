#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

// Read package.json once at startup so `--version` always reflects the real
// installed release instead of a hardcoded string that drifts every bump.
const __dirname_cli = path.dirname(fileURLToPath(import.meta.url));
let PKG_VERSION = "0.0.0-unknown";
try {
  PKG_VERSION = JSON.parse(
    readFileSync(path.resolve(__dirname_cli, "..", "package.json"), "utf8")
  ).version || PKG_VERSION;
} catch {
  // keep fallback
}

function getInstalledPackageVersion(packageName) {
  try {
    const pkgPath = path.resolve(
      __dirname_cli,
      "..",
      "node_modules",
      ...packageName.split("/"),
      "package.json"
    );
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

import {
  buildApiDiff,
  buildApiSnapshot,
  formatDiffSummary,
  formatSnapshotSummary,
  getProjectIdFromTarget,
  writeJsonFile
} from "./api-ops.js";
import {
  AUTH_FILE_PATH,
  AuthError,
  bootstrapFromProfile,
  getValidAccessToken,
  loadAuthState,
  refreshCached,
  saveAuthState,
  summarizeAuthState,
  writeEnvFile,
} from "./auth.js";
import { isDoctorLaunchAgentInstalled } from "./doctor.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_DESKTOP_APP_PATH,
  getDesktopProfileDir,
  getPlaywrightDefaultProfileDir,
  getProfileDir
} from "./config.js";
import {
  answerProjectQuestion,
  capturePreviewSnapshot,
  clickChatAction,
  clickQueueResume,
  compareDashboardProjectState,
  connectProjectDomain,
  connectProjectGitProvider,
  clickQuestionAction,
  clickRuntimeErrorAction,
  disconnectProjectGitProvider,
  ensureSignedIn,
  getDashboardProjectState,
  fillPrompt,
  getDashboardState,
  getCurrentPromptMode,
  getProjectGitState,
  getProjectFindingsState,
  getProjectDomainSettingsState,
  getProjectKnowledgeState,
  getProjectIdleState,
  getProjectQuestionState,
  getProjectRuntimeErrorState,
  getProjectSettingsState,
  getProjectToolbarState,
  getPublishedSettingsState,
  hasLovableSession,
  getProjectPreviewInfo,
  getWorkspaceSettingsState,
  getPromptAttachmentState,
  launchLovableContext,
  listChatActions,
  publishProject,
  pollDashboardProjectState,
  readFirebaseAuthUsers,
  readUrlTextSnapshot,
  reconnectProjectGitProvider,
  runCreateFlow,
  setPromptMode,
  submitPrompt,
  confirmPromptPersistsAfterReload,
  updateProjectKnowledge,
  updateProjectSettings,
  updateProjectSubdomain,
  updatePublishedSettings,
  uploadPromptAttachments,
  waitForChatAcceptance,
  waitForProjectIdle,
  waitForPromptResult,
  waitForVerificationResolution,
  waitForLovableSession
} from "./browser.js";
import {
  buildFidelityFollowUpPrompt,
  buildPromptSequence,
  DEFAULT_IDLE_POLL_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  getPromptTurnPostSubmitTimeoutMs,
  planPromptSequence,
  parseAssertionLines,
  shouldUseLenientPromptAck
} from "./orchestration.js";
import { pathExists, seedDesktopProfileIntoPlaywrightDefault } from "./profile.js";
import {
  getRunbookPlan,
  normalizeRunbook,
  parseRunbookText
} from "./runbook.js";
import {
  buildCreateUrl,
  buildPreviewRouteUrl,
  getVerificationScreenshotFilename,
  normalizePreviewRoute,
  normalizeTargetUrl,
  slugifyPreviewRoute
} from "./url.js";

const program = new Command();

program
  .name("lovagentic")
  .description("Prototype CLI for steering Lovable from the local machine.")
  .version(PKG_VERSION);

program
  .command("doctor")
  .description("Inspect the local Lovable desktop install, CLI profile, Node, and Playwright.")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--json", "Print machine-readable JSON", false)
  .option("--self-heal", "Automatically repair fixable problems (install Chromium, seed CLI profile from desktop session)", false)
  .action(async (options) => {
    const profileDir = getProfileDir(options.profileDir);
    const desktopProfileDir = getDesktopProfileDir(options.desktopProfileDir);

    // First pass — describe current state.
    let result = await runDoctorChecks({ profileDir, desktopProfileDir });
    let healedActions = [];

    if (options.selfHeal) {
      healedActions = await selfHealDoctor({
        profileDir,
        desktopProfileDir,
        checks: result.checks,
        json: Boolean(options.json)
      });
      if (healedActions.length > 0) {
        // Re-run to reflect the new state.
        result = await runDoctorChecks({ profileDir, desktopProfileDir });
      }
    }

    const { checks, playwrightDefaultDir, api } = result;
    const failed = checks.filter((c) => !c.ok);

    if (options.json) {
      console.log(JSON.stringify({
        ok: failed.length === 0,
        failed: failed.map((c) => c.key),
        healed: healedActions,
        checks,
        paths: { profileDir, desktopProfileDir, playwrightDefaultDir },
        node: process.version,
        api,
        apiConfigured: api.configured,
        mcpConfigured: Boolean(process.env.LOVABLE_MCP_URL)
      }, null, 2));
    } else {
      for (const c of checks) {
        const mark = c.ok ? "\u2713" : "\u2717";
        console.log(`${mark} ${c.label}`);
      }
      if (healedActions.length > 0) {
        console.log("");
        console.log("Self-heal actions:");
        for (const a of healedActions) {
          const mark = a.ok ? "\u2713" : "\u2717";
          console.log(`  ${mark} ${a.label}${a.detail ? ` \u2014 ${a.detail}` : ""}`);
        }
      }
      const hints = checks.filter((c) => c.hint);
      if (hints.length > 0) {
        console.log("");
        console.log("Notes:");
        for (const c of hints) {
          console.log(`  - ${c.hint}`);
        }
      }
    }

    if (failed.length > 0) {
      process.exitCode = 1;
    }
  });

async function runDoctorChecks({ profileDir, desktopProfileDir }) {
  const playwrightDefaultDir = getPlaywrightDefaultProfileDir(profileDir);

  const desktopAppInstalled = await pathExists(DEFAULT_DESKTOP_APP_PATH);
  const desktopProfileExists = await pathExists(desktopProfileDir);
  const cliProfileExists = await pathExists(profileDir);
  const cliCookieFileExists = await pathExists(`${playwrightDefaultDir}/Cookies`);
  const desktopCookieFileExists = await pathExists(`${desktopProfileDir}/Cookies`);

  const nodeMajor = Number(process.versions.node.split(".")[0] || 0);
  const nodeOk = nodeMajor >= 20;

  const pwStatus = await detectPlaywright();
  const lovableSdkVersion = getInstalledPackageVersion("@lovable.dev/sdk");
  let authCacheState = null;
  try {
    authCacheState = await loadAuthState();
  } catch {
    authCacheState = null;
  }
  const authCacheUsable = Boolean(
    authCacheState?.refreshToken && authCacheState?.firebaseApiKey
  );
  const authCacheSummary = authCacheUsable ? summarizeAuthState(authCacheState) : null;
  const apiKeyEnvSet = Boolean(process.env.LOVABLE_API_KEY);
  const bearerEnvSet = Boolean(process.env.LOVABLE_BEARER_TOKEN);
  const apiAuthSource = apiKeyEnvSet
    ? "env-api-key"
    : bearerEnvSet
      ? "env-bearer"
      : authCacheUsable
        ? "auth-cache"
        : null;
  const launchAgentInstalled = isDoctorLaunchAgentInstalled();
  const api = {
    configured: Boolean(apiKeyEnvSet || bearerEnvSet || authCacheUsable),
    apiKeyConfigured: apiKeyEnvSet,
    bearerTokenConfigured: bearerEnvSet,
    authCacheConfigured: authCacheUsable,
    authSource: apiAuthSource,
    authFile: AUTH_FILE_PATH,
    authEmail: authCacheSummary?.email || null,
    accessTokenSecondsRemaining: authCacheSummary?.accessTokenSecondsRemaining ?? null,
    accessTokenExpiresAt: authCacheSummary?.accessTokenExpiresAt || null,
    launchAgentInstalled,
    baseUrl: process.env.LOVABLE_API_BASE_URL || "https://api.lovable.dev",
    sdkVersion: lovableSdkVersion
  };
  const mcpConfigured = Boolean(process.env.LOVABLE_MCP_URL);

  // Network reachability checks (fast, ~3s timeout each, in parallel).
  const network = await runNetworkChecks();

  const checks = [
    { key: "node", label: `Node.js ${process.version}`, ok: nodeOk, healable: false, hint: nodeOk ? null : "lovagentic requires Node 20+. Upgrade Node before continuing." },
    { key: "desktopApp", label: `Lovable.app (${DEFAULT_DESKTOP_APP_PATH})`, ok: desktopAppInstalled, healable: false, hint: desktopAppInstalled ? null : "Lovable desktop app not installed. Download from https://lovable.dev/download — required to seed a session." },
    { key: "desktopProfile", label: `Desktop profile (${desktopProfileDir})`, ok: desktopProfileExists, healable: false, hint: desktopProfileExists ? null : "Launch Lovable.app at least once and sign in before running lovagentic." },
    { key: "desktopCookies", label: "Desktop cookies", ok: desktopCookieFileExists, healable: false, hint: desktopCookieFileExists ? null : "No Lovable session found in the desktop profile. Sign in to Lovable.app first." },
    { key: "cliProfile", label: `CLI profile (${profileDir})`, ok: cliProfileExists, healable: true, hint: cliProfileExists ? null : "Run `lovagentic login`, `lovagentic import-desktop-session`, or `lovagentic doctor --self-heal`." },
    { key: "cliCookies", label: "CLI cookies", ok: cliCookieFileExists, healable: true, hint: cliCookieFileExists ? null : "CLI profile has no session. Run `lovagentic import-desktop-session` or `lovagentic doctor --self-heal`." },
    { key: "playwright", label: `Playwright (${pwStatus.version ?? "not installed"})`, ok: pwStatus.installed, healable: false, hint: pwStatus.installed ? null : "Run `npm install` in the lovagentic repo, or install the npm package." },
    { key: "chromium", label: "Playwright Chromium binary", ok: pwStatus.chromium, healable: true, hint: pwStatus.chromium ? null : "Run `npx playwright install chromium`, or `lovagentic doctor --self-heal`." },
    { key: "lovableApiSdk", label: `Lovable API SDK (@lovable.dev/sdk ${lovableSdkVersion ?? "not installed"})`, ok: Boolean(lovableSdkVersion), healable: false, hint: lovableSdkVersion ? null : "Run `npm install @lovable.dev/sdk` to enable the official API backend scaffold." },
    {
      key: "lovableApiAuth",
      label: api.configured
        ? `Lovable API auth (configured, source: ${api.authSource}${api.authEmail ? `, ${api.authEmail}` : ""}${
            api.authSource === "auth-cache" && api.accessTokenSecondsRemaining != null
              ? `, ${Math.max(0, Math.floor(api.accessTokenSecondsRemaining / 60))}m left`
              : ""
          })`
        : "Lovable API auth (not configured)",
      ok: true,
      healable: !api.configured && desktopCookieFileExists,
      meta: { api, profileDir, desktopProfileDir },
      hint: api.configured
        ? api.authSource === "auth-cache"
          ? `Using cached refresh-token at ${api.authFile}. Run \`lovagentic auth refresh\` to mint a new bearer; install the LaunchAgent (scripts/launchd/install-auth-refresh.sh) for hands-off rotation.`
          : "Official API backend is ready (env credentials)."
        : desktopCookieFileExists
          ? "No Lovable API auth available. Run `lovagentic auth bootstrap` (or `lovagentic doctor --self-heal`) to capture the refresh token from your logged-in desktop session."
          : "No Lovable API auth available. Sign in to Lovable.app first, then run `lovagentic auth bootstrap`."
    },
    {
      key: "lovableAuthRefresh",
      label: api.launchAgentInstalled
        ? "Lovable auth refresh agent (installed)"
        : "Lovable auth refresh agent (not installed)",
      ok: true,
      healable: !api.launchAgentInstalled && process.platform === "darwin",
      meta: { api, platform: process.platform },
      hint: api.launchAgentInstalled
        ? "LaunchAgent rotates the bearer every 50 minutes and rewrites ~/.lovagentic/lovable.env."
        : process.platform === "darwin"
          ? "Run `lovagentic doctor --self-heal` (or `./scripts/launchd/install-auth-refresh.sh` from the repo) to install the LaunchAgent for hands-off token rotation."
          : "Schedule `lovagentic auth refresh --out-env <path>` every ~50 minutes (Linux/CI cron) for hands-off token rotation."
    },
    { key: "lovableReachable", label: `lovable.dev reachable${network.lovable.ms != null ? ` (${network.lovable.ms}ms)` : ""}`, ok: network.lovable.ok, healable: false, hint: network.lovable.ok ? null : `Cannot reach https://lovable.dev (${network.lovable.error ?? "unknown error"}). Check internet connection or corporate proxy.` },
    { key: "npmReachable", label: `npm registry reachable${network.npm.ms != null ? ` (${network.npm.ms}ms)` : ""}`, ok: network.npm.ok, healable: false, hint: network.npm.ok ? null : `Cannot reach registry.npmjs.org (${network.npm.error ?? "unknown error"}). Required for self-update checks.` },
    { key: "mcp", label: `MCP backend (${mcpConfigured ? "configured" : "not configured"})`, ok: true, healable: false, hint: mcpConfigured ? null : "LOVABLE_MCP_URL not set. Using browser/API backend. The CLI's official-API path covers most data flows without an MCP backend." }
  ];

  return { checks, playwrightDefaultDir, api };
}

program
  .command("api")
  .description("Inspect the official Lovable API SDK configuration and optionally validate the API key.")
  .option("--base-url <url>", "Override the Lovable API base URL", "https://api.lovable.dev")
  .option("--validate", "Call the Lovable API with the configured key and report visible workspaces", false)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (options) => {
    const sdkVersion = getInstalledPackageVersion("@lovable.dev/sdk");
    const apiKeyEnv = Boolean(process.env.LOVABLE_API_KEY);
    const bearerEnv = Boolean(process.env.LOVABLE_BEARER_TOKEN);
    let cacheState = null;
    try {
      cacheState = await loadAuthState();
    } catch {
      cacheState = null;
    }
    const cacheUsable = Boolean(cacheState?.refreshToken && cacheState?.firebaseApiKey);
    const configured = apiKeyEnv || bearerEnv || cacheUsable;
    const result = {
      configured,
      apiKeyConfigured: apiKeyEnv,
      bearerTokenConfigured: bearerEnv,
      authCacheConfigured: cacheUsable,
      authSource: apiKeyEnv ? "env-api-key" : bearerEnv ? "env-bearer" : cacheUsable ? "auth-cache" : null,
      baseUrl: options.baseUrl,
      sdkVersion,
      validated: false,
      user: null,
      workspaces: [],
      error: null
    };

    if (options.validate) {
      if (!configured) {
        result.error = "No Lovable auth available. Set LOVABLE_API_KEY/LOVABLE_BEARER_TOKEN or run `lovagentic auth bootstrap`.";
      } else {
        try {
          const { createApiBackend } = await import("./backends/api-backend.js");
          const backend = await createApiBackend({ baseUrl: options.baseUrl });
          const me = await backend.me();
          result.validated = true;
          result.user = {
            id: me.id,
            email: me.email,
            name: me.name
          };
          result.workspaces = (me.workspaces ?? []).map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            role: workspace.role
          }));
        } catch (err) {
          result.error = err?.message || String(err);
        }
      }
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Lovable API SDK: ${sdkVersion ?? "not installed"}`);
      console.log(`API auth: ${configured ? `configured (source: ${result.authSource})` : "not configured"}`);
      console.log(`Base URL: ${options.baseUrl}`);
      if (options.validate) {
        if (result.validated) {
          console.log(`Validated user: ${result.user?.email ?? result.user?.id ?? "unknown"}`);
          console.log(`Workspaces: ${result.workspaces.length}`);
          for (const workspace of result.workspaces) {
            console.log(`  - ${workspace.name} (${workspace.role})`);
          }
        } else {
          console.log(`Validation failed: ${result.error}`);
        }
      } else if (!configured) {
        console.log("Set LOVABLE_API_KEY=lov_... or run `lovagentic auth bootstrap` to enable API-backed flows.");
      }
    }

    if (options.validate && !result.validated) {
      process.exitCode = 1;
    }
  });

function printAuthHuman(summary, extras = {}) {
  if (!summary?.configured) {
    console.log("Auth: not configured");
    console.log("Run `lovagentic auth bootstrap` after logging into Lovable Desktop / `lovagentic login`.");
    return;
  }
  console.log(`Auth: configured (${summary.email || summary.userId || "unknown user"})`);
  if (summary.accessTokenExpiresAt) {
    const seconds = summary.accessTokenSecondsRemaining ?? 0;
    const minutes = Math.floor(Math.max(0, seconds) / 60);
    console.log(
      `Access token expires: ${summary.accessTokenExpiresAt} (${minutes} min, ${seconds}s remaining)`
    );
  }
  console.log(`Refresh token: ${summary.hasRefreshToken ? "present" : "missing"}`);
  console.log(`Firebase API key: ${summary.firebaseApiKey || "unknown"}`);
  if (extras.filePath) console.log(`Auth file: ${extras.filePath}`);
  if (extras.refreshed != null) {
    console.log(`Refreshed this run: ${extras.refreshed ? "yes" : "no"}`);
  }
  if (extras.envFile) console.log(`Env file written: ${extras.envFile}`);
}

const authCmd = program
  .command("auth")
  .description(
    "Manage Lovable API authentication: bootstrap from a logged-in browser profile, refresh, inspect, and export."
  );

authCmd
  .command("bootstrap")
  .description(
    "Extract Firebase auth state from a logged-in browser profile and store it for refresh-driven token rotation."
  )
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--auth-file <path>", "Override the persisted auth file path", AUTH_FILE_PATH)
  .option("--no-headless", "Run the extraction browser visibly")
  .option("--out-env <path>", "Also write a shell-sourceable env file with the new bearer token")
  .option("--json", "Print machine-readable JSON", false)
  .action(async (options) => {
    try {
      const state = await bootstrapFromProfile({
        profileDir: options.profileDir,
        headless: options.headless !== false,
        filePath: options.authFile,
      });
      let envFilePath = null;
      if (options.outEnv) {
        const result = await writeEnvFile(options.outEnv, {
          authFilePath: options.authFile,
          refreshIfNeeded: false,
        });
        envFilePath = result.filePath;
      }
      const summary = summarizeAuthState(state);
      if (options.json) {
        console.log(JSON.stringify({ summary, authFile: options.authFile, envFile: envFilePath }, null, 2));
      } else {
        printAuthHuman(summary, { filePath: options.authFile, envFile: envFilePath, refreshed: true });
      }
    } catch (err) {
      const message = err instanceof AuthError ? err.message : err?.message || String(err);
      console.error(`auth bootstrap failed: ${message}`);
      process.exitCode = 1;
    }
  });

authCmd
  .command("refresh")
  .description("Force a token refresh using the cached refresh token.")
  .option("--auth-file <path>", "Override the persisted auth file path", AUTH_FILE_PATH)
  .option("--out-env <path>", "Also write a shell-sourceable env file after refreshing")
  .option("--json", "Print machine-readable JSON", false)
  .action(async (options) => {
    try {
      const state = await refreshCached({ filePath: options.authFile });
      let envFilePath = null;
      if (options.outEnv) {
        const result = await writeEnvFile(options.outEnv, {
          authFilePath: options.authFile,
          refreshIfNeeded: false,
        });
        envFilePath = result.filePath;
      }
      const summary = summarizeAuthState(state);
      if (options.json) {
        console.log(JSON.stringify({ summary, authFile: options.authFile, envFile: envFilePath }, null, 2));
      } else {
        printAuthHuman(summary, { filePath: options.authFile, envFile: envFilePath, refreshed: true });
      }
    } catch (err) {
      const message = err instanceof AuthError ? err.message : err?.message || String(err);
      console.error(`auth refresh failed: ${message}`);
      process.exitCode = 1;
    }
  });

authCmd
  .command("status")
  .description("Inspect cached auth state. Auto-refreshes only if requested.")
  .option("--auth-file <path>", "Override the persisted auth file path", AUTH_FILE_PATH)
  .option("--auto-refresh", "Refresh the access token if it is near expiry", false)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (options) => {
    try {
      let state = await loadAuthState({ filePath: options.authFile });
      let refreshedThisRun = false;
      if (options.autoRefresh) {
        try {
          const result = await getValidAccessToken({ filePath: options.authFile });
          state = result.state;
          refreshedThisRun = result.refreshed;
        } catch (err) {
          if (!(err instanceof AuthError) || err.code !== "NO_CACHE") throw err;
        }
      }
      const summary = summarizeAuthState(state);
      if (options.json) {
        console.log(JSON.stringify({ summary, authFile: options.authFile, refreshed: refreshedThisRun }, null, 2));
      } else {
        printAuthHuman(summary, { filePath: options.authFile, refreshed: refreshedThisRun });
      }
      if (!summary.configured) process.exitCode = 1;
    } catch (err) {
      const message = err instanceof AuthError ? err.message : err?.message || String(err);
      console.error(`auth status failed: ${message}`);
      process.exitCode = 1;
    }
  });

authCmd
  .command("export")
  .description("Write a shell-sourceable env file with the active bearer/refresh tokens.")
  .argument("<env-file>", "Output path for the env file (e.g. ./.env.lovable)")
  .option("--auth-file <path>", "Override the persisted auth file path", AUTH_FILE_PATH)
  .option("--no-refresh", "Skip auto-refresh; export whatever is on disk")
  .option("--json", "Print machine-readable JSON", false)
  .action(async (envFile, options) => {
    try {
      const result = await writeEnvFile(envFile, {
        authFilePath: options.authFile,
        refreshIfNeeded: options.refresh !== false,
      });
      const summary = summarizeAuthState(result.state);
      if (options.json) {
        console.log(JSON.stringify({ envFile: result.filePath, summary }, null, 2));
      } else {
        printAuthHuman(summary, { filePath: options.authFile, envFile: result.filePath });
      }
    } catch (err) {
      const message = err instanceof AuthError ? err.message : err?.message || String(err);
      console.error(`auth export failed: ${message}`);
      process.exitCode = 1;
    }
  });

authCmd
  .command("clear")
  .description("Delete the cached auth file (next run will need `auth bootstrap` again).")
  .option("--auth-file <path>", "Override the persisted auth file path", AUTH_FILE_PATH)
  .action(async (options) => {
    try {
      await fs.rm(options.authFile, { force: true });
      console.log(`Removed ${options.authFile}`);
    } catch (err) {
      console.error(`auth clear failed: ${err?.message || err}`);
      process.exitCode = 1;
    }
  });

async function runNetworkChecks() {
  const probe = async (url) => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "manual" });
      clearTimeout(timer);
      // 2xx, 3xx, and even 4xx count as reachable (server responded).
      // 5xx and network errors are treated as down.
      return { ok: res.status < 500, ms: Date.now() - started, status: res.status };
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, ms: null, error: err?.name === "AbortError" ? "timeout" : (err?.message?.slice(0, 80) ?? "network error") };
    }
  };
  const [lovable, npm] = await Promise.all([
    probe("https://lovable.dev"),
    probe("https://registry.npmjs.org")
  ]);
  return { lovable, npm };
}

async function selfHealDoctor({ profileDir, desktopProfileDir, checks, json }) {
  const actions = [];
  const log = (msg) => { if (!json) console.log(msg); };

  // Heal Chromium binary.
  const chromiumCheck = checks.find((c) => c.key === "chromium");
  const playwrightInstalled = checks.find((c) => c.key === "playwright")?.ok;
  if (chromiumCheck && !chromiumCheck.ok && playwrightInstalled) {
    log("\u2022 Installing Playwright Chromium...");
    const install = await runChildProcess("npx", ["playwright", "install", "chromium"]);
    actions.push({
      key: "install_chromium",
      label: "Install Playwright Chromium",
      ok: install.ok,
      detail: install.ok ? null : install.error
    });
  }

  // Heal CLI profile / cookies by seeding from desktop session.
  const cliProfileCheck = checks.find((c) => c.key === "cliProfile");
  const cliCookiesCheck = checks.find((c) => c.key === "cliCookies");
  const desktopCookies = checks.find((c) => c.key === "desktopCookies");

  if ((cliProfileCheck && !cliProfileCheck.ok) || (cliCookiesCheck && !cliCookiesCheck.ok)) {
    if (desktopCookies?.ok) {
      log("\u2022 Seeding CLI profile from Lovable desktop session...");
      try {
        const result = await seedDesktopProfileIntoPlaywrightDefault({
          fromDir: desktopProfileDir,
          toDir: profileDir,
          force: false
        });
        actions.push({
          key: "seed_profile",
          label: "Import desktop session into CLI profile",
          ok: true,
          detail: `copied ${result.copied.length} entries to ${result.targetDefaultDir}`
        });
      } catch (err) {
        actions.push({
          key: "seed_profile",
          label: "Import desktop session into CLI profile",
          ok: false,
          detail: err?.message || String(err)
        });
      }
    } else {
      actions.push({
        key: "seed_profile",
        label: "Import desktop session into CLI profile",
        ok: false,
        detail: "Desktop session not available. Sign in to Lovable.app and retry."
      });
    }
  }

  // Heal Lovable API auth: if no env/cache and the user is signed into the
  // desktop app, run `auth bootstrap` against a freshly seeded profile so
  // we have a refresh token on disk. The check itself is always `ok: true`
  // (the API backend has the browser fallback), so we drive the heal
  // exclusively off the `healable` flag instead of `!c.ok`.
  const apiAuthCheck = checks.find((c) => c.key === "lovableApiAuth");
  if (apiAuthCheck && apiAuthCheck.healable) {
    if (desktopCookies?.ok) {
      log("\u2022 Bootstrapping Lovable API auth from desktop session...");
      try {
        const state = await bootstrapFromProfile({
          profileDir,
          headless: true,
        });
        actions.push({
          key: "auth_bootstrap",
          label: "Bootstrap Lovable API auth",
          ok: true,
          detail: `cached refresh token for ${state.email || state.userId} at ~/.lovagentic/auth.json`,
        });
      } catch (err) {
        actions.push({
          key: "auth_bootstrap",
          label: "Bootstrap Lovable API auth",
          ok: false,
          detail: err?.message || String(err),
        });
      }
    } else {
      actions.push({
        key: "auth_bootstrap",
        label: "Bootstrap Lovable API auth",
        ok: false,
        detail: "Desktop session not available. Sign in to Lovable.app and retry.",
      });
    }
  }

  // Heal LaunchAgent (macOS only). Calls scripts/launchd/install-auth-refresh.sh
  // bundled with the repo. We resolve the script via the package directory so
  // it works for `npm i -g`, `npm link`, and direct repo runs. Driven by the
  // `healable` flag so we trigger even though the check reports `ok: true`
  // (the LaunchAgent is optional, not a hard requirement).
  const refreshAgentCheck = checks.find((c) => c.key === "lovableAuthRefresh");
  if (refreshAgentCheck && refreshAgentCheck.healable) {
    if (process.platform !== "darwin") {
      actions.push({
        key: "install_launch_agent",
        label: "Install Lovable auth-refresh LaunchAgent",
        ok: false,
        detail: "LaunchAgent installer is macOS-only. Schedule `lovagentic auth refresh --out-env <path>` via cron / systemd on this OS.",
      });
    } else {
      log("\u2022 Installing Lovable auth-refresh LaunchAgent (macOS)...");
      try {
        const scriptPath = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "..",
          "scripts",
          "launchd",
          "install-auth-refresh.sh"
        );
        const exists = await pathExists(scriptPath);
        if (!exists) {
          actions.push({
            key: "install_launch_agent",
            label: "Install Lovable auth-refresh LaunchAgent",
            ok: false,
            detail: `installer script missing at ${scriptPath}. The LaunchAgent ships with the lovagentic source repo; npm-globally-installed copies include it under <prefix>/lib/node_modules/lovagentic/scripts/launchd/.`,
          });
        } else {
          const install = await runChildProcess("bash", [scriptPath]);
          actions.push({
            key: "install_launch_agent",
            label: "Install Lovable auth-refresh LaunchAgent",
            ok: install.ok,
            detail: install.ok
              ? "LaunchAgent installed at ~/Library/LaunchAgents/com.lovagentic.auth-refresh.plist; runs every 50 minutes plus on login."
              : install.error,
          });
        }
      } catch (err) {
        actions.push({
          key: "install_launch_agent",
          label: "Install Lovable auth-refresh LaunchAgent",
          ok: false,
          detail: err?.message || String(err),
        });
      }
    }
  }

  return actions;
}

async function runChildProcess(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (err) => resolve({ ok: false, error: err?.message || String(err) }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `${command} exited with code ${code}` });
    });
  });
}

async function detectPlaywright() {
  let version = null;
  let installed = false;
  let chromium = false;
  try {
    const mod = await import("playwright");
    installed = true;
    // Best-effort version detection from node_modules/playwright/package.json.
    try {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const pkgPath = require.resolve("playwright/package.json");
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      version = pkg?.version ?? "installed";
    } catch {
      version = "installed";
    }
    try {
      const exec = mod?.chromium?.executablePath?.();
      if (exec) {
        chromium = await pathExists(exec);
      }
    } catch {
      chromium = false;
    }
  } catch {
    installed = false;
  }
  return { installed, chromium, version };
}

program
  .command("init")
  .description("Scaffold a .lovagentic.json config file, prompt templates, and .env.example in the current directory.")
  .option("--project-url <url>", "Lovable project URL to bind to (optional)")
  .option("--dir <path>", "Target directory (defaults to current working directory)", ".")
  .option("--force", "Overwrite existing files", false)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (options) => {
    const targetDir = path.resolve(options.dir);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(targetDir, "prompts"), { recursive: true });

    const files = [];
    const skipped = [];

    const writeFile = async (relPath, content) => {
      const abs = path.join(targetDir, relPath);
      const exists = await pathExists(abs);
      if (exists && !options.force) {
        skipped.push(relPath);
        return false;
      }
      await fs.writeFile(abs, content, "utf8");
      files.push(relPath);
      return true;
    };

    const projectUrl = options.projectUrl || "https://lovable.dev/projects/REPLACE-ME";

    const config = {
      $schema: "https://lovagentic.com/schema/v1.json",
      version: 1,
      projectUrl,
      defaults: {
        headless: false,
        verifyEffect: true,
        timeoutMs: 480000
      },
      prompts: {
        dir: "./prompts"
      },
      ci: {
        autoRetry: false,
        failOnPublishMismatch: true
      }
    };

    await writeFile(".lovagentic.json", JSON.stringify(config, null, 2) + "\n");

    const envExample = [
      "# lovagentic .env.example",
      "# Copy to .env and fill in values. Do NOT commit .env.",
      "",
      "# Optional: override project URL",
      `LOVABLE_PROJECT_URL=${projectUrl}`,
      "",
      "# Optional: official Lovable API backend",
      "# LOVABLE_API_KEY=lov_...",
      "# LOVABLE_API_BASE_URL=https://api.lovable.dev",
      "",
      "# Optional (v0.2+): point lovagentic at an MCP backend",
      "# LOVABLE_MCP_URL=https://mcp.lovable.dev",
      "",
      "# Optional: custom browser profile path",
      "# LOVAGENTIC_PROFILE_DIR=~/.lovagentic/profile",
      ""
    ].join("\n");
    await writeFile(".env.example", envExample);

    const gitignoreEntry = ".env\nlovagentic-screenshots/\n";
    const gitignorePath = path.join(targetDir, ".gitignore");
    const existingGitignore = await pathExists(gitignorePath);
    if (existingGitignore) {
      const cur = await fs.readFile(gitignorePath, "utf8");
      if (!/^\.env$/m.test(cur)) {
        await fs.writeFile(gitignorePath, cur + (cur.endsWith("\n") ? "" : "\n") + gitignoreEntry, "utf8");
        files.push(".gitignore (updated)");
      } else {
        skipped.push(".gitignore (already has .env)");
      }
    } else {
      await writeFile(".gitignore", gitignoreEntry);
    }

    const examplePrompt = [
      "# Example lovagentic prompt",
      "",
      "Save me as prompts/example.md and run:",
      "",
      "```bash",
      "lovagentic prompt \"$LOVABLE_PROJECT_URL\" \\",
      "  --prompt-file ./prompts/example.md \\",
      "  --verify-effect \\",
      "  --headless",
      "```",
      "",
      "---",
      "",
      "Replace this file with a real prompt describing what you want Lovable to build or change.",
      ""
    ].join("\n");
    await writeFile("prompts/example.md", examplePrompt);

    const readme = [
      "# lovagentic project",
      "",
      `Project: ${projectUrl}`,
      "",
      "## Quickstart",
      "",
      "```bash",
      "cp .env.example .env   # then edit",
      "lovagentic doctor      # verify your setup",
      "lovagentic prompt \"$LOVABLE_PROJECT_URL\" \\",
      "  --prompt-file ./prompts/example.md \\",
      "  --verify-effect",
      "```",
      "",
      "See https://lovagentic.com/docs for full docs.",
      ""
    ].join("\n");
    await writeFile("README.md", readme);

    if (options.json) {
      console.log(JSON.stringify({
        ok: true,
        targetDir,
        projectUrl,
        filesCreated: files,
        filesSkipped: skipped
      }, null, 2));
    } else {
      console.log(`✓ Initialized lovagentic project at ${targetDir}`);
      console.log("");
      console.log("Files created:");
      for (const f of files) console.log(`  ✓ ${f}`);
      if (skipped.length > 0) {
        console.log("");
        console.log("Files skipped (already exist, use --force to overwrite):");
        for (const f of skipped) console.log(`  − ${f}`);
      }
      console.log("");
      console.log("Next steps:");
      console.log("  1. cp .env.example .env   # then edit with your project URL");
      console.log("  2. lovagentic doctor      # verify setup");
      console.log("  3. lovagentic prompt \"$LOVABLE_PROJECT_URL\" --prompt-file ./prompts/example.md --verify-effect");
    }
  });

program
  .command("import-desktop-session")
  .description("Copy the desktop app session files into the CLI browser profile.")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--force", "Replace copied profile entries first", false)
  .action(async (options) => {
    const profileDir = getProfileDir(options.profileDir);
    const desktopProfileDir = getDesktopProfileDir(options.desktopProfileDir);

    const result = await seedDesktopProfileIntoPlaywrightDefault({
      fromDir: desktopProfileDir,
      toDir: profileDir,
      force: Boolean(options.force)
    });

    console.log(`Seeded profile: ${profileDir}`);
    console.log(`Seeded Playwright Default: ${result.targetDefaultDir}`);
    console.log(`Copied: ${result.copied.join(", ") || "(none)"}`);
    console.log(`Skipped: ${result.skipped.join(", ") || "(none)"}`);
  });

program
  .command("login")
  .description("Open a persistent browser profile and wait for a Lovable session.")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--base-url <url>", "Override the Lovable base URL", DEFAULT_BASE_URL)
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--timeout-ms <ms>", "How long to wait for a login session", parseInteger, 300000)
  .action(async (options) => {
    const profileDir = getProfileDir(options.profileDir);
    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(options.baseUrl, { waitUntil: "domcontentloaded" });

      if (await hasLovableSession(page)) {
        const users = await readFirebaseAuthUsers(page);
        const user = users.find((entry) => entry?.value?.email)?.value;
        if (user?.email) {
          console.log(`Lovable session already present in ${profileDir} for ${user.email}`);
        } else {
          console.log(`Lovable session already present in ${profileDir}`);
        }
        return;
      }

      if (options.headless) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run the same command without --headless to log in interactively.`
        );
      }

      console.log("Finish the login flow in the opened browser window.");
      const loggedIn = await waitForLovableSession(page, {
        timeoutMs: options.timeoutMs
      });

      if (!loggedIn) {
        throw new Error("Timed out waiting for a Lovable session.");
      }

      const users = await readFirebaseAuthUsers(page);
      const user = users.find((entry) => entry?.value?.email)?.value;
      if (user?.email) {
        console.log(`Lovable session detected in ${profileDir} for ${user.email}`);
      } else {
        console.log(`Lovable session detected in ${profileDir}`);
      }
    } finally {
      await context.close();
    }
  });

program
  .command("list")
  .description("List Lovable dashboard projects plus the visible workspace menu entries.")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--base-url <url>", "Override the Lovable base URL", DEFAULT_BASE_URL)
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--timeout-ms <ms>", "How long to wait for the dashboard feed to load", parseInteger, 20_000)
  .option("--poll-ms <ms>", "Polling interval while waiting for the dashboard feed", parseInteger, 250)
  .option("--page-size <n>", "Pagination size for dashboard project requests", parseInteger, 100)
  .option("--limit <n>", "Limit human-readable rows; JSON output still includes all projects", parseInteger)
  .option("--workspace <id>", "Restrict the API list to a specific workspace id (skips the dashboard wrapper)")
  .option("--all-workspaces", "Aggregate projects across every visible workspace (API backend only)", false)
  .option("--projects-only", "Print just the project list (skip the workspace menu wrapper)", false)
  .option("--sort-by <field>", "Sort projects on the API. last_edited_at | created_at | last_viewed_at", "last_edited_at")
  .option("--sort-order <dir>", "Sort direction: asc or desc", "desc")
  .option("--backend <kind>", "Backend for supported flows: auto, browser, or api", "auto")
  .option("--json", "Print the extracted dashboard state as JSON", false)
  .action(async (options) => {
    const apiBackend = await createApiBackendForCommand(options);
    if (apiBackend) {
      const params = {
        limit: options.pageSize,
        sort_by: options.sortBy,
        sort_order: options.sortOrder
      };
      if (options.workspace) params.workspaceId = options.workspace;

      const result = await apiBackend.listProjects(params);

      if (options.projectsOnly || options.workspace || options.allWorkspaces) {
        // Direct project listing: no dashboard wrapper, just the array Lovable
        // returned, with workspace metadata if available.
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printProjectList(result, { limit: options.limit });
        return;
      }

      const state = buildDashboardStateFromApi(result);
      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }
      printDashboardState(state, {
        limit: options.limit
      });
      return;
    }

    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(options.baseUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const dashboardUrl = new URL("/dashboard", options.baseUrl).toString();
      const state = await getDashboardState(page, {
        dashboardUrl,
        timeoutMs: options.timeoutMs,
        pollMs: options.pollMs,
        pageSize: options.pageSize
      });

      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      printDashboardState(state, {
        limit: options.limit
      });
    } finally {
      await context.close();
    }
  });

program
  .command("create")
  .description("Generate a Lovable Build-with-URL link and optionally open it.")
  .argument("<prompt>", "Prompt for the new Lovable app")
  .option("-i, --image <url>", "Reference image URL", collectValues, [])
  .option("--base-url <url>", "Override the Lovable base URL", DEFAULT_BASE_URL)
  .option("--profile-dir <path>", "Use Playwright automation with this persistent profile")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--workspace <name>", "Workspace name for Lovable auto-submit")
  .option("--workspace-id <id>", "Workspace ID for official API project creation")
  .option("--backend <kind>", "Backend for supported flows: auto, browser, or api", "auto")
  .option("--headless", "Run automated create flow headlessly", false)
  .option("--wait-for-project-ms <ms>", "Wait timeout for project creation", parseInteger, 480000)
  .option("--keep-open", "Leave the browser open after project creation", false)
  .option("--no-open", "Print the URL without opening it")
  .option("--no-autosubmit", "Disable autosubmit in the generated URL")
  .option("--json", "Print machine-readable JSON for API creation", false)
  .action(async (prompt, options) => {
    const apiBackend = options.image.length === 0
      ? await createApiBackendForCommand(options)
      : null;
    if (apiBackend) {
      const workspace = await resolveApiWorkspace(apiBackend, {
        workspaceId: options.workspaceId,
        workspaceName: options.workspace
      });
      const project = await apiBackend.createProject(workspace.id, {
        description: prompt,
        initialMessage: prompt
      });
      let readyProject = project;
      try {
        readyProject = await apiBackend.waitForProjectReady(project.id, {
          timeout: options.waitForProjectMs,
          pollInterval: 2_000
        });
      } catch (err) {
        readyProject = {
          ...project,
          waitError: err?.message || String(err)
        };
      }
      const payload = {
        backend: "api",
        workspace: {
          id: workspace.id,
          name: workspace.name
        },
        project: readyProject,
        projectUrl: buildLovableProjectUrl(project.id),
        previewUrl: apiBackend.getPreviewUrl(project.id)
      };

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Project URL: ${payload.projectUrl}`);
        console.log(`Preview URL: ${payload.previewUrl}`);
        if (readyProject.waitError) {
          console.log(`Project readiness wait: ${readyProject.waitError}`);
        } else {
          console.log(`Project status: ${readyProject.status || "unknown"}`);
        }
      }
      return;
    }
    if (normalizeBackendChoice(options.backend) === "api" && options.image.length > 0) {
      throw new Error("Official API create does not support --image URL references yet. Use --backend browser.");
    }

    const url = buildCreateUrl({
      prompt,
      images: options.image,
      autosubmit: options.autosubmit,
      baseUrl: options.baseUrl
    });

    console.log(url);

    const shouldAutomate = Boolean(options.profileDir || options.headless || options.workspace || options.keepOpen);
    if (shouldAutomate) {
      const profileDir = getProfileDir(options.profileDir);
      if (options.seedDesktopSession) {
        await seedDesktopProfileIntoPlaywrightDefault({
          fromDir: getDesktopProfileDir(options.desktopProfileDir),
          toDir: profileDir,
          force: true
        });
      }
      const context = await launchLovableContext({
        profileDir,
        headless: Boolean(options.headless)
      });

      let keepOpen = Boolean(options.keepOpen);

      try {
        const page = context.pages()[0] || await context.newPage();
        await page.goto(options.baseUrl, { waitUntil: "domcontentloaded" });

        const signedIn = await ensureSignedIn(page);
        if (!signedIn) {
          throw new Error(
            `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
          );
        }

        const result = await runCreateFlow(page, {
          createUrl: url,
          workspace: options.workspace,
          waitForProjectMs: options.waitForProjectMs
        });

        console.log(`Project URL: ${result.projectUrl}`);

        if (keepOpen) {
          console.log("Browser left open for inspection. Press Ctrl+C when done.");
          await new Promise(() => {});
        }
      } finally {
        if (!keepOpen) {
          await context.close();
        }
      }

      return;
    }

    if (!options.open) {
      return;
    }

    await openUrl(url);
    console.log("Opened Lovable creation URL in the system browser.");
  });

program
  .command("mode")
  .description("Switch the Lovable composer between Build and Plan.")
  .argument("<target-url>", "Lovable project URL")
  .argument("<mode>", "Target mode: build or plan")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--keep-open", "Leave the browser window open after switching mode", false)
  .action(async (targetUrl, mode, options) => {
    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    let keepOpen = Boolean(options.keepOpen);

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const result = await setPromptMode(page, { mode });
      console.log(`Lovable mode: ${result.currentMode}`);
      if (result.changed) {
        console.log(`Previous mode: ${result.previousMode || "unknown"}`);
      }

      if (keepOpen) {
        console.log("Browser left open for inspection. Press Ctrl+C when done.");
        await new Promise(() => {});
      }
    } finally {
      if (!keepOpen) {
        await context.close();
      }
    }
  });

program
  .command("prompt")
  .description("Open a Lovable project page in a persistent browser and submit a prompt.")
  .argument("<target-url>", "Lovable project URL")
  .argument("[prompt]", "Optional follow-up prompt")
  .option("--prompt-file <path>", "Read the prompt text from a local file")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--keep-open", "Leave the browser window open after prompt submission", false)
  .option("--mode <mode>", "Switch Lovable to build or plan before sending")
  .option("--backend <kind>", "Backend for supported flows: auto, browser, or api", "auto")
  .option("--dry-run", "Print prompt size, chunking plan, and warnings without opening a browser", false)
  .option("--chunked", "Force multipart prompt delivery even when the prompt might fit in one chunk", false)
  .option("--split-by <mode>", "Split multipart prompts by character count or markdown headings (chars|markdown)")
  .option("--verify", "Capture preview screenshots after the prompt persisted", false)
  .option("--verify-effect", "Poll dashboard metadata until Lovable records an actual edit for the target project", false)
  .option("--verify-timeout-ms <ms>", "How long to wait for editCount / lastEditedAt to advance", parseInteger, 180000)
  .option("--verify-route <path>", "Preview route to inspect after an edit is detected")
  .option("--verify-expect-text <text>", "Required preview text for --verify-effect route checks", collectValues, [])
  .option("--verify-output-dir <path>", "Directory for post-prompt preview screenshots and summary output")
  .option("--verify-desktop-only", "Only capture the desktop preview after the prompt", false)
  .option("--verify-mobile-only", "Only capture the mobile preview after the prompt", false)
  .option("--verify-settle-ms <ms>", "Extra wait time before each post-prompt screenshot", parseInteger, 4000)
  .option("--fail-on-console", "Treat preview console warnings/errors as blocking during verify", false)
  .option("--expect-text <text>", "Assert that preview body text contains this string", collectValues, [])
  .option("--forbid-text <text>", "Assert that preview body text does not contain this string", collectValues, [])
  .option("--file <path>", "Attach a local reference file to the prompt; repeat for multiple files", collectValues, [])
  .option("--no-auto-split", "Send the prompt as a single Lovable message even if it looks too large")
  .option("--allow-fragment", "Send a prompt even if it looks truncated or unfinished", false)
  .option("--answer-question <text>", "If Lovable opens a Questions card after the prompt, answer it with this text")
  .option("--question-option <label>", "Question option label to target before filling free text", "Other")
  .option("--question-timeout-ms <ms>", "How long to wait for a delayed Questions card after the prompt", parseInteger, 8_000)
  .option("--no-wait-for-idle", "Skip waiting for Lovable to become idle before post-prompt verification")
  .option("--auto-resume", "Automatically click Resume queue / Continue queue while waiting for idle", false)
  .option("--idle-timeout-ms <ms>", "How long to wait for Lovable to become idle before verify", parseInteger, DEFAULT_IDLE_TIMEOUT_MS)
  .option("--idle-poll-ms <ms>", "Polling interval while waiting for Lovable to become idle", parseInteger, DEFAULT_IDLE_POLL_MS)
  .option("--selector <selector>", "Override the prompt input selector")
  .option("--submit-selector <selector>", "Override the submit button selector")
  .option("--wait-after-submit-ms <ms>", "Delay before the browser closes", parseInteger, 4000)
  .option("--post-submit-timeout-ms <ms>", "How long to wait for Lovable to acknowledge the prompt", parseInteger, 20000)
  .option(
    "--verification-timeout-ms <ms>",
    "How long to wait for an interactive verification to be completed in a visible browser",
    parseInteger,
    600000
  )
  .action(async (targetUrl, prompt, options) => {
    const promptText = await resolveInitialPrompt({
      prompt,
      promptFile: options.promptFile
    });
    const profileDir = getProfileDir(options.profileDir);
    const attachmentPaths = await resolveAttachmentPaths(options.file);
    if (!hasText(promptText) && attachmentPaths.length === 0) {
      throw new Error("Pass a prompt, --file, or both.");
    }
    if ((options.verifyRoute && options.verifyExpectText.length === 0) ||
      (!options.verifyRoute && options.verifyExpectText.length > 0)) {
      throw new Error("Use --verify-route together with at least one --verify-expect-text value.");
    }

    const promptPlan = hasText(promptText)
      ? planPromptSequence(promptText, {
        autoSplit: Boolean(options.autoSplit),
        chunked: Boolean(options.chunked),
        splitBy: options.splitBy
      })
      : null;

    if (options.dryRun) {
      printPromptDryRun({
        targetUrl,
        prompt: promptText,
        promptPlan,
        attachmentPaths,
        autoSplit: Boolean(options.autoSplit),
        chunked: Boolean(options.chunked),
        splitBy: options.splitBy
      });
      return;
    }

    if (normalizeBackendChoice(options.backend) === "api" && promptOptionsRequireBrowser(options)) {
      throw new Error("This prompt option set requires the browser backend. Remove UI-only flags or use --backend browser.");
    }

    const apiBackend = !promptOptionsRequireBrowser(options)
      ? await createApiBackendForCommand(options)
      : null;
    if (apiBackend) {
      await runApiPromptFlow({
        apiBackend,
        targetUrl,
        promptText,
        attachmentPaths,
        options
      });
      return;
    }

    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }
    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    let keepOpen = Boolean(options.keepOpen);

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const modeResult = await ensurePromptModeReady(page, options.mode);
      if (modeResult?.currentMode) {
        console.log(`Lovable mode ready: ${modeResult.currentMode}`);
      }

      let verifyEffectBaseline = null;
      if (options.verifyEffect) {
        verifyEffectBaseline = await loadDashboardProjectMetadata(context, normalizedUrl);
        if (!verifyEffectBaseline.project) {
          throw new Error("Target project was not found in the Lovable dashboard metadata feed.");
        }

        console.log(
          `Verify-effect baseline: editCount=${verifyEffectBaseline.project.editCount ?? "unknown"} lastEditedAt=${verifyEffectBaseline.project.lastEditedAt || "unknown"}`
        );
      }

      const promptSequence = await runPromptSequence(page, {
        normalizedUrl,
        prompt: promptText,
        attachmentPaths,
        autoSplit: Boolean(options.autoSplit),
        chunked: Boolean(options.chunked),
        splitBy: options.splitBy,
        allowFragment: Boolean(options.allowFragment),
        selector: options.selector,
        submitSelector: options.submitSelector,
        postSubmitTimeoutMs: options.postSubmitTimeoutMs,
        verificationTimeoutMs: options.verificationTimeoutMs,
        headless: Boolean(options.headless),
        questionTimeoutMs: options.questionTimeoutMs,
        autoResume: Boolean(options.autoResume)
      });
      printPromptSequenceLogs(promptSequence);

      const questionState = await getProjectQuestionState(page, {
        timeoutMs: options.questionTimeoutMs,
        pollMs: 250
      });
      if (questionState.open) {
        console.log(`Lovable follow-up question: ${questionState.prompt || "(prompt missing)"}`);
        if (options.answerQuestion) {
          const answerResult = await answerProjectQuestion(page, {
            projectUrl: normalizedUrl,
            answer: options.answerQuestion,
            optionLabel: options.questionOption
          });
          console.log(`Answered question via ${answerResult.fillResult.method} (${answerResult.fillResult.tagName}).`);
          if (answerResult.chatAccepted?.ok) {
            console.log("Lovable accepted the question answer on the server.");
          }
          if (answerResult.stateAfter?.open) {
            console.log("Lovable still shows a question card after the submitted answer.");
          }
        } else {
          console.log("Lovable is waiting for an answer. Use `questions` / `question-answer`, or re-run with --answer-question.");
        }
      }

      if (options.verifyEffect) {
        const verifyEffect = await verifyPromptEffect({
          context,
          page,
          normalizedUrl,
          baseline: verifyEffectBaseline.project,
          lookup: verifyEffectBaseline.lookup,
          timeoutMs: options.verifyTimeoutMs,
          route: options.verifyRoute,
          expectText: options.verifyExpectText,
          settleMs: options.verifySettleMs
        });
        printVerifyEffectResult(verifyEffect);
        if (!verifyEffect.detected) {
          throw new Error(formatVerifyEffectError(verifyEffect));
        }
      }

      if (options.verify) {
        await ensureProjectIdleOrThrow(page, {
          normalizedUrl,
          waitForIdle: Boolean(options.waitForIdle),
          autoResume: Boolean(options.autoResume),
          timeoutMs: options.idleTimeoutMs,
          pollMs: options.idlePollMs,
          contextLabel: "post-prompt verification"
        });
        const verification = await runPreviewVerification({
          page,
          normalizedUrl,
          outputDir: resolveVerifyOutputDir(normalizedUrl, options.verifyOutputDir),
          headless: true,
          settleMs: options.verifySettleMs,
          variants: getVerifyVariants({
            desktopOnly: options.verifyDesktopOnly,
            mobileOnly: options.verifyMobileOnly
          }),
          failOnConsole: Boolean(options.failOnConsole),
          expectText: options.expectText,
          forbidText: options.forbidText,
          sourceLabel: "Post-prompt preview"
        });
        console.log(`Post-prompt verification summary: ${verification.summaryPath}`);
      }

      if (keepOpen) {
        console.log("Browser left open for inspection. Press Ctrl+C when done.");
        await new Promise(() => {});
      } else {
        await page.waitForTimeout(options.waitAfterSubmitMs);
      }
    } finally {
      if (!keepOpen) {
        await context.close();
      }
    }
  });

program
  .command("actions")
  .description("List visible chat-side Lovable actions near the composer, such as plan approvals.")
  .argument("<target-url>", "Lovable project URL")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--timeout-ms <ms>", "How long to wait for visible chat-side actions", parseInteger, 5_000)
  .option("--poll-ms <ms>", "Polling interval while waiting for visible chat-side actions", parseInteger, 250)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const actions = await listChatActions(page, {
        timeoutMs: options.timeoutMs,
        pollMs: options.pollMs
      });

      if (options.json) {
        console.log(JSON.stringify(actions, null, 2));
        return;
      }

      printChatActions(actions);
    } finally {
      await context.close();
    }
  });

program
  .command("action")
  .description("Click a visible chat-side Lovable action button, such as Approve or Verify it works.")
  .argument("<target-url>", "Lovable project URL")
  .argument("<label>", "Visible action label or aria-label")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--keep-open", "Leave the browser window open after clicking", false)
  .option("--exact", "Require an exact case-insensitive label match", false)
  .option("--index <n>", "Zero-based match index if more than one action label matches", parseInteger, 0)
  .option("--timeout-ms <ms>", "How long to wait for the action click", parseInteger, 15_000)
  .option("--actions-timeout-ms <ms>", "How long to wait for visible chat-side actions before and after the click", parseInteger, 5_000)
  .option("--actions-poll-ms <ms>", "Polling interval while waiting for visible chat-side actions", parseInteger, 250)
  .option("--settle-ms <ms>", "Extra wait time after the click before reading the page again", parseInteger, 1_500)
  .action(async (targetUrl, label, options) => {
    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    const keepOpen = Boolean(options.keepOpen);

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const result = await clickChatAction(page, {
        label,
        exact: Boolean(options.exact),
        matchIndex: options.index,
        timeoutMs: options.timeoutMs,
        settleMs: options.settleMs,
        actionsTimeoutMs: options.actionsTimeoutMs,
        actionsPollMs: options.actionsPollMs
      });

      console.log(`Clicked chat action: ${result.clicked.label}`);

      if (result.actionsAfterClick.length > 0) {
        console.log(`Visible chat actions now: ${result.actionsAfterClick.map((action) => action.label).join(", ")}`);
      } else {
        console.log("No visible chat-side actions remain after the click.");
      }

      if (keepOpen) {
        console.log("Browser left open for inspection. Press Ctrl+C when done.");
        await new Promise(() => {});
      }
    } finally {
      if (!keepOpen) {
        await context.close();
      }
    }
  });

program
  .command("questions")
  .description("Read the visible Lovable Questions card, including its current prompt and footer actions.")
  .argument("<target-url>", "Lovable project URL")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--timeout-ms <ms>", "How long to wait for the Questions card", parseInteger, 5_000)
  .option("--poll-ms <ms>", "Polling interval while waiting for the Questions card", parseInteger, 250)
  .option("--json", "Print the extracted Questions card state as JSON", false)
  .action(async (targetUrl, options) => {
    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const state = await getProjectQuestionState(page, {
        timeoutMs: options.timeoutMs,
        pollMs: options.pollMs
      });

      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      printQuestionState(state);
    } finally {
      await context.close();
    }
  });

program
  .command("question-action")
  .description("Click a visible Lovable Questions-card action, such as Skip, Submit, or Next question.")
  .argument("<target-url>", "Lovable project URL")
  .argument("<label>", "Visible question action label or aria-label")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--exact", "Require an exact case-insensitive label match", false)
  .option("--index <n>", "Zero-based match index if more than one question action label matches", parseInteger, 0)
  .option("--timeout-ms <ms>", "How long to wait for the question action click", parseInteger, 15_000)
  .option("--actions-timeout-ms <ms>", "How long to wait for visible question actions before and after the click", parseInteger, 5_000)
  .option("--actions-poll-ms <ms>", "Polling interval while waiting for visible question actions", parseInteger, 250)
  .option("--settle-ms <ms>", "Extra wait time after the click before reading the question card again", parseInteger, 1_500)
  .action(async (targetUrl, label, options) => {
    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const result = await clickQuestionAction(page, {
        label,
        exact: Boolean(options.exact),
        matchIndex: options.index,
        timeoutMs: options.timeoutMs,
        settleMs: options.settleMs,
        actionsTimeoutMs: options.actionsTimeoutMs,
        actionsPollMs: options.actionsPollMs
      });

      console.log(`Clicked question action: ${result.clicked.label}`);
      printQuestionState(result.stateAfterClick);
    } finally {
      await context.close();
    }
  });

program
  .command("question-answer")
  .description("Fill the visible Lovable Questions-card free-text field and optionally submit it.")
  .argument("<target-url>", "Lovable project URL")
  .argument("<answer>", "Answer text for the current free-text question")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--option <label>", "Question option label to target before filling free text", "Other")
  .option("--file <path>", "Attach a local reference file before filling the answer; repeat for multiple files", collectValues, [])
  .option("--timeout-ms <ms>", "How long to wait for the question field", parseInteger, 15_000)
  .option("--settle-ms <ms>", "Extra wait time after clicking Submit", parseInteger, 1_500)
  .option("--actions-timeout-ms <ms>", "How long to wait for the question card before and after submit", parseInteger, 5_000)
  .option("--actions-poll-ms <ms>", "Polling interval while waiting for the question card", parseInteger, 250)
  .option("--chat-accept-timeout-ms <ms>", "How long to wait for Lovable to accept the answer on the server", parseInteger, 30_000)
  .option("--no-submit", "Only fill the free-text field; do not click Submit")
  .action(async (targetUrl, answer, options) => {
    const profileDir = getProfileDir(options.profileDir);
    const attachmentPaths = await resolveAttachmentPaths(options.file);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const result = await answerProjectQuestion(page, {
        projectUrl: normalizedUrl,
        answer,
        attachmentPaths,
        optionLabel: options.option,
        submit: Boolean(options.submit),
        timeoutMs: options.timeoutMs,
        settleMs: options.settleMs,
        actionsTimeoutMs: options.actionsTimeoutMs,
        actionsPollMs: options.actionsPollMs,
        chatAcceptTimeoutMs: options.chatAcceptTimeoutMs
      });

      console.log(`Filled question via ${result.fillResult.method} (${result.fillResult.tagName}).`);
      if (result.attachmentResult?.uploaded?.length > 0) {
        console.log(`Attached before answer: ${result.attachmentResult.uploaded.join(", ")}.`);
      }
      if (options.submit) {
        console.log("Submitted the question answer.");
        if (result.chatAccepted?.ok) {
          console.log("Lovable accepted the question answer on the server.");
        } else {
          const statusSuffix = result.chatAccepted?.status ? ` Last chat status: ${result.chatAccepted.status}.` : "";
          console.log(`Lovable did not confirm the question answer on the server.${statusSuffix}`);
        }
      }
      printQuestionState(result.stateAfter);
    } finally {
      await context.close();
    }
  });

program
  .command("attachments")
  .description("Inspect the Lovable composer attachment state and optionally upload local files without sending.")
  .argument("<target-url>", "Lovable project URL")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--file <path>", "Attach a local reference file without sending the chat message; repeat for multiple files", collectValues, [])
  .option("--timeout-ms <ms>", "How long to wait for attachment chips to appear", parseInteger, 15_000)
  .option("--poll-ms <ms>", "Polling interval while waiting for attachment chips", parseInteger, 250)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    await withProjectPageSession(targetUrl, options, async ({ page }) => {
      const attachmentPaths = await resolveAttachmentPaths(options.file);
      let uploadResult = null;
      if (attachmentPaths.length > 0) {
        uploadResult = await uploadPromptAttachments(page, attachmentPaths, {
          timeoutMs: options.timeoutMs,
          pollMs: options.pollMs
        });
      }

      const state = await getPromptAttachmentState(page);
      const payload = {
        uploaded: uploadResult?.uploaded || [],
        state
      };

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (payload.uploaded.length > 0) {
        console.log(`Uploaded attachments: ${payload.uploaded.join(", ")}`);
      }
      printPromptAttachmentState(state);
    });
  });

program
  .command("errors")
  .description("Read the visible Lovable runtime/build error surface, including Try to fix and Show logs.")
  .argument("<target-url>", "Lovable project URL")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--timeout-ms <ms>", "How long to wait for the runtime error surface", parseInteger, 8_000)
  .option("--poll-ms <ms>", "Polling interval while waiting for the runtime error surface", parseInteger, 250)
  .option("--json", "Print the extracted runtime error state as JSON", false)
  .action(async (targetUrl, options) => {
    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const state = await getProjectRuntimeErrorState(page, {
        timeoutMs: options.timeoutMs,
        pollMs: options.pollMs
      });

      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      printRuntimeErrorState(state);
    } finally {
      await context.close();
    }
  });

program
  .command("error-action")
  .description("Click a visible Lovable runtime/build error action, such as Try to fix or Show logs.")
  .argument("<target-url>", "Lovable project URL")
  .argument("<label>", "Visible runtime error action label")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--exact", "Require an exact case-insensitive label match", false)
  .option("--index <n>", "Zero-based match index if more than one runtime error action label matches", parseInteger, 0)
  .option("--timeout-ms <ms>", "How long to wait for the error action click", parseInteger, 15_000)
  .option("--actions-timeout-ms <ms>", "How long to wait for visible runtime error actions before and after the click", parseInteger, 8_000)
  .option("--actions-poll-ms <ms>", "Polling interval while waiting for visible runtime error actions", parseInteger, 250)
  .option("--settle-ms <ms>", "Extra wait time after the click before reading the page again", parseInteger, 1_500)
  .option("--chat-accept-timeout-ms <ms>", "How long to wait for Lovable to accept a Try to fix recovery request on the server", parseInteger, 30_000)
  .action(async (targetUrl, label, options) => {
    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const shouldExpectRecoveryChat = /try to fix|fix|repair/i.test(label);
      const recoveryAcceptance = shouldExpectRecoveryChat
        ? waitForChatAcceptance(page, {
          projectUrl: normalizedUrl,
          timeoutMs: options.chatAcceptTimeoutMs
        })
        : null;

      const result = await clickRuntimeErrorAction(page, {
        label,
        exact: Boolean(options.exact),
        matchIndex: options.index,
        timeoutMs: options.timeoutMs,
        settleMs: options.settleMs,
        actionsTimeoutMs: options.actionsTimeoutMs,
        actionsPollMs: options.actionsPollMs
      });

      console.log(`Clicked runtime error action: ${result.clicked.label}`);

      if (recoveryAcceptance) {
        const accepted = await recoveryAcceptance;
        if (accepted.ok) {
          console.log("Lovable accepted the recovery request on the server.");
        } else {
          const statusSuffix = accepted.status ? ` Last chat status: ${accepted.status}.` : "";
          console.log(`Lovable did not confirm a recovery chat request on the server.${statusSuffix}`);
        }
      }

      printRuntimeErrorState(result.stateAfterClick);
    } finally {
      await context.close();
    }
  });

program
  .command("findings")
  .description("Open Lovable's inline Security findings pane and extract the visible issues.")
  .argument("<target-url>", "Lovable project URL")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--keep-open", "Leave the browser window open after extraction", false)
  .option("--current-only", "Only read the current page state; do not click View findings automatically", false)
  .option("--timeout-ms <ms>", "How long to wait for the findings pane", parseInteger, 15_000)
  .option("--poll-ms <ms>", "Polling interval while waiting for the findings pane", parseInteger, 250)
  .option("--settle-ms <ms>", "Extra wait time after clicking View findings", parseInteger, 1_500)
  .option("--actions-timeout-ms <ms>", "How long to wait for the surrounding chat-side actions", parseInteger, 5_000)
  .option("--actions-poll-ms <ms>", "Polling interval while waiting for surrounding chat-side actions", parseInteger, 250)
  .option("--json", "Print the extracted findings as JSON", false)
  .action(async (targetUrl, options) => {
    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    const keepOpen = Boolean(options.keepOpen);

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const findings = await getProjectFindingsState(page, {
        openIfNeeded: !Boolean(options.currentOnly),
        timeoutMs: options.timeoutMs,
        pollMs: options.pollMs,
        settleMs: options.settleMs,
        actionsTimeoutMs: options.actionsTimeoutMs,
        actionsPollMs: options.actionsPollMs
      });

      if (options.json) {
        console.log(JSON.stringify(findings, null, 2));
      } else {
        printFindingsState(findings);
      }

      if (keepOpen) {
        console.log("Browser left open for inspection. Press Ctrl+C when done.");
        await new Promise(() => {});
      }
    } finally {
      if (!keepOpen) {
        await context.close();
      }
    }
  });

program
  .command("chat-loop")
  .description("Optionally send a prompt, then list and click visible Lovable chat-side actions, and optionally verify.")
  .argument("<target-url>", "Lovable project URL")
  .argument("[prompt]", "Optional follow-up prompt to send before processing actions")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--keep-open", "Leave the browser window open after the loop completes", false)
  .option("--mode <mode>", "Switch Lovable to build or plan before sending")
  .option("--action <label>", "Click this visible chat-side action after the prompt", collectValues, [])
  .option("--exact-action", "Require exact case-insensitive matching for --action labels", false)
  .option("--action-index <n>", "Zero-based match index if more than one action label matches", parseInteger, 0)
  .option("--wait-for-actions-ms <ms>", "How long to wait for visible chat-side actions between loop steps", parseInteger, 10_000)
  .option("--action-poll-ms <ms>", "Polling interval while waiting for visible chat-side actions", parseInteger, 250)
  .option("--action-settle-ms <ms>", "Extra wait time after each action click before reading again", parseInteger, 1_500)
  .option("--selector <selector>", "Override the prompt input selector")
  .option("--submit-selector <selector>", "Override the submit button selector")
  .option("--post-submit-timeout-ms <ms>", "How long to wait for Lovable to acknowledge the prompt", parseInteger, 20_000)
  .option(
    "--verification-timeout-ms <ms>",
    "How long to wait for an interactive verification to be completed in a visible browser",
    parseInteger,
    600_000
  )
  .option("--verify", "Capture preview screenshots after the loop completes", false)
  .option("--verify-output-dir <path>", "Directory for post-loop preview screenshots and summary output")
  .option("--verify-desktop-only", "Only capture the desktop preview after the loop", false)
  .option("--verify-mobile-only", "Only capture the mobile preview after the loop", false)
  .option("--verify-settle-ms <ms>", "Extra wait time before each post-loop screenshot", parseInteger, 4_000)
  .option("--fail-on-console", "Treat preview console warnings/errors as blocking during verify", false)
  .option("--expect-text <text>", "Assert that preview body text contains this string", collectValues, [])
  .option("--forbid-text <text>", "Assert that preview body text does not contain this string", collectValues, [])
  .option("--file <path>", "Attach a local reference file to the prompt; repeat for multiple files", collectValues, [])
  .option("--no-auto-split", "Send the prompt as a single Lovable message even if it looks too large")
  .option("--allow-fragment", "Send a prompt even if it looks truncated or unfinished", false)
  .option("--answer-question <text>", "If Lovable opens a Questions card after the prompt, answer it with this text")
  .option("--question-option <label>", "Question option label to target before filling free text", "Other")
  .option("--question-timeout-ms <ms>", "How long to wait for a delayed Questions card after the prompt", parseInteger, 8_000)
  .option("--no-wait-for-idle", "Skip waiting for Lovable to become idle before post-loop verification")
  .option("--auto-resume", "Automatically click Resume queue / Continue queue while waiting for idle", false)
  .option("--idle-timeout-ms <ms>", "How long to wait for Lovable to become idle before verify", parseInteger, DEFAULT_IDLE_TIMEOUT_MS)
  .option("--idle-poll-ms <ms>", "Polling interval while waiting for Lovable to become idle", parseInteger, DEFAULT_IDLE_POLL_MS)
  .option("--wait-after-loop-ms <ms>", "Delay before the browser closes after the loop", parseInteger, 4_000)
  .action(async (targetUrl, prompt, options) => {
    const profileDir = getProfileDir(options.profileDir);
    const attachmentPaths = await resolveAttachmentPaths(options.file);
    const hasPromptOrAttachments = hasText(prompt) || attachmentPaths.length > 0;
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    const keepOpen = Boolean(options.keepOpen);

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const modeResult = await ensurePromptModeReady(page, options.mode);
      if (modeResult?.currentMode) {
        console.log(`Lovable mode ready: ${modeResult.currentMode}`);
      }

      let currentActions = [];
      if (hasPromptOrAttachments) {
        const baselineActions = await listChatActions(page, {
          timeoutMs: Math.min(options.waitForActionsMs, 1_000),
          pollMs: options.actionPollMs
        }).catch(() => []);

        const promptSequence = await runPromptSequence(page, {
          normalizedUrl,
          prompt,
          attachmentPaths,
          autoSplit: Boolean(options.autoSplit),
          allowFragment: Boolean(options.allowFragment),
          selector: options.selector,
          submitSelector: options.submitSelector,
          postSubmitTimeoutMs: options.postSubmitTimeoutMs,
          verificationTimeoutMs: options.verificationTimeoutMs,
          headless: Boolean(options.headless),
          questionTimeoutMs: options.questionTimeoutMs,
          autoResume: Boolean(options.autoResume)
        });
        printPromptSequenceLogs(promptSequence);

        const questionState = await getProjectQuestionState(page, {
          timeoutMs: options.questionTimeoutMs,
          pollMs: 250
        });

        if (questionState.open) {
          console.log(`Lovable follow-up question: ${questionState.prompt || "(prompt missing)"}`);
          if (options.answerQuestion) {
            const answerResult = await answerProjectQuestion(page, {
              projectUrl: normalizedUrl,
              answer: options.answerQuestion,
              optionLabel: options.questionOption
            });
            console.log(`Answered question via ${answerResult.fillResult.method} (${answerResult.fillResult.tagName}).`);
            if (answerResult.chatAccepted?.ok) {
              console.log("Lovable accepted the question answer on the server.");
            }
            currentActions = await waitForChangedChatActions(page, {
              previousActions: baselineActions,
              timeoutMs: options.waitForActionsMs,
              pollMs: options.actionPollMs
            });
          } else {
            if (options.action.length > 0) {
              throw new Error(
                "Lovable asked a follow-up question before the requested action(s) could run. Re-run with --answer-question or use question-answer."
              );
            }
            currentActions = [];
          }
        } else {
          currentActions = await waitForChangedChatActions(page, {
            previousActions: baselineActions,
            timeoutMs: options.waitForActionsMs,
            pollMs: options.actionPollMs
          });
        }
      } else {
        currentActions = await listChatActions(page, {
          timeoutMs: options.waitForActionsMs,
          pollMs: options.actionPollMs
        });
      }

      printChatActions(currentActions);

      for (let index = 0; index < options.action.length; index += 1) {
        const requestedAction = options.action[index];
        const result = await clickChatAction(page, {
          label: requestedAction,
          exact: Boolean(options.exactAction),
          matchIndex: options.actionIndex,
          timeoutMs: Math.max(15_000, options.waitForActionsMs),
          settleMs: options.actionSettleMs,
          actionsTimeoutMs: options.waitForActionsMs,
          actionsPollMs: options.actionPollMs
        });

        console.log(`Clicked chat action ${index + 1}/${options.action.length}: ${result.clicked.label}`);
        currentActions = result.actionsAfterClick;
        printChatActions(currentActions);
      }

      if (options.verify) {
        await ensureProjectIdleOrThrow(page, {
          normalizedUrl,
          waitForIdle: Boolean(options.waitForIdle),
          autoResume: Boolean(options.autoResume),
          timeoutMs: options.idleTimeoutMs,
          pollMs: options.idlePollMs,
          contextLabel: "post-loop verification"
        });
        const verification = await runPreviewVerification({
          page,
          normalizedUrl,
          outputDir: resolveVerifyOutputDir(normalizedUrl, options.verifyOutputDir),
          headless: true,
          settleMs: options.verifySettleMs,
          variants: getVerifyVariants({
            desktopOnly: options.verifyDesktopOnly,
            mobileOnly: options.verifyMobileOnly
          }),
          failOnConsole: Boolean(options.failOnConsole),
          expectText: options.expectText,
          forbidText: options.forbidText,
          sourceLabel: "Post-loop preview"
        });
        console.log(`Post-loop verification summary: ${verification.summaryPath}`);
      }

      if (keepOpen) {
        console.log("Browser left open for inspection. Press Ctrl+C when done.");
        await new Promise(() => {});
      } else {
        await page.waitForTimeout(options.waitAfterLoopMs);
      }
    } finally {
      if (!keepOpen) {
        await context.close();
      }
    }
  });

program
  .command("publish")
  .description("Publish a Lovable project and wait for the live URL to respond.")
  .argument("<target-url>", "Lovable project URL")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--keep-open", "Leave the browser window open after publishing", false)
  .option("--backend <kind>", "Backend for supported flows: auto, browser, or api", "auto")
  .option("--timeout-ms <ms>", "How long to wait for Lovable to finish publishing", parseInteger, 420000)
  .option("--live-url-timeout-ms <ms>", "How long to wait for the live site URL to return success", parseInteger, 300000)
  .option("--poll-ms <ms>", "Polling interval while waiting for the live site", parseInteger, 3000)
  .option("--verify-live", "Capture screenshots and summary output against the published live URL", false)
  .option("--verify-output-dir <path>", "Directory for post-publish live screenshots and summary output")
  .option("--verify-desktop-only", "Only capture the desktop live site", false)
  .option("--verify-mobile-only", "Only capture the mobile live site", false)
  .option("--verify-settle-ms <ms>", "Extra wait time before each live-site screenshot", parseInteger, 4000)
  .option("--fail-on-console", "Treat live-site console warnings/errors as blocking during verify", false)
  .option("--expect-text <text>", "Assert that live-site body text contains this string", collectValues, [])
  .option("--forbid-text <text>", "Assert that live-site body text does not contain this string", collectValues, [])
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    const json = Boolean(options.json);
    const log = (msg) => { if (!json) console.log(msg); };
    if (normalizeBackendChoice(options.backend) === "api" && options.keepOpen) {
      throw new Error("--keep-open requires the browser backend. Use --backend browser or remove --keep-open.");
    }

    const apiBackend = !options.keepOpen
      ? await createApiBackendForCommand(options)
      : null;
    if (apiBackend) {
      const { normalizedUrl, projectId } = getProjectIdFromUrl(targetUrl);
      const deployment = await apiBackend.publish(projectId);
      const project = await apiBackend.waitForProjectPublished(projectId, {
        timeout: options.timeoutMs,
        pollInterval: options.pollMs
      });
      const liveUrl = project.url || deployment.url || null;
      const liveCheck = liveUrl ? await probePreviewUrl(liveUrl) : null;
      let verificationSummaryPath = null;

      if (options.verifyLive) {
        if (!liveUrl) {
          throw new Error("Lovable API publish completed without a live URL; cannot run --verify-live.");
        }
        const verification = await runUrlVerification({
          targetUrl: normalizedUrl,
          captureUrl: liveUrl,
          outputDir: resolveLiveVerifyOutputDir(normalizedUrl, options.verifyOutputDir),
          headless: true,
          settleMs: options.verifySettleMs,
          variants: getVerifyVariants({
            desktopOnly: options.verifyDesktopOnly,
            mobileOnly: options.verifyMobileOnly
          }),
          failOnConsole: Boolean(options.failOnConsole),
          expectText: options.expectText,
          forbidText: options.forbidText,
          sourceLabel: "API live site",
          summarySourceKey: "liveSource"
        });
        verificationSummaryPath = verification.summaryPath;
      }

      const payload = {
        ok: true,
        backend: "api",
        alreadyPublished: false,
        updatedExisting: false,
        siteInfoUpdated: false,
        deploymentId: deployment.deployment_id ?? null,
        liveUrl,
        liveCheck,
        verificationSummaryPath
      };

      if (json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        log("Lovable API completed the publish flow.");
        if (payload.deploymentId) log(`Deployment ID: ${payload.deploymentId}`);
        if (payload.liveUrl) log(`Live URL: ${payload.liveUrl}`);
        if (payload.liveCheck?.status) log(`Live URL status: ${payload.liveCheck.status}`);
        if (verificationSummaryPath) log(`Live verification summary: ${verificationSummaryPath}`);
      }
      return;
    }

    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    let keepOpen = Boolean(options.keepOpen);
    let verificationSummaryPath = null;

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const result = await publishProject(page, {
        timeoutMs: options.timeoutMs,
        liveUrlTimeoutMs: options.liveUrlTimeoutMs,
        pollMs: options.pollMs
      });

      if (result.alreadyPublished) {
        log("Project is already published.");
      } else if (result.updatedExisting) {
        log("Lovable updated the published site.");
      } else {
        log("Lovable completed the publish flow.");
        if (result.siteInfoUpdated) {
          log("Lovable auto-updated the site metadata in index.html because the website info step was incomplete.");
        }
      }

      if (result.deploymentId) {
        log(`Deployment ID: ${result.deploymentId}`);
      }

      if (result.liveUrl) {
        log(`Live URL: ${result.liveUrl}`);
      }

      if (result.liveCheck?.status) {
        log(`Live URL status: ${result.liveCheck.status}`);
      } else if (result.liveCheck?.error) {
        log(`Live URL probe error: ${result.liveCheck.error}`);
      }

      if (options.verifyLive) {
        const verification = await runUrlVerification({
          targetUrl: normalizedUrl,
          captureUrl: result.liveUrl,
          outputDir: resolveLiveVerifyOutputDir(normalizedUrl, options.verifyOutputDir),
          headless: true,
          settleMs: options.verifySettleMs,
          variants: getVerifyVariants({
            desktopOnly: options.verifyDesktopOnly,
            mobileOnly: options.verifyMobileOnly
          }),
          failOnConsole: Boolean(options.failOnConsole),
          expectText: options.expectText,
          forbidText: options.forbidText,
          sourceLabel: "Live site",
          summarySourceKey: "liveSource"
        });
        verificationSummaryPath = verification.summaryPath;
        log(`Live verification summary: ${verification.summaryPath}`);
      }

      if (json) {
        console.log(JSON.stringify({
          ok: true,
          alreadyPublished: Boolean(result.alreadyPublished),
          updatedExisting: Boolean(result.updatedExisting),
          siteInfoUpdated: Boolean(result.siteInfoUpdated),
          deploymentId: result.deploymentId ?? null,
          liveUrl: result.liveUrl ?? null,
          liveCheck: result.liveCheck ?? null,
          verificationSummaryPath
        }, null, 2));
      }

      if (keepOpen) {
        log("Browser left open for inspection. Press Ctrl+C when done.");
        await new Promise(() => {});
      }
    } finally {
      if (!keepOpen) {
        await context.close();
      }
    }
  });

program
  .command("publish-settings")
  .description("Inspect or update published visibility and website info.")
  .argument("<target-url>", "Lovable project URL")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--timeout-ms <ms>", "How long to wait for the settings surfaces", parseInteger, 90_000)
  .option("--visibility <scope>", "Set publish visibility (public, workspace, selected)")
  .option("--title <text>", "Set the published website title")
  .option("--description <text>", "Set the published website description")
  .action(async (targetUrl, options) => {
    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const context = await launchLovableContext({
      profileDir,
      headless: Boolean(options.headless)
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      const hasRequestedChanges = options.visibility !== undefined ||
        options.title !== undefined ||
        options.description !== undefined;

      const result = hasRequestedChanges
        ? await updatePublishedSettings(page, {
          projectUrl: normalizedUrl,
          visibility: options.visibility,
          title: options.title,
          description: options.description,
          timeoutMs: options.timeoutMs
        })
        : {
          changes: [],
          state: await getPublishedSettingsState(page, {
            projectUrl: normalizedUrl,
            timeoutMs: options.timeoutMs
          })
        };

      if (result.changes.length > 0) {
        console.log(`Updated publish settings: ${result.changes.join(", ")}`);
      } else {
        console.log("No publish setting changes requested.");
      }

      printPublishedSettingsState(result.state);
    } finally {
      await context.close();
    }
  });

program
  .command("domain")
  .description("Inspect or update the published project domain settings.")
  .argument("<target-url>", "Lovable project URL")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--timeout-ms <ms>", "How long to wait for the domain settings page", parseInteger, 120_000)
  .option("--live-url-timeout-ms <ms>", "How long to wait for the updated live URL to return success", parseInteger, 300_000)
  .option("--poll-ms <ms>", "Polling interval while waiting for the updated live URL", parseInteger, 3000)
  .option("--subdomain <slug>", "Update the default .lovable.app subdomain")
  .option("--connect <fqdn>", "Connect a custom domain like example.com or www.example.com")
  .option("--advanced", "Open the advanced section in the custom-domain dialog before submitting", false)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    await withProjectPageSession(targetUrl, options, async ({ page, normalizedUrl }) => {
      let subdomainResult = null;
      let connectResult = null;
      let state = null;

      if (options.subdomain) {
        subdomainResult = await updateProjectSubdomain(page, {
          projectUrl: normalizedUrl,
          subdomain: options.subdomain,
          timeoutMs: options.timeoutMs,
          liveUrlTimeoutMs: options.liveUrlTimeoutMs,
          pollMs: options.pollMs
        });
        state = subdomainResult.finalState;
      }

      if (options.connect) {
        connectResult = await connectProjectDomain(page, {
          projectUrl: normalizedUrl,
          domain: options.connect,
          advanced: Boolean(options.advanced),
          timeoutMs: options.timeoutMs
        });
        state = connectResult.finalState;
      }

      if (!state) {
        state = await getProjectDomainSettingsState(page, {
          projectUrl: normalizedUrl,
          timeoutMs: options.timeoutMs
        });
      }

      const payload = {
        state,
        subdomainResult,
        connectResult
      };

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (subdomainResult) {
        if (subdomainResult.changed) {
          console.log(`Updated project subdomain to ${subdomainResult.finalState.subdomain}.`);
        } else {
          console.log(`Project already uses the ${subdomainResult.finalState.subdomain} subdomain.`);
        }

        if (subdomainResult.liveUrl) {
          console.log(`Live URL: ${subdomainResult.liveUrl}`);
        }

        if (subdomainResult.liveCheck?.status) {
          console.log(`Live URL status: ${subdomainResult.liveCheck.status}`);
        } else if (subdomainResult.liveCheck?.error) {
          console.log(`Live URL probe error: ${subdomainResult.liveCheck.error}`);
        }
      }

      if (connectResult) {
        console.log(
          connectResult.changed
            ? `Connected custom domain: ${options.connect}`
            : `Custom domain already connected: ${options.connect}`
        );
      }

      printDomainSettingsState(state);
    });
  });

program
  .command("toolbar")
  .description("Inspect visible project toolbar buttons and optionally open their menus.")
  .argument("<target-url>", "Lovable project URL")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--menu <label>", "Open a specific toolbar menu button by visible label", collectValues, [])
  .option("--timeout-ms <ms>", "How long to wait for toolbar menus and buttons", parseInteger, 20_000)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    await withProjectPageSession(targetUrl, options, async ({ page, normalizedUrl }) => {
      const state = await getProjectToolbarState(page, {
        projectUrl: normalizedUrl,
        menus: options.menu,
        timeoutMs: options.timeoutMs
      });

      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      printToolbarState(state);
    });
  });

addProjectSessionOptions(
  program
    .command("project-settings")
    .description("Inspect or update low-risk project settings like visibility, category, badge visibility, analytics, and rename.")
    .argument("<target-url>", "Lovable project URL")
)
  .option("--timeout-ms <ms>", "How long to wait for the project settings page", parseInteger, 90_000)
  .option("--visibility <scope>", "Set project visibility (public, workspace, restricted-business)")
  .option("--category <name>", "Set project category")
  .option("--hide-lovable-badge <state>", "Set Hide Lovable badge to true/false")
  .option("--disable-analytics <state>", "Set Disable analytics to true/false")
  .option("--rename <name>", "Rename the project")
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    await withProjectPageSession(targetUrl, options, async ({ page, normalizedUrl }) => {
      const requestedHideBadge = options.hideLovableBadge === undefined
        ? undefined
        : parseBooleanish(options.hideLovableBadge, "--hide-lovable-badge");
      const requestedDisableAnalytics = options.disableAnalytics === undefined
        ? undefined
        : parseBooleanish(options.disableAnalytics, "--disable-analytics");

      const hasRequestedChanges = options.visibility !== undefined ||
        options.category !== undefined ||
        requestedHideBadge !== undefined ||
        requestedDisableAnalytics !== undefined ||
        options.rename !== undefined;

      const result = hasRequestedChanges
        ? await updateProjectSettings(page, {
          projectUrl: normalizedUrl,
          visibility: options.visibility,
          category: options.category,
          hideLovableBadge: requestedHideBadge,
          disableAnalytics: requestedDisableAnalytics,
          rename: options.rename,
          timeoutMs: options.timeoutMs
        })
        : {
          changes: [],
          state: await getProjectSettingsState(page, {
            projectUrl: normalizedUrl,
            timeoutMs: options.timeoutMs
          })
        };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.changes.length > 0) {
        console.log(`Updated project settings: ${result.changes.join(", ")}`);
      } else {
        console.log("No project setting changes requested.");
      }

      printProjectSettingsState(result.state);
    });
  });

addProjectSessionOptions(
  program
    .command("knowledge")
    .description("Inspect or update project and workspace knowledge.")
    .argument("<target-url>", "Lovable project URL")
)
  .option("--timeout-ms <ms>", "How long to wait for the knowledge settings page", parseInteger, 90_000)
  .option("--project-text <text>", "Set the project knowledge text")
  .option("--workspace-text <text>", "Set the workspace knowledge text")
  .option("--backend <kind>", "Backend for supported flows: auto, browser, or api", "auto")
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    const apiBackend = await createApiBackendForCommand(options);
    if (apiBackend) {
      const result = await buildApiKnowledgeResult(apiBackend, targetUrl, options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.changes.length > 0) {
        console.log(`Updated knowledge via API: ${result.changes.join(", ")}`);
      } else {
        console.log("No knowledge changes requested.");
      }
      printKnowledgeState(result.state);
      return;
    }

    await withProjectPageSession(targetUrl, options, async ({ page, normalizedUrl }) => {
      const hasRequestedChanges = options.projectText !== undefined || options.workspaceText !== undefined;
      const result = hasRequestedChanges
        ? await updateProjectKnowledge(page, {
          projectUrl: normalizedUrl,
          projectText: options.projectText,
          workspaceText: options.workspaceText,
          timeoutMs: options.timeoutMs
        })
        : {
          changes: [],
          state: await getProjectKnowledgeState(page, {
            projectUrl: normalizedUrl,
            timeoutMs: options.timeoutMs
          })
        };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.changes.length > 0) {
        console.log(`Updated knowledge: ${result.changes.join(", ")}`);
      } else {
        console.log("No knowledge changes requested.");
      }

      printKnowledgeState(result.state);
    });
  });

addProjectSessionOptions(
  program
    .command("workspace")
    .description("Inspect workspace and account settings surfaces without mutating them.")
    .argument("<target-url>", "Lovable project URL")
)
  .option("--section <name>", "Workspace settings section to inspect", "all")
  .option("--timeout-ms <ms>", "How long to wait for each workspace settings page", parseInteger, 90_000)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    await withProjectPageSession(targetUrl, options, async ({ page, normalizedUrl }) => {
      const state = await getWorkspaceSettingsState(page, {
        projectUrl: normalizedUrl,
        section: options.section,
        timeoutMs: options.timeoutMs
      });

      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      printWorkspaceState(state);
    });
  });

addProjectSessionOptions(
  program
    .command("git")
    .description("Inspect or manage the project's Git/GitHub connection.")
    .argument("<target-url>", "Lovable project URL")
)
  .option("--provider <name>", "Git provider to inspect", "github")
  .option("--timeout-ms <ms>", "How long to wait for the git settings flow", parseInteger, 90_000)
  .option("--connect", "Connect the provider for this project", false)
  .option("--disconnect", "Disconnect the provider for this project", false)
  .option("--reconnect", "Reconnect the provider for this project", false)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    await withProjectPageSession(targetUrl, options, async ({ page, normalizedUrl, headless }) => {
      const actionFlags = [options.connect, options.disconnect, options.reconnect].filter(Boolean).length;
      if (actionFlags > 1) {
        throw new Error("Choose only one git action at a time: --connect, --disconnect, or --reconnect.");
      }

      let result = null;
      if (options.connect) {
        result = await connectProjectGitProvider(page, {
          projectUrl: normalizedUrl,
          provider: options.provider,
          timeoutMs: options.timeoutMs,
          headless
        });
      } else if (options.disconnect) {
        result = await disconnectProjectGitProvider(page, {
          projectUrl: normalizedUrl,
          provider: options.provider,
          timeoutMs: options.timeoutMs
        });
      } else if (options.reconnect) {
        result = await reconnectProjectGitProvider(page, {
          projectUrl: normalizedUrl,
          provider: options.provider,
          timeoutMs: options.timeoutMs,
          headless
        });
      } else {
        result = {
          changed: false,
          state: await getProjectGitState(page, {
            projectUrl: normalizedUrl,
            provider: options.provider,
            timeoutMs: options.timeoutMs
          })
        };
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (options.connect) {
        console.log(result.changed ? "Connected the git provider." : "Git provider was already connected.");
      } else if (options.disconnect) {
        console.log(result.changed ? "Disconnected the git provider." : "Git provider was already disconnected.");
      } else if (options.reconnect) {
        console.log("Reconnected the git provider.");
      }

      printGitState(result.state);
    });
  });

addProjectSessionOptions(
  program
    .command("status")
    .description("Read dashboard metadata, git status, and preview reachability for a Lovable project.")
    .argument("<target-url>", "Lovable project URL")
)
  .option("--provider <name>", "Git provider to inspect", "github")
  .option("--timeout-ms <ms>", "How long to wait for git and preview surfaces", parseInteger, 60_000)
  .option("--dashboard-timeout-ms <ms>", "How long to wait for the dashboard project feed", parseInteger, 20_000)
  .option("--dashboard-poll-ms <ms>", "Polling interval while waiting for the dashboard feed", parseInteger, 250)
  .option("--page-size <n>", "Pagination size for dashboard project requests", parseInteger, 100)
  .option("--backend <kind>", "Backend for supported flows: auto, browser, or api", "auto")
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    const apiBackend = await createApiBackendForCommand(options);
    if (apiBackend) {
      const state = await buildApiStatusState(apiBackend, targetUrl, {
        provider: options.provider
      });
      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }
      printProjectStatusState(state);
      return;
    }

    await withProjectPageSession(targetUrl, options, async ({ context, page, normalizedUrl }) => {
      const projectId = normalizedUrl.match(/\/projects\/([^/?#]+)/)?.[1] || null;
      if (!projectId) {
        throw new Error("Expected a Lovable project URL.");
      }

      const dashboardState = await loadDashboardProjectMetadata(context, normalizedUrl, {
        timeoutMs: options.dashboardTimeoutMs,
        pollMs: options.dashboardPollMs,
        pageSize: options.pageSize
      });
      const project = dashboardState.project;
      if (!project) {
        throw new Error("Target project was not found in the Lovable dashboard metadata feed.");
      }

      let gitState = null;
      let gitError = null;
      try {
        gitState = await getProjectGitState(page, {
          projectUrl: normalizedUrl,
          provider: options.provider,
          timeoutMs: options.timeoutMs
        });
      } catch (err) {
        gitError = err?.message || String(err);
      }

      let previewInfo = null;
      let previewRootUrl = null;
      let previewHead = null;
      let previewError = null;
      try {
        previewInfo = await getProjectPreviewInfo(page, {
          timeoutMs: Math.min(options.timeoutMs, 15_000)
        });
        previewRootUrl = buildPreviewRouteUrl(previewInfo.src, "/");
        previewHead = await probePreviewUrl(previewRootUrl);
      } catch (err) {
        previewError = err?.message || String(err);
      }

      const state = {
        projectUrl: normalizedUrl,
        projectId,
        title: project.title,
        slug: project.slug,
        workspaceName: project.workspaceName || null,
        editCount: project.editCount,
        lastEditedAt: project.lastEditedAt,
        updatedAt: project.updatedAt,
        lastViewedAt: project.lastViewedAt,
        published: project.published,
        liveUrl: project.liveUrl || null,
        git: gitState
          ? {
              connected: gitState.connected,
              repository: gitState.repository,
              branch: gitState.branch,
              provider: gitState.provider,
              error: null
            }
          : {
              connected: false,
              repository: null,
              branch: null,
              provider: options.provider,
              error: gitError
            },
        preview: previewInfo
          ? {
              sourceUrl: redactPreviewUrl(previewInfo.src),
              rootUrl: redactPreviewUrl(previewRootUrl),
              headStatus: previewHead.status,
              headOk: previewHead.ok,
              finalUrl: previewHead.finalUrl ? redactPreviewUrl(previewHead.finalUrl) : null,
              routeCountDetected: null,
              error: null
            }
          : {
              sourceUrl: null,
              rootUrl: null,
              headStatus: null,
              headOk: false,
              finalUrl: null,
              routeCountDetected: null,
              error: previewError
            }
      };

      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      printProjectStatusState(state);
    });
  });

addProjectSessionOptions(
  program
    .command("code")
    .description("Read the connected GitHub repository as a pragmatic Code-surface fallback.")
    .argument("<target-url>", "Lovable project URL")
)
  .option("--provider <name>", "Git provider to inspect before reading code", "github")
  .option("--file <path>", "Read a specific file from the connected repository")
  .option("--search <query>", "Search code in the connected repository")
  .option("--download", "Write the requested file content to disk; requires --file", false)
  .option("--output-path <path>", "Where to write the downloaded file content")
  .option("--limit <n>", "Limit tree or search output", parseInteger, 200)
  .option("--backend <kind>", "Backend for supported flows: auto, browser, or api", "auto")
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    const backendChoice = normalizeBackendChoice(options.backend);
    const apiBackend = (!options.search || backendChoice === "api")
      ? await createApiBackendForCommand(options)
      : null;
    if (apiBackend) {
      const state = await buildCodeStateFromApi({
        apiBackend,
        targetUrl,
        filePath: options.file,
        searchQuery: options.search,
        limit: options.limit,
        download: Boolean(options.download),
        outputPath: options.outputPath
      });
      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }
      printCodeState(state);
      return;
    }

    await withProjectPageSession(targetUrl, options, async ({ page, normalizedUrl }) => {
      const gitState = await getProjectGitState(page, {
        projectUrl: normalizedUrl,
        provider: options.provider,
        timeoutMs: 60_000
      });

      if (!gitState.connected || !gitState.repository) {
        throw new Error("Code inspection requires a connected GitHub repository in Lovable.");
      }

      if (String(options.provider || "github").trim().toLowerCase() !== "github") {
        throw new Error("The current code reader only supports GitHub-connected projects.");
      }

      const state = await buildCodeStateFromGitConnection({
        gitState,
        filePath: options.file,
        searchQuery: options.search,
        limit: options.limit,
        download: Boolean(options.download),
        outputPath: options.outputPath
      });

      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      printCodeState(state);
    });
  });

program
  .command("snapshot")
  .description("Capture an API-backed project snapshot: project state, URLs, knowledge, files, and edit history.")
  .argument("<target-url>", "Lovable project URL or project id")
  .option("--backend <kind>", "Backend for this flow: api only", "api")
  .option("--ref <ref>", "Git ref for file listing/content (defaults to latest commit or HEAD)")
  .option("--max-files <n>", "Maximum files to include in the file tree", parseInteger, 500)
  .option("--max-edits <n>", "Maximum edits to include", parseInteger, 50)
  .option("--no-files", "Skip project file listing")
  .option("--file-content", "Include text file contents for listed non-binary files", false)
  .option("--no-knowledge", "Skip project and workspace knowledge")
  .option("--no-edits", "Skip edit history")
  .option("--no-database", "Skip the database status probe")
  .option("--mcp", "Include workspace MCP servers/connectors/catalog", false)
  .option("--output <path>", "Write the full snapshot JSON to this path")
  .option("--json", "Print the full snapshot JSON", false)
  .action(async (targetUrl, options) => {
    const apiBackend = await requireApiBackendForCommand(options, "snapshot");
    const snapshot = await buildApiSnapshot(apiBackend, targetUrl, {
      ref: options.ref,
      maxFiles: options.maxFiles,
      maxEdits: options.maxEdits,
      files: Boolean(options.files),
      fileContent: Boolean(options.fileContent),
      knowledge: Boolean(options.knowledge),
      edits: Boolean(options.edits),
      database: Boolean(options.database),
      mcp: Boolean(options.mcp)
    });

    let outputPath = null;
    if (options.output) {
      outputPath = await writeJsonFile(options.output, snapshot);
    }

    if (options.json) {
      console.log(JSON.stringify({
        ...snapshot,
        outputPath
      }, null, 2));
      return;
    }

    console.log(formatSnapshotSummary(snapshot));
    if (outputPath) {
      console.log(`Output: ${outputPath}`);
    }
    if (snapshot.warnings.length > 0) {
      console.log("");
      console.log("Warnings:");
      for (const warning of snapshot.warnings) {
        console.log(`  - ${warning}`);
      }
    }
  });

program
  .command("diff")
  .description("Read an API-backed Lovable git diff for a message, commit, or latest edit.")
  .argument("<target-url>", "Lovable project URL or project id")
  .option("--backend <kind>", "Backend for this flow: api only", "api")
  .option("--message-id <id>", "Message id to diff")
  .option("--sha <sha>", "Commit sha to diff")
  .option("--base-sha <sha>", "Optional base commit sha")
  .option("--latest", "Resolve the latest edit and diff it", false)
  .option("--output <path>", "Write the full diff JSON to this path")
  .option("--json", "Print the full diff JSON", false)
  .action(async (targetUrl, options) => {
    const apiBackend = await requireApiBackendForCommand(options, "diff");
    const diffState = await buildApiDiff(apiBackend, targetUrl, {
      messageId: options.messageId,
      sha: options.sha,
      baseSha: options.baseSha,
      latest: Boolean(options.latest)
    });

    let outputPath = null;
    if (options.output) {
      outputPath = await writeJsonFile(options.output, diffState);
    }

    if (options.json) {
      console.log(JSON.stringify({
        ...diffState,
        outputPath
      }, null, 2));
      return;
    }

    console.log(formatDiffSummary(diffState));
    if (outputPath) {
      console.log(`Output: ${outputPath}`);
    }
  });

program
  .command("runbook")
  .description("Run a YAML/JSON Lovable orchestration plan: snapshot, prompt, wait, verify, diff, publish.")
  .argument("<file>", "Runbook YAML or JSON file")
  .option("--project-url <url>", "Override the project URL from the runbook")
  .option("--output-dir <path>", "Override the runbook output directory")
  .option("--backend <kind>", "Backend for API-backed runbook steps: api, auto, or browser", "api")
  .option("--dry-run", "Validate and print the runbook plan without executing it", false)
  .option("--continue-on-error", "Continue after failed steps and report all failures", false)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (file, options) => {
    const runbookPath = path.resolve(file);
    const raw = await fs.readFile(runbookPath, "utf8");
    const parsed = parseRunbookText(raw, runbookPath);
    const runbook = normalizeRunbook(parsed, {
      projectUrl: options.projectUrl,
      outputDir: options.outputDir ? path.resolve(options.outputDir) : undefined,
      backend: options.backend
    });
    const plan = getRunbookPlan(runbook);

    if (options.dryRun) {
      if (options.json) {
        console.log(JSON.stringify({ ok: true, dryRun: true, plan }, null, 2));
      } else {
        printRunbookPlan(plan);
      }
      return;
    }

    const apiBackend = await requireApiBackendForCommand(runbook, "runbook");
    const result = await executeRunbook({
      apiBackend,
      runbook,
      runbookPath,
      continueOnError: Boolean(options.continueOnError),
      quiet: Boolean(options.json)
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }

    printRunbookResult(result);
    if (!result.ok) {
      process.exitCode = 1;
    }
  });

addProjectSessionOptions(
  program
    .command("wait-for-idle")
    .description("Wait until Lovable is idle: no Thinking state, no paused queue, no open questions, and no visible runtime error.")
    .argument("<target-url>", "Lovable project URL")
)
  .option("--timeout-ms <ms>", "How long to wait for Lovable to become idle", parseInteger, DEFAULT_IDLE_TIMEOUT_MS)
  .option("--poll-ms <ms>", "Polling interval while waiting for Lovable to become idle", parseInteger, DEFAULT_IDLE_POLL_MS)
  .option("--auto-resume", "Automatically click Resume queue / Continue queue while waiting for idle", false)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    await withProjectPageSession(targetUrl, options, async ({ page, normalizedUrl }) => {
      const result = await waitForProjectIdle(page, {
        timeoutMs: options.timeoutMs,
        pollMs: options.pollMs,
        autoResume: Boolean(options.autoResume)
      });

      if (options.json) {
        console.log(JSON.stringify({
          projectUrl: normalizedUrl,
          ...result
        }, null, 2));
      } else {
        printIdleWaitResult({
          projectUrl: normalizedUrl,
          ...result
        });
      }

      if (!result.ok) {
        throw new Error(formatIdleWaitError(result, {
          contextLabel: "wait-for-idle"
        }));
      }
    });
  });

addProjectSessionOptions(
  program
    .command("speed")
    .description("Run Lighthouse against the current project preview as a pragmatic Speed-surface fallback.")
  .argument("<target-url>", "Lovable project URL")
)
  .option("--device <name>", "Audit desktop, mobile, or both", "both")
  .option("--output-dir <path>", "Directory for Lighthouse JSON reports")
  .option("--no-wait-for-idle", "Skip waiting for Lovable to become idle before the audit")
  .option("--auto-resume", "Automatically click Resume queue / Continue queue while waiting for idle", false)
  .option("--idle-timeout-ms <ms>", "How long to wait for Lovable to become idle before the audit", parseInteger, DEFAULT_IDLE_TIMEOUT_MS)
  .option("--idle-poll-ms <ms>", "Polling interval while waiting for Lovable to become idle", parseInteger, DEFAULT_IDLE_POLL_MS)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
    await withProjectPageSession(targetUrl, options, async ({ page, normalizedUrl }) => {
      const idleResult = await ensureProjectIdleOrThrow(page, {
        normalizedUrl,
        waitForIdle: Boolean(options.waitForIdle),
        autoResume: Boolean(options.autoResume),
        timeoutMs: options.idleTimeoutMs,
        pollMs: options.idlePollMs,
        contextLabel: "speed audit"
      });
      const previewInfo = await getProjectPreviewInfo(page);
      const devices = getSpeedDevices(options.device);
      const outputDir = resolveSpeedOutputDir(normalizedUrl, options.outputDir);
      await fs.mkdir(outputDir, { recursive: true });

      const audits = [];
      for (const device of devices) {
        audits.push(await runLighthouseAudit(previewInfo.src, {
          device,
          outputDir
        }));
      }

      const state = {
        projectUrl: normalizedUrl,
        source: "lighthouse-preview",
        previewUrl: redactPreviewUrl(previewInfo.src),
        idle: idleResult,
        audits
      };

      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      printSpeedState(state);
    });
  });

addProjectSessionOptions(
  program
    .command("fidelity-loop")
    .description("Iteratively prompt, wait for idle, verify expectations, and send follow-up prompts for remaining gaps.")
    .argument("<target-url>", "Lovable project URL")
    .argument("[prompt]", "Optional initial prompt")
)
  .option("--prompt-file <path>", "Read the initial prompt from a local file")
  .option("--mode <mode>", "Switch Lovable to build or plan before sending prompts")
  .option("--expect-text <text>", "Assert that preview body text contains this string", collectValues, [])
  .option("--forbid-text <text>", "Assert that preview body text does not contain this string", collectValues, [])
  .option("--expect-file <path>", "Read required preview assertions from a file, one per non-empty line")
  .option("--forbid-file <path>", "Read forbidden preview assertions from a file, one per non-empty line")
  .option("--max-iterations <n>", "Maximum prompt/verify iterations before stopping", parseInteger, 3)
  .option("--output-dir <path>", "Directory for iteration summaries and screenshots")
  .option("--desktop-only", "Only capture the desktop preview", false)
  .option("--mobile-only", "Only capture the mobile preview", false)
  .option("--settle-ms <ms>", "Extra wait time before each screenshot", parseInteger, 4000)
  .option("--fail-on-console", "Treat preview console warnings/errors as blocking", false)
  .option("--file <path>", "Attach a local reference file to the initial prompt; repeat for multiple files", collectValues, [])
  .option("--no-auto-split", "Send prompts as single Lovable messages even if they look too large")
  .option("--allow-fragment", "Send prompts even if they look truncated or unfinished", false)
  .option("--auto-resume", "Automatically click Resume queue / Continue queue while waiting for idle", false)
  .option("--idle-timeout-ms <ms>", "How long to wait for Lovable to become idle before each verification", parseInteger, DEFAULT_IDLE_TIMEOUT_MS)
  .option("--idle-poll-ms <ms>", "Polling interval while waiting for Lovable to become idle", parseInteger, DEFAULT_IDLE_POLL_MS)
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, prompt, options) => {
    await withProjectPageSession(targetUrl, options, async ({ page, normalizedUrl, headless }) => {
      const initialPrompt = await resolveInitialPrompt({
        prompt,
        promptFile: options.promptFile
      });
      const attachmentPaths = await resolveAttachmentPaths(options.file);
      const expectText = await resolveAssertionValues({
        values: options.expectText,
        filePath: options.expectFile
      });
      const forbidText = await resolveAssertionValues({
        values: options.forbidText,
        filePath: options.forbidFile
      });

      if (expectText.length === 0 && forbidText.length === 0) {
        throw new Error("fidelity-loop requires at least one --expect-text/--expect-file or --forbid-text/--forbid-file assertion.");
      }

      const modeResult = await ensurePromptModeReady(page, options.mode);
      if (modeResult?.currentMode) {
        console.log(`Lovable mode ready: ${modeResult.currentMode}`);
      }

      const variants = getVerifyVariants({
        desktopOnly: options.desktopOnly,
        mobileOnly: options.mobileOnly
      });
      const outputDir = resolveFidelityOutputDir(normalizedUrl, options.outputDir);
      await fs.mkdir(outputDir, { recursive: true });

      const result = {
        projectUrl: normalizedUrl,
        expectText,
        forbidText,
        maxIterations: options.maxIterations,
        iterations: [],
        success: false,
        outputDir
      };

      let nextPrompt = initialPrompt;
      for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
        const iterationLabel = `iteration ${iteration}/${options.maxIterations}`;
        const iterationDir = path.join(outputDir, `iteration-${iteration}`);
        let promptSequence = null;
        const shouldSendTurn = hasText(nextPrompt) || (iteration === 1 && attachmentPaths.length > 0);

        if (shouldSendTurn) {
          promptSequence = await runPromptSequence(page, {
            normalizedUrl,
            prompt: nextPrompt || "",
            attachmentPaths: iteration === 1 ? attachmentPaths : [],
            autoSplit: Boolean(options.autoSplit),
            allowFragment: Boolean(options.allowFragment),
            postSubmitTimeoutMs: 20_000,
            verificationTimeoutMs: 600_000,
            headless,
            questionTimeoutMs: 8_000,
            autoResume: Boolean(options.autoResume)
          });
          printPromptSequenceLogs(promptSequence, {
            prefix: `Fidelity ${iterationLabel}`
          });
        }

        const idleResult = await ensureProjectIdleOrThrow(page, {
          normalizedUrl,
          waitForIdle: true,
          autoResume: Boolean(options.autoResume),
          timeoutMs: options.idleTimeoutMs,
          pollMs: options.idlePollMs,
          contextLabel: `fidelity ${iterationLabel}`
        });

        const verification = await runPreviewVerification({
          page,
          normalizedUrl,
          outputDir: iterationDir,
          headless: true,
          settleMs: options.settleMs,
          variants,
          failOnConsole: Boolean(options.failOnConsole),
          expectText,
          forbidText,
          sourceLabel: `Fidelity ${iterationLabel}`,
          throwOnBlocking: false
        });

        const gaps = extractFidelityGaps(verification.summary);
        result.iterations.push({
          iteration,
          promptSequence,
          idle: idleResult,
          summaryPath: verification.summaryPath,
          blocking: verification.summary.blocking || null,
          gaps
        });

        if (!verification.summary.blocking) {
          result.success = true;
          result.finalSummaryPath = verification.summaryPath;
          break;
        }

        if (
          gaps.missingExpectedTexts.length === 0 &&
          gaps.forbiddenTextsFound.length === 0
        ) {
          throw new Error(
            `Fidelity ${iterationLabel} failed for a non-text reason (${verification.summary.blocking.reason}). See ${verification.summaryPath}.`
          );
        }

        if (iteration >= options.maxIterations) {
          result.finalSummaryPath = verification.summaryPath;
          break;
        }

        nextPrompt = buildFidelityFollowUpPrompt(gaps);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printFidelityLoopResult(result);
      }

      if (!result.success) {
        const lastIteration = result.iterations[result.iterations.length - 1];
        const summarySuffix = lastIteration?.summaryPath ? ` See ${lastIteration.summaryPath}.` : "";
        const missing = lastIteration?.gaps?.missingExpectedTexts || [];
        const forbidden = lastIteration?.gaps?.forbiddenTextsFound || [];
        throw new Error(
          `Fidelity loop stopped with remaining gaps. Missing: ${missing.join(", ") || "(none)"}; forbidden: ${forbidden.join(", ") || "(none)"}.${summarySuffix}`
        );
      }
    });
  });

program
  .command("verify")
  .description("Capture desktop and mobile screenshots of the live project preview.")
  .argument("<target-url>", "Lovable project URL")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--output-dir <path>", "Directory for preview screenshots and summary output")
  .option("--desktop-only", "Only capture the desktop preview", false)
  .option("--mobile-only", "Only capture the mobile preview", false)
  .option("--route <path>", "Capture a specific preview route; repeat for multiple routes", collectValues, [])
  .option("--headed", "Run the extraction and preview captures visibly", false)
  .option("--no-wait-for-idle", "Skip waiting for Lovable to become idle before preview capture")
  .option("--auto-resume", "Automatically click Resume queue / Continue queue while waiting for idle", false)
  .option("--idle-timeout-ms <ms>", "How long to wait for Lovable to become idle before preview capture", parseInteger, DEFAULT_IDLE_TIMEOUT_MS)
  .option("--idle-poll-ms <ms>", "Polling interval while waiting for Lovable to become idle", parseInteger, DEFAULT_IDLE_POLL_MS)
  .option("--settle-ms <ms>", "Extra wait time before each screenshot", parseInteger, 4000)
  .option("--fail-on-console", "Treat preview console warnings/errors as blocking", false)
  .option("--expect-text <text>", "Assert that preview body text contains this string", collectValues, [])
  .option("--forbid-text <text>", "Assert that preview body text does not contain this string", collectValues, [])
  .option("--authenticated", "Reuse the Lovable browser profile when capturing previews so unpublished/private routes render (defaults to anonymous)", false)
  .option("--json", "Print machine-readable JSON with summary path and results", false)
  .action(async (targetUrl, options) => {
    const json = Boolean(options.json);
    const profileDir = getProfileDir(options.profileDir);
    if (options.seedDesktopSession) {
      await seedDesktopProfileIntoPlaywrightDefault({
        fromDir: getDesktopProfileDir(options.desktopProfileDir),
        toDir: profileDir,
        force: true
      });
    }

    const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
    const outputDir = resolveVerifyOutputDir(normalizedUrl, options.outputDir);
    const headless = !Boolean(options.headed);
    const variants = getVerifyVariants({
      desktopOnly: options.desktopOnly,
      mobileOnly: options.mobileOnly
    });

    const context = await launchLovableContext({
      profileDir,
      headless
    });

    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

      const hasSession = await hasLovableSession(page);
      if (!hasSession) {
        throw new Error(
          `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
        );
      }

      await ensureProjectIdleOrThrow(page, {
        normalizedUrl,
        waitForIdle: Boolean(options.waitForIdle),
        autoResume: Boolean(options.autoResume),
        timeoutMs: options.idleTimeoutMs,
        pollMs: options.idlePollMs,
        contextLabel: "preview verification"
      });

      // When --authenticated is requested, close the dashboard context first so
      // the preview capture can open its own persistent context against the
      // same profile directory without locking conflicts.
      let previewProfileDir = null;
      if (options.authenticated) {
        previewProfileDir = profileDir;
        await context.close();
      }

      const verification = await runPreviewVerification({
        page: options.authenticated ? null : page,
        normalizedUrl,
        outputDir,
        headless,
        settleMs: options.settleMs,
        variants,
        failOnConsole: Boolean(options.failOnConsole),
        expectText: options.expectText,
        forbidText: options.forbidText,
        routes: getVerificationRoutes(options.route),
        explicitRoutes: Array.isArray(options.route) && options.route.length > 0,
        sourceLabel: "Preview",
        profileDir: previewProfileDir,
        precomputedPreviewInfo: options.authenticated
          ? { src: `https://${normalizedUrl.match(/\/projects\/([^/?#]+)/)?.[1]}.lovableproject.com/` }
          : null
      });

      if (json) {
        console.log(JSON.stringify({
          ok: !verification?.summary?.blocking,
          summaryPath: verification?.summaryPath ?? null,
          summary: verification?.summary ?? null,
          outputDir
        }, null, 2));
      }
    } finally {
      if (!options.authenticated) {
        await context.close();
      }
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

function addProjectSessionOptions(command) {
  return command
    .option("--profile-dir <path>", "Override the CLI browser profile path")
    .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
    .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
    .option("--headless", "Run headlessly instead of opening a visible browser", false);
}

function addBackendOption(command) {
  return command.option("--backend <kind>", "Backend for supported flows: auto, browser, or api", "auto");
}

async function withProjectPageSession(targetUrl, options, callback) {
  const profileDir = getProfileDir(options.profileDir);
  if (options.seedDesktopSession) {
    await seedDesktopProfileIntoPlaywrightDefault({
      fromDir: getDesktopProfileDir(options.desktopProfileDir),
      toDir: profileDir,
      force: true
    });
  }

  const context = await launchLovableContext({
    profileDir,
    headless: Boolean(options.headless)
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
    await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });

    const hasSession = await hasLovableSession(page);
    if (!hasSession) {
      throw new Error(
        `No Lovable session found in ${profileDir}. Run "lovagentic login" or "lovagentic import-desktop-session" first.`
      );
    }

    return await callback({
      context,
      page,
      normalizedUrl,
      profileDir,
      headless: Boolean(options.headless)
    });
  } finally {
    await context.close();
  }
}

function normalizeBackendChoice(value = "auto") {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (!["auto", "browser", "api"].includes(normalized)) {
    throw new Error(`Unsupported backend "${value}". Use auto, browser, or api.`);
  }
  return normalized;
}

// `auto` backend should pick the official API whenever any usable credential
// exists, including a refresh-token cache produced by `lovagentic auth
// bootstrap`. We avoid awaiting auth.json reads here because this is called
// frequently and synchronously; instead we do a cheap fs check and trust the
// API backend to return a useful error if the cache is invalid.
function hasOfficialApiAuth() {
  if (process.env.LOVABLE_API_KEY || process.env.LOVABLE_BEARER_TOKEN) {
    return true;
  }
  try {
    const stat = statSync(AUTH_FILE_PATH);
    if (stat?.isFile()) return true;
  } catch {
    // ignore
  }
  return false;
}

async function createApiBackendForCommand(options = {}) {
  const backend = normalizeBackendChoice(options.backend);
  if (backend === "browser") {
    return null;
  }
  if (backend === "auto" && !hasOfficialApiAuth()) {
    return null;
  }

  try {
    const { createApiBackend } = await import("./backends/api-backend.js");
    return await createApiBackend();
  } catch (err) {
    if (backend === "api") {
      throw err;
    }
    return null;
  }
}

async function requireApiBackendForCommand(options = {}, commandName = "command") {
  const backend = normalizeBackendChoice(options.backend || "api");
  if (backend === "browser") {
    throw new Error(`${commandName} requires the official Lovable API backend; --backend browser is not supported.`);
  }

  const apiBackend = await createApiBackendForCommand({
    ...options,
    backend: backend === "auto" ? "auto" : "api"
  });
  if (!apiBackend) {
    throw new Error(
      `${commandName} requires LOVABLE_API_KEY or LOVABLE_BEARER_TOKEN. Browser fallback is intentionally disabled for this flow.`
    );
  }
  return apiBackend;
}

function getProjectIdFromUrl(targetUrl) {
  const normalizedUrl = normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL);
  const projectId = normalizedUrl.match(/\/projects\/([^/?#]+)/)?.[1] || null;
  if (!projectId) {
    throw new Error("Expected a Lovable project URL.");
  }
  return {
    normalizedUrl,
    projectId
  };
}

function buildLovableProjectUrl(projectId) {
  return new URL(`/projects/${projectId}`, DEFAULT_BASE_URL).toString();
}

function mapApiProject(project, workspaceById = new Map()) {
  const workspaceId = project.workspace_id || project.workspaceId || null;
  const workspace = workspaceId ? workspaceById.get(workspaceId) : null;
  const title = project.display_name || project.name || project.description || project.id;
  return {
    id: project.id,
    title,
    slug: project.name || project.display_name || null,
    projectUrl: buildLovableProjectUrl(project.id),
    workspaceId,
    workspaceName: workspace?.name || null,
    collections: ["api"],
    editCount: project.edit_count ?? project.gen_count ?? null,
    lastEditedAt: project.last_edited_at || null,
    updatedAt: project.updated_at || null,
    lastViewedAt: project.last_viewed_at || null,
    published: Boolean(project.is_published),
    liveUrl: project.url || null,
    raw: project
  };
}

function buildDashboardStateFromApi(result) {
  const workspaces = result.workspaces ?? [];
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const projects = (result.projects ?? []).map((project) => mapApiProject(project, workspaceById));
  const currentWorkspace = workspaces[0]
    ? {
        id: workspaces[0].id,
        name: workspaces[0].name,
        meta: workspaces[0].membership?.role || workspaces[0].role || null
      }
    : null;

  return {
    source: "api",
    dashboardUrl: "https://api.lovable.dev/v1/workspaces/*/projects",
    currentWorkspace,
    workspaces: workspaces.map((workspace, index) => ({
      id: workspace.id,
      name: workspace.name,
      current: index === 0,
      meta: workspace.membership?.role || workspace.role || null
    })),
    projects,
    collections: {
      workspace: { count: projects.length },
      recent: { count: 0 },
      shared: { count: 0 },
      starred: { count: projects.filter((project) => project.raw?.is_starred).length }
    }
  };
}

async function resolveApiWorkspace(apiBackend, {
  workspaceId,
  workspaceName
} = {}) {
  const workspaces = await apiBackend.listWorkspaces();
  if (workspaceId) {
    const workspace = workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      throw new Error(`Workspace id not found through Lovable API: ${workspaceId}`);
    }
    return workspace;
  }

  if (workspaceName) {
    const normalizedName = workspaceName.trim().toLowerCase();
    const exact = workspaces.find((entry) => String(entry.name || "").trim().toLowerCase() === normalizedName);
    const fuzzy = exact || workspaces.find((entry) => String(entry.name || "").trim().toLowerCase().includes(normalizedName));
    if (!fuzzy) {
      throw new Error(`Workspace not found through Lovable API: ${workspaceName}`);
    }
    return fuzzy;
  }

  if (!workspaces[0]) {
    throw new Error("Lovable API returned no accessible workspaces.");
  }
  return workspaces[0];
}

async function buildApiStatusState(apiBackend, targetUrl, {
  provider = "github"
} = {}) {
  const { normalizedUrl, projectId } = getProjectIdFromUrl(targetUrl);
  const project = await apiBackend.getProjectState(projectId);
  const previewUrl = apiBackend.getPreviewUrl(projectId);
  const previewRootUrl = buildPreviewRouteUrl(previewUrl, "/");
  const previewHead = await probePreviewUrl(previewRootUrl);

  return {
    backend: "api",
    projectUrl: normalizedUrl,
    projectId,
    title: project.display_name || project.name || project.description || "(unknown)",
    slug: project.name || null,
    workspaceName: project.workspace_id || null,
    editCount: project.edit_count ?? project.gen_count ?? null,
    lastEditedAt: project.last_edited_at || null,
    updatedAt: project.updated_at || null,
    lastViewedAt: project.last_viewed_at || null,
    published: Boolean(project.is_published),
    liveUrl: project.url || null,
    git: {
      connected: Boolean(project.is_github || project.github_repo_name),
      repository: project.github_repo_name || null,
      branch: project.main_branch || null,
      provider,
      error: null
    },
    preview: {
      sourceUrl: redactPreviewUrl(previewUrl),
      rootUrl: redactPreviewUrl(previewRootUrl),
      headStatus: previewHead.status,
      headOk: previewHead.ok,
      finalUrl: previewHead.finalUrl ? redactPreviewUrl(previewHead.finalUrl) : null,
      routeCountDetected: null,
      error: null,
      headError: previewHead.error || null
    },
    raw: project
  };
}

async function buildApiKnowledgeResult(apiBackend, targetUrl, options = {}) {
  const { normalizedUrl, projectId } = getProjectIdFromUrl(targetUrl);
  const project = await apiBackend.getProjectState(projectId);
  const workspaceId = project.workspace_id;
  if (!workspaceId) {
    throw new Error("Lovable API did not return workspace_id for this project.");
  }

  const changes = [];
  if (options.projectText !== undefined) {
    await apiBackend.setProjectKnowledge(projectId, options.projectText);
    changes.push("projectKnowledge");
  }
  if (options.workspaceText !== undefined) {
    await apiBackend.setWorkspaceKnowledge(workspaceId, options.workspaceText);
    changes.push("workspaceKnowledge");
  }

  const [projectKnowledge, workspaceKnowledge] = await Promise.all([
    apiBackend.getProjectKnowledge(projectId),
    apiBackend.getWorkspaceKnowledge(workspaceId)
  ]);

  return {
    changes,
    state: {
      backend: "api",
      settingsUrl: `api://projects/${projectId}/knowledge`,
      projectUrl: normalizedUrl,
      projectId,
      workspaceId,
      projectKnowledge: projectKnowledge?.content || "",
      workspaceKnowledge: workspaceKnowledge?.content || "",
      projectPlaceholder: null,
      workspacePlaceholder: null
    }
  };
}

async function buildCodeStateFromApi({
  apiBackend,
  targetUrl,
  filePath,
  searchQuery,
  limit = 200,
  download = false,
  outputPath
}) {
  const { projectId } = getProjectIdFromUrl(targetUrl);
  const project = await apiBackend.getProjectState(projectId);
  const ref = project.latest_commit_sha || project.main_branch || "HEAD";
  const repository = project.github_repo_name || project.name || projectId;
  const state = {
    source: "lovable-api",
    repository,
    branch: ref,
    tree: null,
    file: null,
    search: null,
    downloadPath: null
  };

  if (download && !filePath) {
    throw new Error("--download requires --file.");
  }

  if (filePath) {
    const content = await apiBackend.readFile(projectId, filePath, ref);
    state.file = {
      path: filePath,
      type: "file",
      size: Buffer.byteLength(content, "utf8"),
      content
    };

    if (download) {
      const resolvedOutputPath = path.resolve(outputPath || path.basename(filePath));
      await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
      await fs.writeFile(resolvedOutputPath, content);
      state.downloadPath = resolvedOutputPath;
    }
  }

  const filesResponse = !filePath || searchQuery
    ? await apiBackend.listFiles(projectId, ref)
    : null;
  const files = filesResponse?.files ?? [];

  if (searchQuery) {
    const needle = String(searchQuery).toLowerCase();
    const matches = files.filter((entry) => String(entry.path || "").toLowerCase().includes(needle));
    state.search = {
      query: searchQuery,
      totalCount: matches.length,
      items: matches.slice(0, limit).map((entry) => ({
        name: path.basename(entry.path),
        path: entry.path,
        repository,
        sha: ref
      }))
    };
  }

  if (!filePath && !searchQuery) {
    state.tree = {
      totalEntries: files.length,
      entries: files.slice(0, limit).map((entry) => ({
        path: entry.path,
        type: entry.binary ? "binary" : "file",
        size: entry.size ?? null
      }))
    };
  }

  return state;
}

async function executeRunbook({
  apiBackend,
  runbook,
  runbookPath,
  continueOnError = false,
  quiet = false
}) {
  const startedAt = new Date().toISOString();
  const runbookDir = path.dirname(runbookPath);
  const outputDir = resolveRunbookOutputDir(runbook, runbookPath);
  const projectId = getProjectIdFromTarget(runbook.projectUrl);
  const steps = [];
  let ok = true;
  let lastMessageId = null;
  let lastCommitSha = null;

  await fs.mkdir(outputDir, { recursive: true });

  for (let index = 0; index < runbook.steps.length; index += 1) {
    const step = runbook.steps[index];
    const stepStarted = Date.now();
    const entry = {
      index: index + 1,
      name: step.name,
      type: step.type,
      ok: false,
      durationMs: 0,
      result: null,
      error: null
    };

    try {
      entry.result = await executeRunbookStep({
        apiBackend,
        runbook,
        step,
        runbookDir,
        outputDir,
        projectId,
        lastMessageId,
        lastCommitSha,
        quiet
      });
      if (entry.result?.messageId) {
        lastMessageId = entry.result.messageId;
      }
      if (entry.result?.commitSha) {
        lastCommitSha = entry.result.commitSha;
      }
      if (entry.result?.completion?.commit_sha) {
        lastCommitSha = entry.result.completion.commit_sha;
      }
      entry.ok = true;
    } catch (err) {
      ok = false;
      entry.error = err?.message || String(err);
      if (!continueOnError) {
        entry.durationMs = Date.now() - stepStarted;
        steps.push(entry);
        break;
      }
    }

    entry.durationMs = Date.now() - stepStarted;
    steps.push(entry);
  }

  const finishedAt = new Date().toISOString();
  return {
    ok,
    runbookPath,
    projectUrl: runbook.projectUrl,
    projectId,
    outputDir,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    steps
  };
}

async function executeRunbookStep({
  apiBackend,
  runbook,
  step,
  runbookDir,
  outputDir,
  projectId,
  lastMessageId,
  lastCommitSha,
  quiet
}) {
  if (step.type === "snapshot") {
    const snapshot = await buildApiSnapshot(apiBackend, runbook.projectUrl, {
      ref: step.ref,
      maxFiles: step.maxFiles ?? runbook.defaults.maxFiles,
      maxEdits: step.maxEdits ?? runbook.defaults.maxEdits,
      files: step.files !== false,
      fileContent: Boolean(step.fileContent),
      knowledge: step.knowledge !== false,
      edits: step.edits !== false,
      database: step.database !== false,
      mcp: Boolean(step.mcp)
    });
    // Persist the snapshot. If the step did not specify an explicit `output`,
    // fall back to a default path inside the runbook's output dir so artifacts
    // are never silently dropped on disk.
    const snapshotOutputPath = resolveRunbookStepDefaultOutput(step, outputDir, "snapshot");
    const outputPath = snapshotOutputPath
      ? await writeJsonFile(snapshotOutputPath, snapshot)
      : null;
    return {
      projectId: snapshot.projectId,
      outputPath,
      files: snapshot.files
        ? {
            total: snapshot.files.total,
            returned: snapshot.files.returned,
            truncated: snapshot.files.truncated
          }
        : null,
      edits: snapshot.edits
        ? {
            total: snapshot.edits.total,
            hasMore: snapshot.edits.hasMore
          }
        : null,
      warnings: snapshot.warnings
    };
  }

  if (step.type === "diff") {
    const diffState = await buildApiDiff(apiBackend, runbook.projectUrl, {
      messageId: step.messageId,
      sha: step.sha || (!step.messageId && !step.latest && lastCommitSha ? lastCommitSha : null),
      baseSha: step.baseSha,
      latest: Boolean(step.latest) || (!step.messageId && !step.sha && !lastCommitSha)
    });

    const diffOutputPath = resolveRunbookStepDefaultOutput(step, outputDir, "diff");
    const outputPath = diffOutputPath
      ? await writeJsonFile(diffOutputPath, diffState)
      : null;
    return {
      params: diffState.params,
      outputPath,
      summary: diffState.summary
    };
  }

  if (step.type === "prompt" || step.type === "fix") {
    const promptText = await resolveRunbookPrompt(step, runbookDir);
    const attachmentPaths = await resolveRunbookAttachments(step, runbookDir);
    if (!hasText(promptText) && attachmentPaths.length === 0) {
      throw new Error(`${step.type} step requires prompt/promptFile or files.`);
    }

    const parts = hasText(promptText)
      ? buildPromptSequence(promptText, {
          autoSplit: step.autoSplit !== false,
          chunked: Boolean(step.chunked),
          splitBy: step.splitBy
        })
      : [{
          index: 1,
          total: 1,
          prompt: step.attachmentMessage || "Use the attached files as reference.",
          rawPrompt: "",
          attachmentOnly: true
        }];
    const mode = normalizePromptModeOption(step.mode || runbook.defaults.mode);
    const sequence = [];
    let finalResponse = null;

    for (const part of parts) {
      const isFinalPart = part.index === part.total;
      const response = await apiBackend.submitPrompt(projectId, {
        message: part.prompt,
        filePaths: part.index === 1 ? attachmentPaths : [],
        planMode: mode === "plan",
        mode,
        wait: isFinalPart && step.wait !== false,
        pollInterval: step.pollMs || runbook.defaults.pollMs || DEFAULT_IDLE_POLL_MS,
        timeout: step.timeoutMs || runbook.defaults.promptTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS
      });
      finalResponse = response;
      sequence.push({
        index: part.index,
        total: part.total,
        chars: part.prompt.length,
        messageId: response.message_id,
        status: response.status,
        completion: response.completion || null,
        attachmentsSent: part.index === 1 ? attachmentPaths.length : 0
      });
    }

    return {
      messageId: finalResponse?.message_id || sequence.at(-1)?.messageId || null,
      completion: finalResponse?.completion || null,
      commitSha: finalResponse?.completion?.commit_sha || null,
      mode,
      sequence
    };
  }

  if (step.type === "wait") {
    const messageId = step.messageId || lastMessageId;
    if (messageId && step.project !== true) {
      const completion = await apiBackend.waitForMessageCompletion(projectId, messageId, {
        pollInterval: step.pollMs || runbook.defaults.pollMs || DEFAULT_IDLE_POLL_MS,
        timeout: step.timeoutMs || runbook.defaults.waitTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS
      });
      return {
        waitedFor: "message",
        messageId,
        completion,
        commitSha: completion?.commit_sha || null
      };
    }

    const project = await apiBackend.waitForProjectReady(projectId, {
      pollInterval: step.pollMs || runbook.defaults.pollMs || DEFAULT_IDLE_POLL_MS,
      timeout: step.timeoutMs || runbook.defaults.waitTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS
    });
    return {
      waitedFor: "project",
      status: project.status || null,
      project
    };
  }

  if (step.type === "verify") {
    const previewUrl = step.url || apiBackend.getPreviewUrl(projectId);
    const routes = Array.isArray(step.routes)
      ? step.routes
      : (step.route ? [step.route] : ["/"]);
    const variants = getVerifyVariants({
      desktopOnly: Boolean(step.desktopOnly),
      mobileOnly: Boolean(step.mobileOnly)
    });
    const expectText = await resolveRunbookAssertions(step, runbookDir, "expect");
    const forbidText = await resolveRunbookAssertions(step, runbookDir, "forbid");
    const verification = await withMutedConsole(quiet, () => runUrlVerification({
      targetUrl: runbook.projectUrl,
      captureUrl: previewUrl,
      outputDir: resolveRunbookStepOutputDir(step, outputDir),
      headless: step.headed ? false : true,
      settleMs: step.settleMs || runbook.defaults.settleMs || 4000,
      variants,
      routes,
      explicitRoutes: routes.length > 0,
      failOnConsole: Boolean(step.failOnConsole),
      expectText,
      forbidText,
      sourceLabel: step.sourceLabel || "Runbook preview",
      throwOnBlocking: step.throwOnBlocking !== false
    }));
    return {
      summaryPath: verification.summaryPath,
      blocking: verification.summary.blocking || null,
      captures: verification.summary.captures.length
    };
  }

  if (step.type === "publish") {
    const publishResult = await apiBackend.publish(projectId, {
      visibility: step.visibility
    });
    const published = step.wait === false
      ? null
      : await apiBackend.waitForProjectPublished(projectId, {
          pollInterval: step.pollMs || runbook.defaults.pollMs || DEFAULT_IDLE_POLL_MS,
          timeout: step.timeoutMs || runbook.defaults.publishTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS
        });
    const publishedUrl = await apiBackend.getPublishedUrl(projectId);
    let verification = null;
    if (step.verifyLive && publishedUrl) {
      const expectText = await resolveRunbookAssertions(step, runbookDir, "expect");
      const forbidText = await resolveRunbookAssertions(step, runbookDir, "forbid");
      verification = await withMutedConsole(quiet, () => runUrlVerification({
        targetUrl: runbook.projectUrl,
        captureUrl: publishedUrl,
        outputDir: resolveRunbookStepOutputDir(step, outputDir),
        headless: true,
        settleMs: step.settleMs || runbook.defaults.settleMs || 4000,
        variants: getVerifyVariants({
          desktopOnly: Boolean(step.desktopOnly),
          mobileOnly: Boolean(step.mobileOnly)
        }),
        routes: Array.isArray(step.routes) ? step.routes : [step.route || "/"],
        explicitRoutes: Boolean(step.route || step.routes),
        failOnConsole: Boolean(step.failOnConsole),
        expectText,
        forbidText,
        sourceLabel: "Runbook live",
        throwOnBlocking: step.throwOnBlocking !== false
      }));
    }
    return {
      publishResult,
      published,
      publishedUrl,
      liveVerificationSummaryPath: verification?.summaryPath || null,
      blocking: verification?.summary?.blocking || null
    };
  }

  throw new Error(`Unsupported runbook step type "${step.type}".`);
}

async function resolveRunbookPrompt(step, runbookDir) {
  if (step.prompt && step.promptFile) {
    throw new Error(`${step.name} passes both prompt and promptFile.`);
  }
  if (step.promptFile) {
    return await fs.readFile(path.resolve(runbookDir, step.promptFile), "utf8");
  }
  return typeof step.prompt === "string" ? step.prompt : "";
}

async function resolveRunbookAttachments(step, runbookDir) {
  const values = [
    ...normalizeRunbookStringList(step.file),
    ...normalizeRunbookStringList(step.files)
  ];
  return values.map((value) => path.resolve(runbookDir, value));
}

async function resolveRunbookAssertions(step, runbookDir, kind) {
  const valueKey = kind === "expect" ? "expectText" : "forbidText";
  const fileKey = kind === "expect" ? "expectFile" : "forbidFile";
  const values = normalizeRunbookStringList(step[valueKey]);
  const fileValues = normalizeRunbookStringList(step[fileKey]);

  for (const fileValue of fileValues) {
    const content = await fs.readFile(path.resolve(runbookDir, fileValue), "utf8");
    values.push(...parseAssertionLines(content));
  }

  return values;
}

function resolveRunbookOutputDir(runbook, runbookPath) {
  if (runbook.outputDir) {
    return path.resolve(path.dirname(runbookPath), runbook.outputDir);
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.basename(runbookPath, path.extname(runbookPath));
  return path.resolve(process.cwd(), "output", "runbooks", `${base}-${timestamp}`);
}

function resolveRunbookArtifactPath(value, outputDir) {
  const target = String(value || "").trim();
  if (!target) {
    throw new Error("Output path cannot be empty.");
  }
  return path.isAbsolute(target) ? target : path.join(outputDir, target);
}

// Resolve a default output path for steps that produce JSON artifacts so they
// always land on disk. Honors an explicit `step.output`; otherwise falls back
// to `<outputDir>/<step-slug>.json` when an outputDir is set; returns null
// when neither is available (no persistence requested at all).
function resolveRunbookStepDefaultOutput(step, outputDir, defaultBasename) {
  if (step?.output) {
    return resolveRunbookArtifactPath(step.output, outputDir);
  }
  if (!outputDir) return null;
  const slug = slugifyRunbookStepName(step?.name) || defaultBasename;
  const filename = slug.endsWith(".json") ? slug : `${slug}.json`;
  return path.join(outputDir, filename);
}

function resolveRunbookStepOutputDir(step, outputDir) {
  if (step.outputDir) {
    return resolveRunbookArtifactPath(step.outputDir, outputDir);
  }
  return path.join(outputDir, slugifyRunbookStepName(step.name));
}

function slugifyRunbookStepName(value) {
  return String(value || "step")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "step";
}

function normalizeRunbookStringList(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeRunbookStringList(entry));
  }
  return [String(value)];
}

async function withMutedConsole(quiet, fn) {
  if (!quiet) {
    return await fn();
  }

  const originalLog = console.log;
  const originalWarn = console.warn;
  try {
    console.log = () => {};
    console.warn = () => {};
    return await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function printRunbookPlan(plan) {
  console.log(`Runbook: ${plan.name}`);
  console.log(`Project: ${plan.projectUrl}`);
  console.log(`Backend: ${plan.backend}`);
  console.log(`Output: ${plan.outputDir || "(auto)"}`);
  console.log("");
  console.log("Steps:");
  for (const step of plan.steps) {
    const marker = step.mutates ? "mutates" : "inspect";
    console.log(`  ${step.index}. ${step.name} [${step.type}, ${marker}]`);
  }
}

function printRunbookResult(result) {
  console.log(`Runbook ${result.ok ? "completed" : "failed"}: ${result.runbookPath}`);
  console.log(`Project: ${result.projectUrl}`);
  console.log(`Output: ${result.outputDir}`);
  console.log("");
  for (const step of result.steps) {
    const mark = step.ok ? "\u2713" : "\u2717";
    console.log(`${mark} ${step.index}. ${step.name} (${step.type}, ${step.durationMs}ms)`);
    if (!step.ok && step.error) {
      console.log(`  Error: ${step.error}`);
    } else if (step.result?.outputPath) {
      console.log(`  Output: ${step.result.outputPath}`);
    } else if (step.result?.summaryPath) {
      console.log(`  Summary: ${step.result.summaryPath}`);
    } else if (step.result?.publishedUrl) {
      console.log(`  Published: ${step.result.publishedUrl}`);
    } else if (step.result?.messageId) {
      console.log(`  Message: ${step.result.messageId}`);
    }
  }
}

function collectValues(value, previous) {
  previous.push(value);
  return previous;
}

function parseInteger(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected an integer, got: ${value}`);
  }
  return parsed;
}

function hasText(value) {
  return String(value || "").trim().length > 0;
}

function normalizePromptModeOption(mode) {
  if (mode === undefined || mode === null || mode === "") {
    return null;
  }
  const normalized = String(mode).trim().toLowerCase();
  if (!["build", "plan"].includes(normalized)) {
    throw new Error(`Unsupported prompt mode "${mode}". Use build or plan.`);
  }
  return normalized;
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function printPromptAttachmentState(state = {}) {
  console.log(`Attachment form found: ${state.formFound ? "yes" : "no"}`);
  console.log(`File input present: ${state.inputPresent ? "yes" : "no"}`);
  console.log(`Send enabled: ${state.sendEnabled === null ? "unknown" : state.sendEnabled ? "yes" : "no"}`);
  console.log(`Attached files: ${state.filenames?.length ? state.filenames.join(", ") : "(none)"}`);
  console.log(`Remove actions: ${state.removeActions?.length ? state.removeActions.join(", ") : "(none)"}`);
}

function getPromptFragmentWarnings(prompt) {
  const trimmed = String(prompt || "").trim();
  if (!trimmed) {
    return ["Prompt is empty."];
  }

  const warnings = [];
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const hasListContinuation = lines.slice(1).some((line) => /^([-*•]|\d+[.)])\s+/.test(line));

  if (/[:;]\s*$/.test(trimmed) && lines.length === 1) {
    warnings.push("The prompt ends with punctuation that suggests missing follow-up details.");
  }

  if (/\bthe following\b/i.test(trimmed) && !hasListContinuation && lines.length < 2) {
    warnings.push("The prompt references 'the following' but does not include the actual items.");
  }

  if (
    /\blayout issues?\b/i.test(trimmed) &&
    /\b(following|below|above)\b/i.test(trimmed) &&
    !hasListContinuation
  ) {
    warnings.push("The prompt mentions layout issues but no concrete layout problems were included.");
  }

  return warnings;
}

function assertPromptLooksComplete(prompt, {
  allowFragment = false
} = {}) {
  const warnings = getPromptFragmentWarnings(prompt);
  if (warnings.length > 0 && !allowFragment) {
    throw new Error(
      `Prompt looks truncated or unfinished: ${warnings.join(" ")} Re-run with --allow-fragment to send it anyway.`
    );
  }
  return warnings;
}

function parseBooleanish(value, flagName) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${flagName} expects one of: true, false, yes, no, on, off.`);
}

function getVerifyVariants({
  desktopOnly = false,
  mobileOnly = false
} = {}) {
  if (desktopOnly && mobileOnly) {
    throw new Error("Choose either desktop-only or mobile-only verification, not both.");
  }

  if (desktopOnly) {
    return ["desktop"];
  }

  if (mobileOnly) {
    return ["mobile"];
  }

  return ["desktop", "mobile"];
}

function getVerificationRoutes(routes = []) {
  const normalizedRoutes = (Array.isArray(routes) ? routes : [])
    .map((route) => normalizePreviewRoute(route))
    .filter(Boolean);

  if (normalizedRoutes.length === 0) {
    return ["/"];
  }

  return Array.from(new Set(normalizedRoutes));
}

function getPromptStrategyRecommendation({
  promptPlan,
  autoSplit = true,
  chunked = false,
  splitBy
} = {}) {
  if (!promptPlan) {
    return "No prompt text supplied. This run would send attachments only.";
  }

  if (!autoSplit) {
    return "Single-shot send requested via `--no-auto-split`. Pair it with `--verify-effect` when you want one Lovable turn with a post-submit check.";
  }

  if (chunked && promptPlan.strategy === "markdown") {
    return "Chunked markdown delivery is active. Keep each `##` block self-contained so Lovable can act on every chunk independently.";
  }

  if (chunked) {
    return "Chunked delivery is active. Review the emitted chunks below before sending them live.";
  }

  if (splitBy === "markdown" && promptPlan.strategy === "markdown") {
    return "Markdown-aware chunking is selected. Top-level headings define the chunk boundaries.";
  }

  if (promptPlan.autoSplitTriggered) {
    return "The prompt will be split automatically under the current rules. Use `--no-auto-split` if you intentionally want a single Lovable turn.";
  }

  return "The prompt fits in one chunk under the current rules. Use `--no-auto-split --verify-effect` for the most direct single-shot flow.";
}

function printPromptDryRun({
  targetUrl,
  prompt,
  promptPlan,
  attachmentPaths = [],
  autoSplit = true,
  chunked = false,
  splitBy
} = {}) {
  console.log(`Dry run target: ${normalizeTargetUrl(targetUrl, DEFAULT_BASE_URL)}`);

  if (!hasText(prompt)) {
    console.log("Prompt text: (none)");
    console.log(`Attachments: ${attachmentPaths.length ? attachmentPaths.join(", ") : "(none)"}`);
    console.log("This run would send attachments only.");
    return;
  }

  console.log(`Prompt chars: ${promptPlan.normalizedPrompt.length}`);
  console.log(`Estimated tokens: ${promptPlan.estimatedTokens}`);
  console.log(`Split strategy: ${promptPlan.strategy}`);
  console.log(`Chunks to send: ${promptPlan.sequence.length}`);
  console.log(`Auto-split enabled: ${autoSplit ? "yes" : "no"}`);
  console.log(`Chunked forced: ${chunked ? "yes" : "no"}`);
  console.log(`Requested split mode: ${splitBy || "(default)"}`);
  console.log(`Recommendation: ${getPromptStrategyRecommendation({
    promptPlan,
    autoSplit,
    chunked,
    splitBy
  })}`);

  if (promptPlan.warnings.length > 0) {
    console.log("Warnings:");
    promptPlan.warnings.forEach((warning) => {
      console.log(`- ${warning}`);
    });
  }

  promptPlan.sequence.forEach((entry) => {
    console.log(`--- chunk ${entry.index}/${entry.total} ---`);
    console.log(entry.prompt);
  });

  if (attachmentPaths.length > 0) {
    console.log(`Attachments: ${attachmentPaths.join(", ")}`);
  }
}

async function loadDashboardProjectMetadata(context, projectUrl, {
  timeoutMs = 20_000,
  pollMs = 250,
  pageSize = 100
} = {}) {
  const page = await context.newPage();
  const normalizedUrl = normalizeTargetUrl(projectUrl, DEFAULT_BASE_URL);
  const projectId = normalizedUrl.match(/\/projects\/([^/?#]+)/)?.[1];

  if (!projectId) {
    await page.close().catch(() => {});
    throw new Error("Expected a Lovable project URL.");
  }

  try {
    return await getDashboardProjectState(page, {
      projectId,
      dashboardUrl: new URL("/dashboard", DEFAULT_BASE_URL).toString(),
      timeoutMs,
      pollMs,
      pageSize
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function probePreviewUrl(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow"
    });

    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      finalUrl: null,
      error: error?.message || String(error)
    };
  }
}

function previewTextMatches(snapshot, expectedTexts = []) {
  const haystack = String(snapshot?.bodyText || "").toLowerCase();
  const missingExpectedTexts = expectedTexts.filter((value) => {
    return !haystack.includes(String(value || "").trim().toLowerCase());
  });

  return {
    matched: missingExpectedTexts.length === 0,
    missingExpectedTexts
  };
}

async function waitForPreviewTextMatch(context, captureUrl, {
  route,
  expectedTexts = [],
  timeoutMs = 180_000,
  settleMs = 4_000
} = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let intervalMs = 3_000;
  let lastResult = null;
  const routeUrl = buildPreviewRouteUrl(captureUrl, route);

  while (Date.now() <= deadline) {
    const probe = await readUrlTextSnapshot(context, {
      url: routeUrl,
      settleMs
    });
    const match = previewTextMatches(probe.snapshot, expectedTexts);

    lastResult = {
      route: normalizePreviewRoute(route),
      url: redactPreviewUrl(routeUrl),
      status: probe.status,
      finalUrl: redactPreviewUrl(probe.finalUrl),
      snapshot: probe.snapshot,
      ...match
    };

    if (match.matched) {
      return {
        matched: true,
        durationMs: Date.now() - startedAt,
        ...lastResult
      };
    }

    if (Date.now() >= deadline) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    intervalMs = Math.min(20_000, Math.round(intervalMs * 1.6));
  }

  return {
    matched: false,
    durationMs: Date.now() - startedAt,
    ...lastResult
  };
}

async function verifyPromptEffect({
  context,
  page,
  normalizedUrl,
  baseline,
  lookup,
  timeoutMs = 180_000,
  route,
  expectText = [],
  settleMs = 4_000
} = {}) {
  const pollPage = await context.newPage();

  try {
    const projectId = normalizedUrl.match(/\/projects\/([^/?#]+)/)?.[1];
    if (!projectId) {
      throw new Error("Expected a Lovable project URL.");
    }

    const pollResult = await pollDashboardProjectState(pollPage, {
      projectId,
      baseline,
      lookup,
      timeoutMs
    });
    const verifyEffect = {
      baseline,
      final: pollResult.final,
      comparison: compareDashboardProjectState(baseline, pollResult.final),
      detected: pollResult.detected,
      durationMs: pollResult.durationMs,
      previewCheck: null
    };

    if (!pollResult.detected || !route || expectText.length === 0) {
      return verifyEffect;
    }

    const previewInfo = await getProjectPreviewInfo(page);
    const remainingTimeoutMs = Math.max(5_000, timeoutMs - pollResult.durationMs);
    const previewCheck = await waitForPreviewTextMatch(context, previewInfo.src, {
      route,
      expectedTexts: expectText,
      timeoutMs: remainingTimeoutMs,
      settleMs
    });
    verifyEffect.previewCheck = previewCheck;
    verifyEffect.detected = verifyEffect.detected && previewCheck.matched;
    verifyEffect.durationMs = pollResult.durationMs + previewCheck.durationMs;

    return verifyEffect;
  } finally {
    await pollPage.close().catch(() => {});
  }
}

function printVerifyEffectResult(verifyEffect) {
  const final = verifyEffect.final || {};
  console.log(`Verify-effect detected: ${verifyEffect.detected ? "yes" : "no"}`);
  console.log(`Verify-effect duration: ${verifyEffect.durationMs}ms`);
  console.log(`Final editCount: ${final.editCount ?? "unknown"}`);
  console.log(`Final lastEditedAt: ${final.lastEditedAt || "unknown"}`);

  if (verifyEffect.previewCheck) {
    console.log(`Preview route check: ${verifyEffect.previewCheck.route}`);
    console.log(`Preview route matched: ${verifyEffect.previewCheck.matched ? "yes" : "no"}`);
    if (verifyEffect.previewCheck.missingExpectedTexts?.length) {
      console.log(`Preview still missing: ${verifyEffect.previewCheck.missingExpectedTexts.join(", ")}`);
    }
  }
}

function formatVerifyEffectError(verifyEffect) {
  if (verifyEffect.previewCheck && !verifyEffect.previewCheck.matched) {
    return `Lovable recorded an edit, but preview route ${verifyEffect.previewCheck.route} never showed the expected text (${verifyEffect.previewCheck.missingExpectedTexts.join(", ")}).`;
  }

  return "No edits detected in dashboard metadata within the verify-effect timeout. editCount and lastEditedAt stayed unchanged.";
}

function getSpeedDevices(value = "both") {
  const normalized = String(value || "both").trim().toLowerCase();
  if (normalized === "desktop") {
    return ["desktop"];
  }

  if (normalized === "mobile") {
    return ["mobile"];
  }

  if (normalized === "both") {
    return ["desktop", "mobile"];
  }

  throw new Error('Speed device must be one of: desktop, mobile, both.');
}

async function runCommandCapture(command, args, {
  cwd = process.cwd()
} = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
        return;
      }

      const error = new Error(
        `${command} ${args.join(" ")} failed with exit code ${code}.${stderr ? ` ${stderr.trim()}` : ""}`
      );
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function runGhApiJson(route) {
  const result = await runCommandCapture("gh", [
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    route
  ]);

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh api returned non-JSON output for "${route}": ${error.message}`);
  }
}

function encodeGitHubPath(filePath) {
  return String(filePath || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodeGitHubContent(payload) {
  if (!payload?.content) {
    return "";
  }

  return Buffer.from(String(payload.content).replace(/\n/g, ""), "base64").toString("utf8");
}

async function buildCodeStateFromGitConnection({
  gitState,
  filePath,
  searchQuery,
  limit = 200,
  download = false,
  outputPath
}) {
  const repository = gitState.repository;
  let branch = gitState.branch || null;
  if (!branch) {
    const repoPayload = await runGhApiJson(`repos/${repository}`);
    branch = repoPayload.default_branch || "main";
  }
  const state = {
    source: "github",
    repository,
    branch,
    tree: null,
    file: null,
    search: null,
    downloadPath: null
  };

  if (filePath) {
    const payload = await runGhApiJson(
      `repos/${repository}/contents/${encodeGitHubPath(filePath)}?ref=${encodeURIComponent(branch)}`
    );

    if (Array.isArray(payload)) {
      state.file = {
        path: filePath,
        type: "directory",
        entries: payload.slice(0, limit).map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type,
          size: entry.size ?? null
        })),
        totalEntries: payload.length
      };
    } else {
      state.file = {
        path: payload.path || filePath,
        type: payload.type || "file",
        size: payload.size ?? null,
        content: decodeGitHubContent(payload)
      };

      if (download) {
        const resolvedOutputPath = path.resolve(outputPath || path.basename(filePath));
        await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
        await fs.writeFile(resolvedOutputPath, state.file.content);
        state.downloadPath = resolvedOutputPath;
      }
    }
  }

  if (searchQuery) {
    const payload = await runGhApiJson(
      `search/code?q=${encodeURIComponent(`${searchQuery} repo:${repository}`)}&per_page=${Math.min(limit, 100)}`
    );
    const items = Array.isArray(payload.items) ? payload.items : [];
    state.search = {
      query: searchQuery,
      totalCount: payload.total_count ?? items.length,
      items: items.slice(0, limit).map((item) => ({
        name: item.name,
        path: item.path,
        repository: item.repository?.full_name || repository,
        sha: item.sha
      }))
    };
  }

  if (!filePath && !searchQuery) {
    const payload = await runGhApiJson(
      `repos/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
    const entries = Array.isArray(payload.tree) ? payload.tree : [];
    state.tree = {
      totalEntries: entries.length,
      entries: entries
        .filter((entry) => entry?.path)
        .slice(0, limit)
        .map((entry) => ({
          path: entry.path,
          type: entry.type,
          size: entry.size ?? null
        }))
    };
  }

  if (download && !filePath) {
    throw new Error("--download requires --file.");
  }

  return state;
}

async function runLighthouseAudit(url, {
  device,
  outputDir
}) {
  const reportPath = path.resolve(outputDir, `${device}.lighthouse.json`);
  const args = [
    "--yes",
    "lighthouse",
    url,
    "--quiet",
    "--output=json",
    `--output-path=${reportPath}`,
    "--chrome-flags=--headless=new --no-sandbox --disable-gpu"
  ];

  if (device === "desktop") {
    args.push("--preset=desktop");
  }

  await runCommandCapture("npx", args);
  const rawReport = await fs.readFile(reportPath, "utf8");
  const report = JSON.parse(rawReport);
  const categories = report.categories || {};

  return {
    device,
    reportPath,
    finalUrl: report.finalUrl,
    fetchTime: report.fetchTime,
    scores: {
      performance: categories.performance?.score === null || categories.performance?.score === undefined
        ? null
        : Math.round(categories.performance.score * 100),
      accessibility: categories.accessibility?.score === null || categories.accessibility?.score === undefined
        ? null
        : Math.round(categories.accessibility.score * 100),
      bestPractices: categories["best-practices"]?.score === null || categories["best-practices"]?.score === undefined
        ? null
        : Math.round(categories["best-practices"].score * 100),
      seo: categories.seo?.score === null || categories.seo?.score === undefined
        ? null
        : Math.round(categories.seo.score * 100)
    }
  };
}

function printPublishedSettingsState(state) {
  const visibilityOptions = Array.from(
    new Map(
      (state.visibility?.options || []).map((option) => [
        `${option.key}:${option.disabled ? "disabled" : "enabled"}`,
        `${option.key}${option.disabled ? " (disabled)" : ""}`
      ])
    ).values()
  )
    .join(", ") || "(none)";

  console.log(`Current visibility: ${state.visibility?.current?.key || "unknown"}`);
  console.log(`Visibility label: ${state.visibility?.current?.label || "(unknown)"}`);
  console.log(`Available visibilities: ${visibilityOptions}`);
  console.log(`Website title: ${state.websiteInfo?.title || "(empty)"}`);
  console.log(`Website title placeholder: ${state.websiteInfo?.titlePlaceholder || "(none)"}`);
  console.log(`Website description: ${state.websiteInfo?.description || "(empty)"}`);
  console.log(`Website description placeholder: ${state.websiteInfo?.descriptionPlaceholder || "(none)"}`);
}

function printToolbarState(state) {
  console.log(`Toolbar project: ${state.projectUrl}`);
  console.log(`Buttons: ${state.buttons.length}`);
  state.buttons.forEach((button, index) => {
    console.log(`[${index}] ${button.label}${button.menuCandidate ? " [menu]" : ""}${button.disabled ? " (disabled)" : ""}`);
  });

  if (!state.openedMenus?.length) {
    return;
  }

  state.openedMenus.forEach((entry, index) => {
    console.log(`Menu ${index + 1}: ${entry.button.label}`);
    if (!entry.opened || !entry.surface) {
      console.log("  did not open a visible surface");
      return;
    }

    console.log(`  actions: ${entry.surface.buttons.join(", ") || "(none)"}`);
    if (entry.surface.links.length > 0) {
      console.log(`  links: ${entry.surface.links.map((link) => link.text || link.href).join(", ")}`);
    }
  });
}

function printProjectSettingsState(state) {
  console.log(`Project settings: ${state.settingsUrl}`);
  console.log(`Project name: ${state.projectName || "(unknown)"}`);
  console.log(`Owner: ${state.owner || "(unknown)"}`);
  console.log(`Tech stack: ${state.techStack || "(unknown)"}`);
  console.log(`Project visibility: ${state.visibility.current || "(unknown)"}`);
  console.log(`Visibility options: ${state.visibility.options?.map((option) => option.label).join(", ") || "(none)"}`);
  console.log(`Project category: ${state.category.current || "(unknown)"}`);
  console.log(`Category options: ${state.category.options?.map((option) => option.label).join(", ") || "(none)"}`);
  console.log(`Hide Lovable badge: ${state.hideLovableBadge.checked === null ? "unknown" : state.hideLovableBadge.checked ? "on" : "off"}`);
  console.log(`Disable analytics: ${state.disableAnalytics.checked === null ? "unknown" : state.disableAnalytics.checked ? "on" : "off"}`);
  console.log(`Cross-project sharing: ${state.crossProjectSharing.checked === null ? "unknown" : state.crossProjectSharing.checked ? "on" : "off"}`);
  console.log(`Available actions: ${state.availableActions.join(", ") || "(none)"}`);
}

function printKnowledgeState(state) {
  console.log(`Knowledge settings: ${state.settingsUrl}`);
  console.log(`Project knowledge length: ${state.projectKnowledge.length}`);
  console.log(`Workspace knowledge length: ${state.workspaceKnowledge.length}`);
  console.log(`Project placeholder: ${state.projectPlaceholder || "(none)"}`);
  console.log(`Workspace placeholder: ${state.workspacePlaceholder || "(none)"}`);
}

function printWorkspaceSectionState(state) {
  console.log(`[${state.section}] ${state.title}`);
  console.log(`URL: ${state.settingsUrl}`);
  console.log(`Buttons: ${state.buttons?.map((button) => button.text || button.ariaLabel).join(", ") || "(none)"}`);
  if (state.comboboxes?.length) {
    console.log(`Comboboxes: ${state.comboboxes.map((combobox) => combobox.text || combobox.label).join(", ")}`);
  }
  if (state.switches?.length) {
    console.log(
      `Switches: ${state.switches.map((control, index) => `${control.label || `switch-${index}`}:${control.checked ? "on" : "off"}`).join(", ")}`
    );
  }
  if (state.rows?.length) {
    console.log(`Rows: ${state.rows.length}`);
  }
}

function printWorkspaceState(state) {
  if (state.section === "all") {
    console.log(`Workspace surfaces: ${Object.keys(state.sections || {}).join(", ")}`);
    Object.values(state.sections || {}).forEach((sectionState) => {
      printWorkspaceSectionState(sectionState);
    });
    return;
  }

  printWorkspaceSectionState(state);
}

function printGitState(state) {
  console.log(`Git settings: ${state.settingsUrl}`);
  console.log(`Provider: ${state.provider}`);
  console.log(`Connected: ${state.connected ? "yes" : "no"}`);
  console.log(`Repository: ${state.repository || "(none)"}`);
  console.log(`Branch: ${state.branch || "(unknown)"}`);
  console.log(`Account: ${state.account || "(unknown)"}`);
  console.log(`Available actions: ${state.availableActions.join(", ") || "(none)"}`);
}

function printProjectStatusState(state) {
  console.log(`Project: ${state.title || "(unknown)"}${state.slug ? ` [${state.slug}]` : ""}`);
  console.log(`Project id: ${state.projectId}`);
  console.log(`Workspace: ${state.workspaceName || "(unknown)"}`);
  console.log(`Edit count: ${state.editCount ?? "unknown"}`);
  console.log(`Last edited: ${state.lastEditedAt || "(unknown)"}`);
  console.log(`Updated at: ${state.updatedAt || "(unknown)"}`);
  console.log(`Last viewed: ${state.lastViewedAt || "(unknown)"}`);
  console.log(`Published: ${state.published ? "yes" : "no"}`);
  console.log(`Live URL: ${state.liveUrl || "(not published)"}`);
  console.log(`Git connected: ${state.git.connected ? "yes" : "no"}`);
  console.log(`Git repository: ${state.git.repository || "(none)"}`);
  console.log(`Git branch: ${state.git.branch || "(unknown)"}`);
  if (state.git.error) {
    console.log(`Git error: ${state.git.error}`);
  }
  if (state.preview.error) {
    console.log(`Preview source: (unavailable)`);
    console.log(`Preview error: ${state.preview.error}`);
  } else {
    console.log(`Preview source: ${state.preview.sourceUrl}`);
    console.log(`Preview root URL: ${state.preview.rootUrl}`);
    console.log(`Preview HEAD status: ${state.preview.headStatus ?? "unknown"}`);
    console.log(`Preview reachable: ${state.preview.headOk ? "yes" : "no"}`);
    console.log(`Detected routes: ${state.preview.routeCountDetected ?? "(not sampled)"}`);
  }
}

function printCodeState(state) {
  console.log(`Code source: ${state.source}`);
  console.log(`Repository: ${state.repository}`);
  console.log(`Branch: ${state.branch}`);

  if (state.tree) {
    console.log(`Tree entries: ${state.tree.totalEntries}`);
    state.tree.entries.forEach((entry) => {
      console.log(`${entry.type || "node"} ${entry.path}`);
    });
  }

  if (state.file) {
    console.log(`File target: ${state.file.path}`);
    console.log(`File type: ${state.file.type}`);
    if (state.file.type === "directory") {
      console.log(`Directory entries: ${state.file.totalEntries}`);
      state.file.entries.forEach((entry) => {
        console.log(`${entry.type || "node"} ${entry.path}`);
      });
    } else {
      console.log(state.file.content);
    }
  }

  if (state.search) {
    console.log(`Search query: ${state.search.query}`);
    console.log(`Search results: ${state.search.totalCount}`);
    state.search.items.forEach((item) => {
      console.log(`${item.path} (${item.sha})`);
    });
  }

  if (state.downloadPath) {
    console.log(`Downloaded to: ${state.downloadPath}`);
  }
}

function printSpeedState(state) {
  console.log(`Speed source: ${state.source}`);
  console.log(`Preview URL: ${state.previewUrl}`);
  state.audits.forEach((audit) => {
    console.log(`[${audit.device}] performance=${audit.scores.performance ?? "n/a"} accessibility=${audit.scores.accessibility ?? "n/a"} best-practices=${audit.scores.bestPractices ?? "n/a"} seo=${audit.scores.seo ?? "n/a"}`);
    console.log(`  report: ${audit.reportPath}`);
  });
}

// Direct, project-first listing — used when the caller asked for raw
// project data via --workspace / --all-workspaces / --projects-only.
function printProjectList(result, { limit } = {}) {
  const projects = Array.isArray(result?.projects) ? result.projects : [];
  const total = result?.total ?? projects.length;
  const hasMore = result?.has_more === true;
  const workspaceCount = Array.isArray(result?.workspaces) ? result.workspaces.length : null;

  if (workspaceCount != null) {
    console.log(`Workspaces queried: ${workspaceCount}`);
  }
  console.log(`Projects: ${projects.length}${total > projects.length ? ` of ${total}` : ""}${hasMore ? " (has_more)" : ""}`);

  const cap = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : projects.length;
  const visible = projects.slice(0, cap);
  for (const p of visible) {
    const id = p.id || "(no-id)";
    const name = p.display_name || p.name || "(unnamed)";
    const status = p.status || "?";
    const pub = p.is_published ? "published" : "draft";
    const url = p.url || "";
    const last = (p.last_edited_at || p.updated_at || "").slice(0, 10);
    console.log(`  ${id}  ${name}  [${status}/${pub}]  edits=${p.edit_count ?? "?"}  last=${last}${url ? "  " + url : ""}`);
  }
  if (visible.length < projects.length) {
    console.log(`  … +${projects.length - visible.length} more (use --limit to show)`);
  }
}

function printDashboardState(state, {
  limit
} = {}) {
  const workspaceLabel = state.currentWorkspace?.name || "(unknown)";
  const workspaceIdSuffix = state.currentWorkspace?.id ? ` (${state.currentWorkspace.id})` : "";
  const workspaceMetaSuffix = state.currentWorkspace?.meta ? ` | ${state.currentWorkspace.meta}` : "";
  const availableWorkspaces = (state.workspaces || [])
    .map((workspace) => `${workspace.name}${workspace.current ? " (current)" : ""}`)
    .join(", ") || "(none)";

  console.log(`Dashboard: ${state.dashboardUrl}`);
  console.log(`Current workspace: ${workspaceLabel}${workspaceIdSuffix}${workspaceMetaSuffix}`);
  console.log(`Available workspaces: ${availableWorkspaces}`);
  console.log(
    `Projects: ${state.projects.length} unique | workspace=${state.collections?.workspace?.count ?? 0} | recent=${state.collections?.recent?.count ?? 0} | shared=${state.collections?.shared?.count ?? 0} | starred=${state.collections?.starred?.count ?? 0}`
  );

  const projects = typeof limit === "number"
    ? state.projects.slice(0, limit)
    : state.projects;

  projects.forEach((project, index) => {
    const label = project.slug && project.slug !== project.title
      ? `${project.title} [${project.slug}]`
      : project.title;
    const workspace = project.workspaceName || (project.workspaceId ? `id:${project.workspaceId}` : "unknown");
    const collections = project.collections?.join(",") || "(none)";
    const details = [
      `[${index}] ${label}`,
      `workspace=${workspace}`,
      `collections=${collections}`,
      `project=${project.projectUrl}`
    ];

    if (project.liveUrl) {
      details.push(`live=${project.liveUrl}`);
    }

    if (project.lastEditedAt) {
      details.push(`lastEdited=${project.lastEditedAt}`);
    } else if (project.lastViewedAt) {
      details.push(`lastViewed=${project.lastViewedAt}`);
    }

    console.log(details.join(" | "));
  });

  if (typeof limit === "number" && state.projects.length > limit) {
    console.log(`Showing first ${limit} of ${state.projects.length} projects.`);
  }
}

function printDomainSettingsState(state) {
  console.log(`Domain settings page: ${state.settingsUrl}`);
  console.log(`Live URL: ${state.liveUrl || "(missing)"}`);
  console.log(`Current subdomain: ${state.subdomain || "(missing)"}`);
  console.log(`Edit URL available: ${state.editUrlAvailable ? "yes" : "no"}`);
  console.log(`Connect existing domain available: ${state.connectExistingDomainAvailable ? "yes" : "no"}`);
  console.log(`Custom domains: ${state.customDomains?.join(", ") || "(none)"}`);
  console.log(
    `Suggested purchase domains: ${state.suggestedPurchaseDomains?.join(", ") || "(none)"}`
  );
}

function printChatActions(actions) {
  if (actions.length === 0) {
    console.log("No visible chat-side actions found. Text-only follow-ups can still go through the prompt command.");
    return;
  }

  actions.forEach((action, index) => {
    const disabledSuffix = action.disabled ? " (disabled)" : "";
    console.log(`[${index}] ${action.label}${disabledSuffix}`);
  });
}

function printQuestionState(state) {
  console.log(`Questions card: ${state.open ? "open" : "closed"}`);

  if (!state.open) {
    return;
  }

  console.log(`Question: ${state.prompt || "(missing)"}`);
  console.log(`Mode: ${state.mode || "(unknown)"}`);
  console.log(
    `Free-text input: ${state.input?.present ? `yes (${state.input.tagName || "unknown"})` : "no"}`
  );
  if (state.input?.present) {
    console.log(`Input placeholder: ${state.input.placeholder || "(none)"}`);
    console.log(`Input value: ${state.input.value || "(empty)"}`);
  }
  console.log(`Actions: ${state.actions?.map((action) => action.label).join(", ") || "(none)"}`);
}

function printRuntimeErrorState(state) {
  console.log(`Runtime error surface: ${state.open ? "open" : "closed"}`);

  if (!state.open) {
    return;
  }

  console.log(`Title: ${state.title || "Error"}`);
  console.log(`Message: ${state.message || "(missing)"}`);
  console.log(`Actions: ${state.actions?.map((action) => action.label).join(", ") || "(none)"}`);
}

function printFindingsState(state) {
  const visibleChatActions = state.chatActionsAfter?.map((action) => action.label).join(", ") || "(none)";

  console.log(`Findings pane: ${state.open ? "open" : "closed"}`);
  console.log(`Visible chat actions: ${visibleChatActions}`);

  if (!state.open) {
    return;
  }

  if (state.clickedAction?.label) {
    console.log(`Opened via action: ${state.clickedAction.label}`);
  }

  console.log(`Panel title: ${state.title || "Security"}`);
  console.log(`Scan title: ${state.scanTitle || "(unknown)"}`);
  console.log(`Scan status: ${state.status || "(unknown)"}`);
  console.log(
    `Issue counts: ${state.counts?.errors ?? 0} errors, ${state.counts?.warnings ?? 0} warnings, ${state.counts?.info ?? 0} info`
  );
  console.log(
    `Advanced view: ${state.advancedViewEnabled === null ? "unknown" : state.advancedViewEnabled ? "on" : "off"}`
  );
  console.log(`Pane actions: ${state.availableActions?.join(", ") || "(none)"}`);
  console.log(`Filters: ${state.availableFilters?.join(", ") || "(none)"}`);
  console.log(`Issue actions: ${state.issueActions?.join(", ") || "(none)"}`);

  if (!state.issues?.length) {
    console.log("Issues: (none)");
    return;
  }

  state.issues.forEach((issue, index) => {
    console.log(`[${index}] ${issue.level || "Issue"}: ${issue.issue || "(missing)"}`);
  });
}

function getChatActionsSignature(actions) {
  return actions
    .map((action) => `${action.label}:${action.disabled ? "disabled" : "enabled"}`)
    .join(" | ");
}

async function waitForChangedChatActions(page, {
  previousActions = [],
  timeoutMs = 10_000,
  pollMs = 250
} = {}) {
  const previousSignature = getChatActionsSignature(previousActions);
  const deadline = Date.now() + timeoutMs;
  let latestActions = previousActions;

  while (Date.now() < deadline) {
    latestActions = await listChatActions(page, {
      timeoutMs: Math.max(pollMs, 250),
      pollMs
    }).catch(() => []);

    if (getChatActionsSignature(latestActions) !== previousSignature) {
      return latestActions;
    }

    await page.waitForTimeout(pollMs);
  }

  return latestActions;
}

async function ensurePromptModeReady(page, mode) {
  if (mode) {
    return setPromptMode(page, { mode });
  }

  const currentMode = await getCurrentPromptMode(page);
  if (!currentMode) {
    return null;
  }

  return {
    changed: false,
    previousMode: currentMode,
    currentMode
  };
}

function promptOptionsRequireBrowser(options = {}) {
  return Boolean(
    options.keepOpen ||
    options.selector ||
    options.submitSelector ||
    options.answerQuestion ||
    options.verifyEffect ||
    options.autoResume
  );
}

async function runApiPromptFlow({
  apiBackend,
  targetUrl,
  promptText,
  attachmentPaths = [],
  options = {}
} = {}) {
  const { normalizedUrl, projectId } = getProjectIdFromUrl(targetUrl);
  const hasPrompt = hasText(promptText);
  const hasAttachments = attachmentPaths.length > 0;
  const warnings = hasPrompt
    ? assertPromptLooksComplete(promptText, {
      allowFragment: Boolean(options.allowFragment)
    })
    : [];
  const parts = hasPrompt
    ? buildPromptSequence(promptText, {
      autoSplit: Boolean(options.autoSplit),
      chunked: Boolean(options.chunked),
      splitBy: options.splitBy
    })
    : [{
      index: 1,
      total: 1,
      rawPrompt: "",
      prompt: "Use the attached files as reference.",
      attachmentOnly: true
    }];
  const sequence = [];
  const mode = normalizePromptModeOption(options.mode);

  for (const warning of warnings) {
    console.log(`Warning: ${warning}`);
  }

  for (const part of parts) {
    const isFinalPart = part.index === part.total;
    const response = await apiBackend.submitPrompt(projectId, {
      message: part.prompt,
      filePaths: part.index === 1 ? attachmentPaths : [],
      planMode: mode === "plan",
      mode,
      wait: isFinalPart,
      pollInterval: options.idlePollMs,
      timeout: options.idleTimeoutMs
    });

    sequence.push({
      backend: "api",
      index: part.index,
      total: part.total,
      chars: part.prompt.length,
      messageId: response.message_id,
      status: response.status,
      completion: response.completion || null,
      attachmentsSent: part.index === 1 ? attachmentPaths.length : 0
    });
    console.log(`API prompt part ${part.index}/${part.total} accepted: ${response.message_id || response.status || "ok"}`);
  }

  if (options.verify) {
    const previewUrl = apiBackend.getPreviewUrl(projectId);
    const verification = await runUrlVerification({
      targetUrl: normalizedUrl,
      captureUrl: previewUrl,
      outputDir: resolveVerifyOutputDir(normalizedUrl, options.verifyOutputDir),
      headless: true,
      settleMs: options.verifySettleMs,
      variants: getVerifyVariants({
        desktopOnly: options.verifyDesktopOnly,
        mobileOnly: options.verifyMobileOnly
      }),
      failOnConsole: Boolean(options.failOnConsole),
      expectText: options.expectText,
      forbidText: options.forbidText,
      sourceLabel: "API post-prompt preview"
    });
    console.log(`Post-prompt verification summary: ${verification.summaryPath}`);
  }

  if (hasAttachments && !hasPrompt) {
    console.log(`Sent ${attachmentPaths.length} attachment(s) with a default reference message.`);
  }

  return {
    backend: "api",
    projectId,
    projectUrl: normalizedUrl,
    sequence
  };
}

async function resolveInitialPrompt({
  prompt,
  promptFile
} = {}) {
  if (prompt && promptFile) {
    throw new Error("Pass either a positional prompt or --prompt-file, not both.");
  }

  if (promptFile) {
    const resolvedPath = path.resolve(promptFile);
    return await fs.readFile(resolvedPath, "utf8");
  }

  if (typeof prompt === "string") {
    return prompt;
  }

  return null;
}

async function resolveAttachmentPaths(values = []) {
  const resolved = [];

  for (const value of Array.isArray(values) ? values : []) {
    const resolvedPath = path.resolve(value);
    const stat = await fs.stat(resolvedPath).catch(() => null);

    if (!stat) {
      throw new Error(`Attachment file does not exist: ${resolvedPath}`);
    }

    if (!stat.isFile()) {
      throw new Error(`Attachment path is not a file: ${resolvedPath}`);
    }

    resolved.push(resolvedPath);
  }

  return resolved;
}

async function resolveAssertionValues({
  values = [],
  filePath
} = {}) {
  const resolved = Array.isArray(values) ? [...values] : [];
  if (!filePath) {
    return resolved;
  }

  const raw = await fs.readFile(path.resolve(filePath), "utf8");
  return [
    ...resolved,
    ...parseAssertionLines(raw)
  ];
}

function formatIdleWaitError(result, {
  contextLabel = "idle wait"
} = {}) {
  const lastStatus = result?.state?.status || result?.reason || "unknown";
  const excerpt = result?.state?.bodyExcerpt
    ? ` Last page text excerpt: ${JSON.stringify(result.state.bodyExcerpt.slice(0, 200))}.`
    : "";

  if (result?.reason === "queue_paused") {
    return `Lovable queue is paused during ${contextLabel}. Re-run with --auto-resume or resume it manually.${excerpt}`;
  }

  if (result?.reason === "waiting_for_input") {
    return `Lovable is waiting for input during ${contextLabel}. Answer the open Questions card before continuing.${excerpt}`;
  }

  if (result?.reason === "error") {
    return `Lovable shows a runtime/build error surface during ${contextLabel}.${excerpt}`;
  }

  if (result?.reason === "timeout") {
    return `Timed out waiting for Lovable to become idle during ${contextLabel}. Last observed state: ${lastStatus}.${excerpt}`;
  }

  return `Lovable did not become idle during ${contextLabel}. Last observed state: ${lastStatus}.${excerpt}`;
}

function printIdleWaitResult(result) {
  console.log(`Idle wait result: ${result.ok ? "idle" : result.reason}`);
  console.log(`Observed state: ${result.state?.status || result.reason || "unknown"}`);
  console.log(`Idle streak: ${result.idleStreak ?? 0}`);
  console.log(`Resume attempts: ${result.resumeAttempts ?? 0}`);
  if (result.state?.visibleActionLabels?.length) {
    console.log(`Visible actions: ${result.state.visibleActionLabels.join(", ")}`);
  }
}

async function ensureProjectIdleOrThrow(page, {
  normalizedUrl,
  waitForIdle = true,
  autoResume = false,
  timeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  pollMs = DEFAULT_IDLE_POLL_MS,
  contextLabel = "idle wait"
} = {}) {
  if (!waitForIdle) {
    const state = await getProjectIdleState(page, {
      timeoutMs: Math.min(pollMs, 750),
      pollMs: Math.min(pollMs, 250)
    });
    return {
      ok: true,
      reason: "skipped",
      idleStreak: 0,
      resumeAttempts: 0,
      projectUrl: normalizedUrl,
      state
    };
  }

  const result = await waitForProjectIdle(page, {
    timeoutMs,
    pollMs,
    autoResume
  });
  const enriched = {
    ...result,
    projectUrl: normalizedUrl
  };

  if (!enriched.ok) {
    throw new Error(formatIdleWaitError(enriched, {
      contextLabel
    }));
  }

  return enriched;
}

async function observePromptFlowState(page, {
  autoResume = false,
  timeoutMs = 5_000,
  pollMs = 500,
  contextLabel = "prompt flow",
  throwOnQuestion = false
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let resumeAttempts = 0;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await getProjectIdleState(page, {
      timeoutMs: Math.min(pollMs, 750),
      pollMs: Math.min(pollMs, 250)
    });

    if (lastState.status === "queue_paused") {
      if (!autoResume) {
        throw new Error(
          `Lovable queue paused during ${contextLabel}. Re-run with --auto-resume or resume it manually.`
        );
      }

      const resumed = await clickQueueResume(page, {
        timeoutMs: Math.max(5_000, pollMs),
        settleMs: 1_000
      });

      if (!resumed) {
        throw new Error(
          `Lovable queue paused during ${contextLabel}, but the CLI could not click Resume queue / Continue queue.`
        );
      }

      resumeAttempts += 1;
      await page.waitForTimeout(pollMs);
      continue;
    }

    if (lastState.status === "error") {
      throw new Error(
        `Lovable showed a runtime/build error surface during ${contextLabel}.`
      );
    }

    if (lastState.status === "waiting_for_input" && throwOnQuestion) {
      throw new Error(
        `Lovable opened a Questions card during ${contextLabel}. Answer it before continuing.`
      );
    }

    await page.waitForTimeout(pollMs);
  }

  return {
    state: lastState,
    resumeAttempts
  };
}

async function runPromptSequence(page, {
  normalizedUrl,
  prompt,
  attachmentPaths = [],
  autoSplit = true,
  chunked = false,
  splitBy,
  allowFragment = false,
  selector,
  submitSelector,
  postSubmitTimeoutMs = 20_000,
  verificationTimeoutMs = 600_000,
  headless = false,
  questionTimeoutMs = 8_000,
  autoResume = false
} = {}) {
  const normalizedPrompt = String(prompt || "");
  const hasPrompt = hasText(normalizedPrompt);
  const hasAttachments = Array.isArray(attachmentPaths) && attachmentPaths.length > 0;

  if (!hasPrompt && !hasAttachments) {
    return [];
  }

  const warnings = hasPrompt
    ? assertPromptLooksComplete(normalizedPrompt, {
      allowFragment
    })
    : [];
  const parts = hasPrompt
    ? buildPromptSequence(normalizedPrompt, {
      autoSplit,
      chunked,
      splitBy
    })
    : [{
      index: 1,
      total: 1,
      rawPrompt: "",
      prompt: "",
      autoSplit: false,
      attachmentOnly: true
    }];
  const sequence = [];

  for (const part of parts) {
    const isFinalPart = part.index === part.total;
    const lenientAck = !part.attachmentOnly &&
      part.total === 1 &&
      shouldUseLenientPromptAck(part.rawPrompt);
    const turnPostSubmitTimeoutMs = getPromptTurnPostSubmitTimeoutMs({
      prompt: part.rawPrompt,
      baseTimeoutMs: postSubmitTimeoutMs,
      partIndex: part.index,
      totalParts: part.total
    });
    const turn = await runPromptTurn(page, {
      normalizedUrl,
      prompt: part.prompt,
      attachmentPaths: part.index === 1 ? attachmentPaths : [],
      selector,
      submitSelector,
      postSubmitTimeoutMs: turnPostSubmitTimeoutMs,
      verificationTimeoutMs,
      headless,
      requireLocalAck: isFinalPart && part.total === 1 && !lenientAck,
      requirePersistence: isFinalPart,
      autoResumeQueue: Boolean(autoResume),
      persistenceRetries: isFinalPart && (part.total > 1 || lenientAck) ? 2 : 0,
      persistenceRetryDelayMs: 5_000,
      persistenceSettleMs: isFinalPart && (part.total > 1 || lenientAck) ? 10_000 : 6_000
    });

    const entry = {
      ...part,
      lenientAck,
      warnings: part.index === 1 ? warnings : [],
      ...turn
    };
    sequence.push(entry);

    const flowState = await observePromptFlowState(page, {
      autoResume: Boolean(autoResume),
      timeoutMs: part.total > 1 ? 4_000 : 2_000,
      pollMs: 500,
      contextLabel: sequence.length > 1
        ? `prompt part ${part.index}/${part.total}`
        : "prompt submission",
      throwOnQuestion: false
    });
    entry.flowState = flowState;

    if (part.total > 1 && part.index < part.total) {
      const questionState = await getProjectQuestionState(page, {
        timeoutMs: Math.min(questionTimeoutMs, 1_000),
        pollMs: 250
      }).catch(() => ({
        open: false
      }));

      if (questionState.open) {
        throw new Error(
          `Lovable opened a Questions card before the final prompt part (${part.index}/${part.total}). Shorten the prompt or answer the question manually before continuing.`
        );
      }
    }
  }

  return sequence;
}

function printPromptSequenceLogs(sequence, {
  prefix
} = {}) {
  if (!Array.isArray(sequence) || sequence.length === 0) {
    return;
  }

  const basePrefix = prefix ? `${prefix}: ` : "";
  const firstEntry = sequence[0];
  if (firstEntry?.warnings?.length > 0) {
    console.log(`${basePrefix}Prompt warnings: ${firstEntry.warnings.join(" ")}`);
  }

  if (sequence.length > 1) {
    console.log(`${basePrefix}Prompt auto-split into ${sequence.length} parts.`);
  }

  sequence.forEach((entry) => {
    const label = sequence.length > 1
      ? `${basePrefix}Prompt part ${entry.index}/${entry.total}`
      : `${basePrefix}Prompt`;
    if (entry.fillResult.method === "attachmentOnly") {
      console.log(`${label}: sending attachments without prompt text.`);
    } else {
      console.log(`${label} filled via ${entry.fillResult.method} (${entry.fillResult.tagName}).`);
    }
    console.log(`${label} submitted via ${entry.submitResult.method}.`);
    if (entry.chatAccepted?.ok) {
      console.log(`${label}: Lovable accepted the chat request on the server.`);
    }
    if (entry.attachmentResult?.uploaded?.length > 0) {
      console.log(`${label}: attached ${entry.attachmentResult.uploaded.join(", ")}.`);
    }
    if (!entry.postSubmit?.ok && (entry.total > 1 || entry.lenientAck)) {
      console.log(`${label}: no immediate local echo detected; relying on server acceptance and final persistence checks.`);
    }
    if (entry.verificationResolved?.ok) {
      console.log(`${label}: Interactive verification cleared.`);
    }
    if (entry.persisted?.ok) {
      console.log(`${label}: Lovable acknowledged the prompt and it persisted after reload.`);
    }
  });
}

function resolveFidelityOutputDir(targetUrl, outputDir) {
  if (outputDir) {
    return path.resolve(outputDir);
  }

  const projectId = targetUrl.match(/\/projects\/([^/?#]+)/)?.[1] || "project";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(process.cwd(), "output", "fidelity-loop", `${projectId}-${timestamp}`);
}

function extractFidelityGaps(summary = {}) {
  const missingExpectedTexts = [];
  const forbiddenTextsFound = [];
  const missingSeen = new Set();
  const forbiddenSeen = new Set();

  for (const capture of summary.captures || []) {
    for (const value of capture?.snapshot?.missingExpectedTexts || []) {
      if (!missingSeen.has(value)) {
        missingSeen.add(value);
        missingExpectedTexts.push(value);
      }
    }
    for (const value of capture?.snapshot?.forbiddenTextsFound || []) {
      if (!forbiddenSeen.has(value)) {
        forbiddenSeen.add(value);
        forbiddenTextsFound.push(value);
      }
    }
  }

  return {
    missingExpectedTexts,
    forbiddenTextsFound
  };
}

function printFidelityLoopResult(result) {
  console.log(`Fidelity loop project: ${result.projectUrl}`);
  console.log(`Success: ${result.success ? "yes" : "no"}`);
  console.log(`Iterations: ${result.iterations.length}/${result.maxIterations}`);
  console.log(`Output: ${result.outputDir}`);

  result.iterations.forEach((iteration) => {
    const blockingReason = iteration.blocking?.reason || "none";
    console.log(`[${iteration.iteration}] blocking=${blockingReason}`);
    console.log(`  summary=${iteration.summaryPath}`);
    console.log(
      `  missing=${iteration.gaps?.missingExpectedTexts?.join(", ") || "(none)"}`
    );
    console.log(
      `  forbidden=${iteration.gaps?.forbiddenTextsFound?.join(", ") || "(none)"}`
    );
  });
}

async function runPromptTurn(page, {
  normalizedUrl,
  prompt,
  attachmentPaths = [],
  selector,
  submitSelector,
  postSubmitTimeoutMs = 20_000,
  verificationTimeoutMs = 600_000,
  headless = false,
  requireLocalAck = true,
  requirePersistence = true,
  autoResumeQueue = false,
  persistenceRetries = 0,
  persistenceRetryDelayMs = 5_000,
  persistenceSettleMs = 6_000
}) {
  const attachmentNames = Array.isArray(attachmentPaths)
    ? attachmentPaths.map((filePath) => path.basename(filePath))
    : [];
  let attachmentResult = null;
  if (Array.isArray(attachmentPaths) && attachmentPaths.length > 0) {
    attachmentResult = await uploadPromptAttachments(page, attachmentPaths, {
      timeoutMs: 15_000,
      pollMs: 250
    });
  }

  const fillResult = hasText(prompt)
    ? await fillPrompt(page, prompt, { selector })
    : {
      method: "attachmentOnly",
      tagName: "none"
    };
  await page.waitForTimeout(400);

  const chatAcceptance = waitForChatAcceptance(page, {
    projectUrl: normalizedUrl,
    timeoutMs: Math.max(postSubmitTimeoutMs, 120_000) + (headless ? 0 : verificationTimeoutMs)
  });
  const submitResult = await submitPrompt(page, { submitSelector });
  const postSubmit = await waitForPromptResult(page, {
    prompt,
    attachmentNames,
    timeoutMs: postSubmitTimeoutMs
  });

  let verificationResolved = null;

  if (!postSubmit.ok) {
    if (postSubmit.reason === "verification_required") {
      if (headless) {
        throw new Error(
          "Lovable requested an interactive verification after submit. Re-run without --headless and complete the verification in the browser."
        );
      }

      console.log("Lovable requested interactive verification. Complete it in the opened browser window.");
      verificationResolved = await waitForVerificationResolution(page, {
        prompt,
        attachmentNames,
        timeoutMs: verificationTimeoutMs
      });

      if (!verificationResolved.ok) {
        throw new Error(
          "Lovable did not clear the interactive verification within the expected time."
        );
      }

      console.log("Interactive verification cleared. Checking whether the prompt persisted after reload.");
    } else if (requireLocalAck) {
      throw new Error(
        "Lovable did not acknowledge the prompt within the expected time."
      );
    }
  }

  const chatAccepted = await chatAcceptance;
  if (!chatAccepted.ok) {
    if (chatAccepted.reason === "verification_required") {
      throw new Error(
        "Lovable did not finish the verification-backed chat submit on the server. Re-run without --headless and complete any challenge in the browser."
      );
    }

    const statusSuffix = chatAccepted.status ? ` Last chat status: ${chatAccepted.status}.` : "";
    throw new Error(
      `Lovable never confirmed the chat request on the server.${statusSuffix}`
    );
  }

  let persisted = {
    ok: false,
    reason: "skipped",
    state: null
  };

  if (requirePersistence) {
    for (let attempt = 0; attempt <= persistenceRetries; attempt += 1) {
      await observePromptFlowState(page, {
        autoResume: Boolean(autoResumeQueue),
        timeoutMs: 3_000,
        pollMs: 500,
        contextLabel: "prompt persistence check",
        throwOnQuestion: true
      });

      persisted = await confirmPromptPersistsAfterReload(page, {
        prompt,
        attachmentNames,
        timeoutMs: postSubmitTimeoutMs,
        settleMs: persistenceSettleMs
      });

      if (persisted.ok || persisted.reason === "verification_required" || attempt >= persistenceRetries) {
        break;
      }

      await page.waitForTimeout(persistenceRetryDelayMs);
    }

    if (!persisted.ok) {
      if (persisted.reason === "verification_required") {
        throw new Error(
          "Lovable requested another interactive verification during the reload check. Re-run without --headless and complete the verification in the browser."
        );
      }

      throw new Error(
        "Lovable showed the prompt locally, but it did not persist after a page reload."
      );
    }
  }

  return {
    attachmentResult,
    fillResult,
    submitResult,
    verificationResolved,
    chatAccepted,
    postSubmit,
    persisted
  };
}

function getBlockingReason(capture, {
  failOnConsole = false
} = {}) {
  if (capture.status && capture.status >= 400) {
    return `HTTP status ${capture.status}`;
  }

  if (capture.pageErrors.length > 0) {
    return "page errors";
  }

  if (capture.failedRequests.length > 0) {
    return "failed requests";
  }

  if ((capture.snapshot.layoutIssues || []).length > 0) {
    return "layout issues";
  }

  if ((capture.snapshot.missingExpectedTexts || []).length > 0) {
    return `missing expected text: ${capture.snapshot.missingExpectedTexts.join(", ")}`;
  }

  if ((capture.snapshot.forbiddenTextsFound || []).length > 0) {
    return `forbidden text found: ${capture.snapshot.forbiddenTextsFound.join(", ")}`;
  }

  if (capture.snapshot.bodyTextLength === 0) {
    return "empty body text";
  }

  if (failOnConsole && capture.consoleEntries.length > 0) {
    return "console issues";
  }

  return null;
}

async function runPreviewVerification({
  page,
  normalizedUrl,
  outputDir,
  headless,
  settleMs,
  variants,
  routes = ["/"],
  explicitRoutes = false,
  failOnConsole = false,
  expectText = [],
  forbidText = [],
  sourceLabel = "Preview",
  throwOnBlocking = true,
  profileDir = null,
  precomputedPreviewInfo = null
}) {
  const previewInfo = precomputedPreviewInfo || await getProjectPreviewInfo(page);
  return runUrlVerification({
    targetUrl: normalizedUrl,
    captureUrl: previewInfo.src,
    outputDir,
    headless,
    settleMs,
    variants,
    routes,
    explicitRoutes,
    failOnConsole,
    expectText,
    forbidText,
    sourceLabel,
    summarySourceKey: "previewSource",
    throwOnBlocking,
    profileDir
  });
}

async function runUrlVerification({
  targetUrl,
  captureUrl,
  outputDir,
  headless,
  settleMs,
  variants,
  routes = ["/"],
  explicitRoutes = false,
  failOnConsole = false,
  expectText = [],
  forbidText = [],
  sourceLabel = "Preview",
  summarySourceKey = "captureSource",
  throwOnBlocking = true,
  profileDir = null
}) {
  if (!captureUrl) {
    throw new Error(`${sourceLabel} URL is missing.`);
  }

  console.log(`${sourceLabel} source found: ${redactPreviewUrl(captureUrl)}`);

  const normalizedRoutes = getVerificationRoutes(routes);
  const summary = {
    projectUrl: targetUrl,
    [summarySourceKey]: redactPreviewUrl(captureUrl),
    settings: {
      routes: normalizedRoutes,
      variants,
      settleMs,
      headless,
      failOnConsole,
      expectText,
      forbidText
    },
    captures: [],
    routes: []
  };

  await fs.mkdir(outputDir, { recursive: true });

  for (const route of normalizedRoutes) {
    const captureRouteUrl = buildPreviewRouteUrl(captureUrl, route);
    const routeEntry = {
      route,
      captureSource: redactPreviewUrl(captureRouteUrl),
      captures: []
    };

    console.log(`${sourceLabel} route ${route}: ${redactPreviewUrl(captureRouteUrl)}`);

    for (const variant of variants) {
      const isMobile = variant === "mobile";
      const screenshotFilename = getVerificationScreenshotFilename(variant, route, {
        explicitRoute: explicitRoutes
      });
      const screenshotPath = path.resolve(outputDir, screenshotFilename);
      const result = await capturePreviewSnapshot({
        previewUrl: captureRouteUrl,
        outputPath: screenshotPath,
        viewport: isMobile
          ? { width: 390, height: 844 }
          : { width: 1440, height: 900 },
        isMobile,
        hasTouch: isMobile,
        headless,
        settleMs,
        expectText,
        forbidText,
        profileDir
      });

      console.log(`${capitalize(variant)} screenshot (${route}): ${result.outputPath}`);
      console.log(
        `${capitalize(variant)} ${sourceLabel.toLowerCase()} status (${route}): ${result.status ?? "unknown"}, console issues: ${result.consoleEntries.length}, page errors: ${result.pageErrors.length}, failed requests: ${result.failedRequests.length}, body text length: ${result.snapshot.bodyTextLength}`
      );

      const captureEntry = {
        route,
        variant,
        screenshotPath: result.outputPath,
        status: result.status,
        finalUrl: result.finalUrl,
        consoleEntries: result.consoleEntries,
        pageErrors: result.pageErrors,
        failedRequests: result.failedRequests,
        snapshot: result.snapshot
      };

      routeEntry.captures.push(captureEntry);
      summary.captures.push(captureEntry);
    }

    const blockingCapture = routeEntry.captures.find((capture) => {
      return Boolean(getBlockingReason(capture, { failOnConsole }));
    });

    if (blockingCapture) {
      routeEntry.blocking = {
        variant: blockingCapture.variant,
        reason: getBlockingReason(blockingCapture, { failOnConsole })
      };
    }

    summary.routes.push(routeEntry);
  }

  const blockingCapture = summary.captures.find((capture) => {
    return Boolean(getBlockingReason(capture, { failOnConsole }));
  });

  if (blockingCapture) {
    summary.blocking = {
      route: blockingCapture.route,
      variant: blockingCapture.variant,
      reason: getBlockingReason(blockingCapture, { failOnConsole })
    };
  }

  const summaryPath = path.resolve(outputDir, "summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`Verification summary: ${summaryPath}`);

  if (blockingCapture && throwOnBlocking) {
    throw new Error(
      `${sourceLabel} verification found blocking issues in the ${blockingCapture.variant} capture (${summary.blocking.reason}). See ${summaryPath}.`
    );
  }

  return {
    summary,
    summaryPath
  };
}

function resolveVerifyOutputDir(targetUrl, outputDir) {
  if (outputDir) {
    return path.resolve(outputDir);
  }

  const projectId = targetUrl.match(/\/projects\/([^/?#]+)/)?.[1] || "project";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(process.cwd(), "output", "verify", `${projectId}-${timestamp}`);
}

function resolveLiveVerifyOutputDir(targetUrl, outputDir) {
  if (outputDir) {
    return path.resolve(outputDir);
  }

  const projectId = targetUrl.match(/\/projects\/([^/?#]+)/)?.[1] || "project";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(process.cwd(), "output", "live-verify", `${projectId}-${timestamp}`);
}

function resolveSpeedOutputDir(targetUrl, outputDir) {
  if (outputDir) {
    return path.resolve(outputDir);
  }

  const projectId = targetUrl.match(/\/projects\/([^/?#]+)/)?.[1] || "project";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(process.cwd(), "output", "speed", `${projectId}-${timestamp}`);
}

function redactPreviewUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

async function openUrl(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "start"
      : "xdg-open";

  if (command === "start") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore"
    }).unref();
    return;
  }

  spawn(command, [url], {
    detached: true,
    stdio: "ignore"
  }).unref();
}
