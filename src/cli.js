#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

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
  connectProjectDomain,
  connectProjectGitProvider,
  clickQuestionAction,
  clickRuntimeErrorAction,
  disconnectProjectGitProvider,
  ensureSignedIn,
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
  readFirebaseAuthUsers,
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
  parseAssertionLines,
  shouldUseLenientPromptAck
} from "./orchestration.js";
import { pathExists, seedDesktopProfileIntoPlaywrightDefault } from "./profile.js";
import { buildCreateUrl, normalizeTargetUrl } from "./url.js";

const program = new Command();

program
  .name("lovagentic")
  .description("Prototype CLI for steering Lovable from the local machine.")
  .version("0.1.0");

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

    const { checks, playwrightDefaultDir } = result;
    const failed = checks.filter((c) => !c.ok);

    if (options.json) {
      console.log(JSON.stringify({
        ok: failed.length === 0,
        failed: failed.map((c) => c.key),
        healed: healedActions,
        checks,
        paths: { profileDir, desktopProfileDir, playwrightDefaultDir },
        node: process.version,
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
  const mcpConfigured = Boolean(process.env.LOVABLE_MCP_URL);

  const checks = [
    { key: "node", label: `Node.js ${process.version}`, ok: nodeOk, healable: false, hint: nodeOk ? null : "lovagentic requires Node 20+. Upgrade Node before continuing." },
    { key: "desktopApp", label: `Lovable.app (${DEFAULT_DESKTOP_APP_PATH})`, ok: desktopAppInstalled, healable: false, hint: desktopAppInstalled ? null : "Lovable desktop app not installed. Download from https://lovable.dev/download — required to seed a session." },
    { key: "desktopProfile", label: `Desktop profile (${desktopProfileDir})`, ok: desktopProfileExists, healable: false, hint: desktopProfileExists ? null : "Launch Lovable.app at least once and sign in before running lovagentic." },
    { key: "desktopCookies", label: "Desktop cookies", ok: desktopCookieFileExists, healable: false, hint: desktopCookieFileExists ? null : "No Lovable session found in the desktop profile. Sign in to Lovable.app first." },
    { key: "cliProfile", label: `CLI profile (${profileDir})`, ok: cliProfileExists, healable: true, hint: cliProfileExists ? null : "Run `lovagentic login`, `lovagentic import-desktop-session`, or `lovagentic doctor --self-heal`." },
    { key: "cliCookies", label: "CLI cookies", ok: cliCookieFileExists, healable: true, hint: cliCookieFileExists ? null : "CLI profile has no session. Run `lovagentic import-desktop-session` or `lovagentic doctor --self-heal`." },
    { key: "playwright", label: `Playwright (${pwStatus.version ?? "not installed"})`, ok: pwStatus.installed, healable: false, hint: pwStatus.installed ? null : "Run `npm install` in the lovagentic repo, or install the npm package." },
    { key: "chromium", label: "Playwright Chromium binary", ok: pwStatus.chromium, healable: true, hint: pwStatus.chromium ? null : "Run `npx playwright install chromium`, or `lovagentic doctor --self-heal`." },
    { key: "mcp", label: `MCP backend (${mcpConfigured ? "configured" : "not configured"})`, ok: true, healable: false, hint: mcpConfigured ? null : "LOVABLE_MCP_URL not set. Using browser backend. MCP support ships in v0.2." }
  ];

  return { checks, playwrightDefaultDir };
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
  .option("--json", "Print the extracted dashboard state as JSON", false)
  .action(async (options) => {
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
  .option("--headless", "Run automated create flow headlessly", false)
  .option("--wait-for-project-ms <ms>", "Wait timeout for project creation", parseInteger, 480000)
  .option("--keep-open", "Leave the browser open after project creation", false)
  .option("--no-open", "Print the URL without opening it")
  .option("--no-autosubmit", "Disable autosubmit in the generated URL")
  .action(async (prompt, options) => {
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
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--seed-desktop-session", "Refresh the Playwright profile from the desktop app before launch", false)
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .option("--headless", "Run headlessly instead of opening a visible browser", false)
  .option("--keep-open", "Leave the browser window open after prompt submission", false)
  .option("--mode <mode>", "Switch Lovable to build or plan before sending")
  .option("--verify", "Capture preview screenshots after the prompt persisted", false)
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
    const profileDir = getProfileDir(options.profileDir);
    const attachmentPaths = await resolveAttachmentPaths(options.file);
    if (!hasText(prompt) && attachmentPaths.length === 0) {
      throw new Error("Pass a prompt, --file, or both.");
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
          if (answerResult.stateAfter?.open) {
            console.log("Lovable still shows a question card after the submitted answer.");
          }
        } else {
          console.log("Lovable is waiting for an answer. Use `questions` / `question-answer`, or re-run with --answer-question.");
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

      const result = await publishProject(page, {
        timeoutMs: options.timeoutMs,
        liveUrlTimeoutMs: options.liveUrlTimeoutMs,
        pollMs: options.pollMs
      });

      if (result.alreadyPublished) {
        console.log("Project is already published.");
      } else if (result.updatedExisting) {
        console.log("Lovable updated the published site.");
      } else {
        console.log("Lovable completed the publish flow.");
        if (result.siteInfoUpdated) {
          console.log("Lovable auto-updated the site metadata in index.html because the website info step was incomplete.");
        }
      }

      if (result.deploymentId) {
        console.log(`Deployment ID: ${result.deploymentId}`);
      }

      if (result.liveUrl) {
        console.log(`Live URL: ${result.liveUrl}`);
      }

      if (result.liveCheck?.status) {
        console.log(`Live URL status: ${result.liveCheck.status}`);
      } else if (result.liveCheck?.error) {
        console.log(`Live URL probe error: ${result.liveCheck.error}`);
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
        console.log(`Live verification summary: ${verification.summaryPath}`);
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
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
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
  .option("--json", "Print machine-readable JSON", false)
  .action(async (targetUrl, options) => {
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
  .option("--headed", "Run the extraction and preview captures visibly", false)
  .option("--no-wait-for-idle", "Skip waiting for Lovable to become idle before preview capture")
  .option("--auto-resume", "Automatically click Resume queue / Continue queue while waiting for idle", false)
  .option("--idle-timeout-ms <ms>", "How long to wait for Lovable to become idle before preview capture", parseInteger, DEFAULT_IDLE_TIMEOUT_MS)
  .option("--idle-poll-ms <ms>", "Polling interval while waiting for Lovable to become idle", parseInteger, DEFAULT_IDLE_POLL_MS)
  .option("--settle-ms <ms>", "Extra wait time before each screenshot", parseInteger, 4000)
  .option("--fail-on-console", "Treat preview console warnings/errors as blocking", false)
  .option("--expect-text <text>", "Assert that preview body text contains this string", collectValues, [])
  .option("--forbid-text <text>", "Assert that preview body text does not contain this string", collectValues, [])
  .action(async (targetUrl, options) => {
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

      await runPreviewVerification({
        page,
        normalizedUrl,
        outputDir,
        headless,
        settleMs: options.settleMs,
        variants,
        failOnConsole: Boolean(options.failOnConsole),
        expectText: options.expectText,
        forbidText: options.forbidText,
        sourceLabel: "Preview"
      });
    } finally {
      await context.close();
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
      autoSplit
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
  failOnConsole = false,
  expectText = [],
  forbidText = [],
  sourceLabel = "Preview",
  throwOnBlocking = true
}) {
  const previewInfo = await getProjectPreviewInfo(page);
  return runUrlVerification({
    targetUrl: normalizedUrl,
    captureUrl: previewInfo.src,
    outputDir,
    headless,
    settleMs,
    variants,
    failOnConsole,
    expectText,
    forbidText,
    sourceLabel,
    summarySourceKey: "previewSource",
    throwOnBlocking
  });
}

async function runUrlVerification({
  targetUrl,
  captureUrl,
  outputDir,
  headless,
  settleMs,
  variants,
  failOnConsole = false,
  expectText = [],
  forbidText = [],
  sourceLabel = "Preview",
  summarySourceKey = "captureSource",
  throwOnBlocking = true
}) {
  if (!captureUrl) {
    throw new Error(`${sourceLabel} URL is missing.`);
  }

  console.log(`${sourceLabel} source found: ${redactPreviewUrl(captureUrl)}`);

  const summary = {
    projectUrl: targetUrl,
    [summarySourceKey]: redactPreviewUrl(captureUrl),
    settings: {
      variants,
      settleMs,
      headless,
      failOnConsole,
      expectText,
      forbidText
    },
    captures: []
  };

  await fs.mkdir(outputDir, { recursive: true });

  for (const variant of variants) {
    const isMobile = variant === "mobile";
    const screenshotPath = path.resolve(outputDir, `${variant}.png`);
    const result = await capturePreviewSnapshot({
      previewUrl: captureUrl,
      outputPath: screenshotPath,
      viewport: isMobile
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 },
      isMobile,
      hasTouch: isMobile,
      headless,
      settleMs,
      expectText,
      forbidText
    });

    console.log(`${capitalize(variant)} screenshot: ${result.outputPath}`);
    console.log(
      `${capitalize(variant)} ${sourceLabel.toLowerCase()} status: ${result.status ?? "unknown"}, console issues: ${result.consoleEntries.length}, page errors: ${result.pageErrors.length}, failed requests: ${result.failedRequests.length}, body text length: ${result.snapshot.bodyTextLength}`
    );

    summary.captures.push({
      variant,
      screenshotPath: result.outputPath,
      status: result.status,
      finalUrl: result.finalUrl,
      consoleEntries: result.consoleEntries,
      pageErrors: result.pageErrors,
      failedRequests: result.failedRequests,
      snapshot: result.snapshot
    });
  }

  const blockingCapture = summary.captures.find((capture) => {
    return Boolean(getBlockingReason(capture, { failOnConsole }));
  });

  if (blockingCapture) {
    summary.blocking = {
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
