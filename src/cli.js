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
  clickQuestionAction,
  clickRuntimeErrorAction,
  ensureSignedIn,
  fillPrompt,
  getDashboardState,
  getCurrentPromptMode,
  getProjectFindingsState,
  getProjectDomainSettingsState,
  getProjectQuestionState,
  getProjectRuntimeErrorState,
  getPublishedSettingsState,
  hasLovableSession,
  getProjectPreviewInfo,
  launchLovableContext,
  listChatActions,
  publishProject,
  readFirebaseAuthUsers,
  runCreateFlow,
  setPromptMode,
  submitPrompt,
  confirmPromptPersistsAfterReload,
  updateProjectSubdomain,
  updatePublishedSettings,
  waitForChatAcceptance,
  waitForPromptResult,
  waitForVerificationResolution,
  waitForLovableSession
} from "./browser.js";
import { pathExists, seedDesktopProfileIntoPlaywrightDefault } from "./profile.js";
import { buildCreateUrl, normalizeTargetUrl } from "./url.js";

const program = new Command();

program
  .name("lovable-cli")
  .description("Prototype CLI for steering Lovable from the local machine.")
  .version("0.1.0");

program
  .command("doctor")
  .description("Inspect the local Lovable desktop install and CLI profile.")
  .option("--profile-dir <path>", "Override the CLI browser profile path")
  .option("--desktop-profile-dir <path>", "Override the Lovable desktop profile path")
  .action(async (options) => {
    const profileDir = getProfileDir(options.profileDir);
    const desktopProfileDir = getDesktopProfileDir(options.desktopProfileDir);
    const playwrightDefaultDir = getPlaywrightDefaultProfileDir(profileDir);

    const desktopAppInstalled = await pathExists(DEFAULT_DESKTOP_APP_PATH);
    const desktopProfileExists = await pathExists(desktopProfileDir);
    const cliProfileExists = await pathExists(profileDir);
    const cliCookieFileExists = await pathExists(`${playwrightDefaultDir}/Cookies`);
    const desktopCookieFileExists = await pathExists(`${desktopProfileDir}/Cookies`);

    console.log(`Lovable.app: ${desktopAppInstalled ? "found" : "missing"} (${DEFAULT_DESKTOP_APP_PATH})`);
    console.log(`Desktop profile: ${desktopProfileExists ? "found" : "missing"} (${desktopProfileDir})`);
    console.log(`Desktop cookies: ${desktopCookieFileExists ? "present" : "missing"}`);
    console.log(`CLI profile: ${cliProfileExists ? "found" : "missing"} (${profileDir})`);
    console.log(`CLI Playwright Default: ${playwrightDefaultDir}`);
    console.log(`CLI cookies: ${cliCookieFileExists ? "present" : "missing"}`);
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
            `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
  .argument("<prompt>", "Follow-up prompt")
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
  .option("--allow-fragment", "Send a prompt even if it looks truncated or unfinished", false)
  .option("--answer-question <text>", "If Lovable opens a Questions card after the prompt, answer it with this text")
  .option("--question-option <label>", "Question option label to target before filling free text", "Other")
  .option("--question-timeout-ms <ms>", "How long to wait for a delayed Questions card after the prompt", parseInteger, 8_000)
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
        );
      }

      const modeResult = await ensurePromptModeReady(page, options.mode);
      if (modeResult?.currentMode) {
        console.log(`Lovable mode ready: ${modeResult.currentMode}`);
      }

      const promptWarnings = assertPromptLooksComplete(prompt, {
        allowFragment: Boolean(options.allowFragment)
      });
      if (promptWarnings.length > 0) {
        console.log(`Prompt guard bypassed: ${promptWarnings.join(" ")}`);
      }

      const promptTurn = await runPromptTurn(page, {
        normalizedUrl,
        prompt,
        selector: options.selector,
        submitSelector: options.submitSelector,
        postSubmitTimeoutMs: options.postSubmitTimeoutMs,
        verificationTimeoutMs: options.verificationTimeoutMs,
        headless: Boolean(options.headless)
      });

      console.log(`Prompt filled via ${promptTurn.fillResult.method} (${promptTurn.fillResult.tagName}).`);
      if (promptTurn.submitResult.selector) {
        console.log(`Prompt submitted via ${promptTurn.submitResult.method} (${promptTurn.submitResult.selector}).`);
      } else {
        console.log(`Prompt submitted via ${promptTurn.submitResult.method} (${promptTurn.submitResult.shortcut}).`);
      }
      console.log("Lovable accepted the chat request on the server.");
      console.log("Lovable acknowledged the prompt and it persisted after reload.");
      if (promptTurn.verificationResolved?.reason) {
        console.log(`Verification path: ${promptTurn.verificationResolved.reason}.`);
      }

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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
  .option("--timeout-ms <ms>", "How long to wait for the question field", parseInteger, 15_000)
  .option("--settle-ms <ms>", "Extra wait time after clicking Submit", parseInteger, 1_500)
  .option("--actions-timeout-ms <ms>", "How long to wait for the question card before and after submit", parseInteger, 5_000)
  .option("--actions-poll-ms <ms>", "Polling interval while waiting for the question card", parseInteger, 250)
  .option("--chat-accept-timeout-ms <ms>", "How long to wait for Lovable to accept the answer on the server", parseInteger, 30_000)
  .option("--no-submit", "Only fill the free-text field; do not click Submit")
  .action(async (targetUrl, answer, options) => {
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
        );
      }

      const result = await answerProjectQuestion(page, {
        projectUrl: normalizedUrl,
        answer,
        optionLabel: options.option,
        submit: Boolean(options.submit),
        timeoutMs: options.timeoutMs,
        settleMs: options.settleMs,
        actionsTimeoutMs: options.actionsTimeoutMs,
        actionsPollMs: options.actionsPollMs,
        chatAcceptTimeoutMs: options.chatAcceptTimeoutMs
      });

      console.log(`Filled question via ${result.fillResult.method} (${result.fillResult.tagName}).`);
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
  .option("--allow-fragment", "Send a prompt even if it looks truncated or unfinished", false)
  .option("--answer-question <text>", "If Lovable opens a Questions card after the prompt, answer it with this text")
  .option("--question-option <label>", "Question option label to target before filling free text", "Other")
  .option("--question-timeout-ms <ms>", "How long to wait for a delayed Questions card after the prompt", parseInteger, 8_000)
  .option("--wait-after-loop-ms <ms>", "Delay before the browser closes after the loop", parseInteger, 4_000)
  .action(async (targetUrl, prompt, options) => {
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
        );
      }

      const modeResult = await ensurePromptModeReady(page, options.mode);
      if (modeResult?.currentMode) {
        console.log(`Lovable mode ready: ${modeResult.currentMode}`);
      }

      let currentActions = [];
      if (prompt) {
        const promptWarnings = assertPromptLooksComplete(prompt, {
          allowFragment: Boolean(options.allowFragment)
        });
        if (promptWarnings.length > 0) {
          console.log(`Prompt guard bypassed: ${promptWarnings.join(" ")}`);
        }

        const baselineActions = await listChatActions(page, {
          timeoutMs: Math.min(options.waitForActionsMs, 1_000),
          pollMs: options.actionPollMs
        }).catch(() => []);

        const promptTurn = await runPromptTurn(page, {
          normalizedUrl,
          prompt,
          selector: options.selector,
          submitSelector: options.submitSelector,
          postSubmitTimeoutMs: options.postSubmitTimeoutMs,
          verificationTimeoutMs: options.verificationTimeoutMs,
          headless: Boolean(options.headless)
        });

        console.log(`Prompt filled via ${promptTurn.fillResult.method} (${promptTurn.fillResult.tagName}).`);
        if (promptTurn.submitResult.selector) {
          console.log(`Prompt submitted via ${promptTurn.submitResult.method} (${promptTurn.submitResult.selector}).`);
        } else {
          console.log(`Prompt submitted via ${promptTurn.submitResult.method} (${promptTurn.submitResult.shortcut}).`);
        }
        console.log("Lovable accepted the chat request on the server.");
        console.log("Lovable acknowledged the prompt and it persisted after reload.");
        if (promptTurn.verificationResolved?.reason) {
          console.log(`Verification path: ${promptTurn.verificationResolved.reason}.`);
        }

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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
        );
      }

      if (options.subdomain) {
        const result = await updateProjectSubdomain(page, {
          projectUrl: normalizedUrl,
          subdomain: options.subdomain,
          timeoutMs: options.timeoutMs,
          liveUrlTimeoutMs: options.liveUrlTimeoutMs,
          pollMs: options.pollMs
        });

        if (result.changed) {
          console.log(`Updated project subdomain to ${result.finalState.subdomain}.`);
        } else {
          console.log(`Project already uses the ${result.finalState.subdomain} subdomain.`);
        }

        if (result.liveUrl) {
          console.log(`Live URL: ${result.liveUrl}`);
        }

        if (result.liveCheck?.status) {
          console.log(`Live URL status: ${result.liveCheck.status}`);
        } else if (result.liveCheck?.error) {
          console.log(`Live URL probe error: ${result.liveCheck.error}`);
        }

        printDomainSettingsState(result.finalState);
      } else {
        const state = await getProjectDomainSettingsState(page, {
          projectUrl: normalizedUrl,
          timeoutMs: options.timeoutMs
        });
        printDomainSettingsState(state);
      }
    } finally {
      await context.close();
    }
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
          `No Lovable session found in ${profileDir}. Run "lovable-cli login" or "lovable-cli import-desktop-session" first.`
        );
      }

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

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
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

async function runPromptTurn(page, {
  normalizedUrl,
  prompt,
  selector,
  submitSelector,
  postSubmitTimeoutMs = 20_000,
  verificationTimeoutMs = 600_000,
  headless = false
}) {
  const fillResult = await fillPrompt(page, prompt, { selector });
  await page.waitForTimeout(400);

  const chatAcceptance = waitForChatAcceptance(page, {
    projectUrl: normalizedUrl,
    timeoutMs: Math.max(postSubmitTimeoutMs, 120_000) + (headless ? 0 : verificationTimeoutMs)
  });
  const submitResult = await submitPrompt(page, { submitSelector });
  const postSubmit = await waitForPromptResult(page, {
    prompt,
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
        timeoutMs: verificationTimeoutMs
      });

      if (!verificationResolved.ok) {
        throw new Error(
          "Lovable did not clear the interactive verification within the expected time."
        );
      }

      console.log("Interactive verification cleared. Checking whether the prompt persisted after reload.");
    } else {
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

  const persisted = await confirmPromptPersistsAfterReload(page, {
    prompt,
    timeoutMs: postSubmitTimeoutMs
  });

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

  return {
    fillResult,
    submitResult,
    verificationResolved
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
  sourceLabel = "Preview"
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
    summarySourceKey: "previewSource"
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
  summarySourceKey = "captureSource"
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

  if (blockingCapture) {
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
