import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const INPUT_SELECTORS = [
  "textarea",
  "[contenteditable='true']",
  "[role='textbox']",
  "div[contenteditable='true']"
];
const ACTIONABLE_SELECTORS = "button,[role='button'],a[role='button']";

const SUBMIT_SELECTORS = [
  "button[aria-label*='Send' i]",
  "button[title*='Send' i]",
  "[data-testid*='send' i]",
  "button:has-text('Send')",
  "button:has-text('Submit')",
  "[role='button'][aria-label*='Send' i]"
];

const SUBMIT_SHORTCUTS = ["Meta+Enter", "Control+Enter", "Enter"];
const PROMPT_MODES = ["build", "plan"];
const PUBLISH_SURFACE_SELECTOR = '[role="menu"],[role="dialog"],[role="alertdialog"]';
const PUBLISH_SURFACE_PATTERN = /Published|Publish|Live URL|Review and publish|Your website URL|Who can see the website|Add info to help people find your website|Add custom domain|Security scan/i;
const PUBLISH_EDIT_SETTINGS_PATTERN = /Edit settings|Website info|Visibility|Security scan/i;
const PUBLISH_VISIBILITY_PATTERN = /Who can see the website|Anyone with the URL|Anyone with the link|Within workspace|Selected members/i;
const PUBLISH_WEBSITE_INFO_PATTERN = /Add info to help people find your website|Icon & title|Description|Social image/i;
const DOMAIN_SETTINGS_PATTERN = /Domains|Publish your project to custom domains|Edit URL|Connect existing domain/i;
const DOMAIN_EDIT_URL_PATTERN = /Edit URL subdomain|Change the URL for your published project/i;
const FINDINGS_ACTION_LABEL = "View findings";
const FINDINGS_STATUS_PATTERN = /Out of date|Up to date|Scanning|Scan in progress|In progress|Fresh|Updated|Needs attention|Requires update|Stale/i;
const FINDINGS_STATUS_EXACT_PATTERN = /^(Out of date|Up to date|Scanning|Scan in progress|In progress|Fresh|Updated|Needs attention|Requires update|Stale)$/i;
const RUNTIME_ERROR_TITLE_PATTERN = /^Error$/i;
const RUNTIME_ERROR_MESSAGE_PATTERN = /The app encountered an error/i;
const RUNTIME_ERROR_ACTION_PATTERN = /Try to fix|Show logs/i;

export async function launchLovableContext({
  profileDir,
  headless = false
}) {
  await fs.mkdir(profileDir, { recursive: true });

  return chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: null,
    chromiumSandbox: false,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled"
    ]
  });
}

export function getOrCreatePage(context) {
  return context.pages()[0] || context.newPage();
}

export async function readFirebaseAuthUsers(page) {
  return page.evaluate(async () => {
    try {
      const databases = indexedDB.databases ? await indexedDB.databases() : [];
      const hasAuthDb = databases.some((database) => database?.name === "firebaseLocalStorageDb");
      if (!hasAuthDb) {
        return [];
      }

      return await new Promise((resolve, reject) => {
        const request = indexedDB.open("firebaseLocalStorageDb");

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("firebaseLocalStorage")) {
            resolve([]);
            return;
          }

          const transaction = db.transaction(["firebaseLocalStorage"], "readonly");
          const store = transaction.objectStore("firebaseLocalStorage");
          const rows = [];
          const cursorRequest = store.openCursor();

          cursorRequest.onerror = () => reject(cursorRequest.error);
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              resolve(rows);
              return;
            }

            rows.push(cursor.value);
            cursor.continue();
          };
        };
      });
    } catch {
      return [];
    }
  });
}

export async function hasLovableSession(page) {
  const users = await readFirebaseAuthUsers(page);
  return users.some((entry) => {
    const value = entry?.value;
    return Boolean(value?.uid && value?.stsTokenManager?.refreshToken);
  });
}

export async function waitForLovableSession(page, {
  timeoutMs = 5 * 60 * 1000,
  pollMs = 1000
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasLovableSession(page)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

async function getPromptHandle(page, selectorOverride, timeoutMs = 15_000) {
  if (selectorOverride) {
    const locator = page.locator(selectorOverride).first();
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return locator;
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const candidates = [];

    for (const selector of INPUT_SELECTORS) {
      const handles = await page.$$(selector);
      for (const handle of handles) {
        const metrics = await handle.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const tagName = element.tagName.toLowerCase();
          const isTextArea = tagName === "textarea";
          const visible = rect.width >= 160 &&
            rect.height >= 24 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0;
          const disabled = element.matches("[disabled],[aria-disabled='true']");
          const editable = isTextArea
            ? !element.readOnly
            : element.isContentEditable || element.getAttribute("role") === "textbox";

          return {
            area: rect.width * rect.height,
            editable,
            tagName,
            visible,
            y: rect.y,
            disabled
          };
        });

        if (metrics.visible && metrics.editable && !metrics.disabled) {
          candidates.push({ handle, metrics });
        }
      }
    }

    if (candidates.length > 0) {
      candidates.sort((left, right) => {
        if (left.metrics.y !== right.metrics.y) {
          return right.metrics.y - left.metrics.y;
        }
        return right.metrics.area - left.metrics.area;
      });

      return candidates[0].handle;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    "Could not find a visible Lovable prompt input. Try opening the project page first or pass --selector."
  );
}

export async function fillPrompt(page, prompt, {
  selector
} = {}) {
  const handle = await getPromptHandle(page, selector);
  const tagName = await handle.evaluate((element) => element.tagName.toLowerCase());

  await handle.click();

  if (tagName === "textarea" || tagName === "input") {
    await handle.fill(prompt);
    return { method: "fill", tagName };
  }

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.type(prompt, { delay: 8 });
  return { method: "keyboard", tagName };
}

export async function submitPrompt(page, {
  submitSelector
} = {}) {
  const roleBasedSend = [
    page.getByRole("button", { name: /Send message/i }).first(),
    page.getByRole("button", { name: /^Send$/i }).first()
  ];

  for (const candidate of roleBasedSend) {
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const disabled = await candidate.evaluate(
      (element) => element.matches("[disabled],[aria-disabled='true']")
    ).catch(() => true);

    if (disabled) {
      continue;
    }

    await candidate.click();
    return { method: "click", selector: "role=button[name=/Send message/i]" };
  }

  const selectors = submitSelector ? [submitSelector] : SUBMIT_SELECTORS;

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();

    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible())) {
        continue;
      }

      const disabled = await candidate.evaluate(
        (element) => element.matches("[disabled],[aria-disabled='true']")
      ).catch(() => true);

      if (disabled) {
        continue;
      }

      await candidate.click();
      return { method: "click", selector };
    }
  }

  for (const shortcut of SUBMIT_SHORTCUTS) {
    await page.keyboard.press(shortcut);
    return { method: "shortcut", shortcut };
  }

  throw new Error(
    "Could not find a visible Lovable submit control. Try passing --submit-selector."
  );
}

async function waitForChatComposer(page, {
  timeoutMs = 15_000,
  pollMs = 250
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const formVisible = await page.locator("form#chat-input").first().isVisible().catch(() => false);
    const inputVisible = await page.locator('[aria-label="Chat input"]').first().isVisible().catch(() => false);
    if (formVisible || inputVisible) {
      return true;
    }
    await page.waitForTimeout(pollMs);
  }

  return false;
}

async function getVisibleChatActionSnapshot(page) {
  return page.locator(ACTIONABLE_SELECTORS).evaluateAll((elements) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const input = document.querySelector('[aria-label="Chat input"]');
    const form = document.querySelector("form#chat-input") || input?.closest("form") || null;

    if (!form) {
      return {
        actions: [],
        rootFound: false
      };
    }

    const isVisibleInViewport = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
    };

    const formRect = form.getBoundingClientRect();
    const isNearComposer = (element) => {
      const rect = element.getBoundingClientRect();
      const withinVerticalBand = rect.bottom >= formRect.top - 420 &&
        rect.top <= formRect.bottom + 48;
      const withinHorizontalBand = rect.right >= formRect.left - 96 &&
        rect.left <= formRect.right + 96;
      return withinVerticalBand && withinHorizontalBand;
    };

    const buildDescriptor = (element, domIndex) => {
      const rect = element.getBoundingClientRect();
      const text = normalize(element.textContent || "");
      const ariaLabel = normalize(element.getAttribute("aria-label") || "");
      const label = text || ariaLabel;

      return {
        domIndex,
        label,
        text,
        ariaLabel,
        tagName: element.tagName.toLowerCase(),
        role: normalize(element.getAttribute("role") || ""),
        disabled: element.matches("[disabled],[aria-disabled='true'],[data-disabled='true']"),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    };

    let root = form.parentElement || form;
    for (let current = form.parentElement; current; current = current.parentElement) {
      const currentRect = current.getBoundingClientRect();
      if (currentRect.width > formRect.width + 220) {
        continue;
      }

      const scopedActions = elements
        .filter((element) => {
          return current.contains(element) &&
            !form.contains(element) &&
            isVisibleInViewport(element) &&
            isNearComposer(element);
        })
        .map((element, domIndex) => buildDescriptor(element, elements.indexOf(element)))
        .filter((entry) => entry.label && entry.domIndex >= 0);

      if (scopedActions.length > 0) {
        root = current;
        break;
      }
    }

    const actions = elements
      .map((element, domIndex) => ({
        element,
        descriptor: buildDescriptor(element, domIndex)
      }))
      .filter(({ element, descriptor }) => {
        return root.contains(element) &&
          !form.contains(element) &&
          descriptor.label &&
          isVisibleInViewport(element) &&
          isNearComposer(element);
      })
      .map(({ descriptor }) => descriptor)
      .sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }
        return left.x - right.x;
      });

    return {
      actions,
      rootFound: true
    };
  });
}

export async function listChatActions(page, {
  timeoutMs = 5_000,
  pollMs = 250
} = {}) {
  const composerVisible = await waitForChatComposer(page);
  if (!composerVisible) {
    throw new Error("Could not locate the Lovable chat composer on this page.");
  }

  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;

  while (Date.now() < deadline) {
    const snapshot = await getVisibleChatActionSnapshot(page);
    if (!snapshot.rootFound) {
      throw new Error("Could not locate the Lovable chat composer on this page.");
    }

    lastSnapshot = snapshot;
    if (snapshot.actions.length > 0) {
      return snapshot.actions;
    }

    await page.waitForTimeout(pollMs);
  }

  return lastSnapshot?.actions || [];
}

export async function clickChatAction(page, {
  label,
  exact = false,
  matchIndex = 0,
  timeoutMs = 15_000,
  settleMs = 1_500,
  actionsTimeoutMs = 5_000,
  actionsPollMs = 250
}) {
  const normalizedLabel = normalizeText(label).toLowerCase();
  if (!normalizedLabel) {
    throw new Error("Expected a non-empty chat action label.");
  }

  const deadline = Date.now() + actionsTimeoutMs;
  let actions = [];
  let matches = [];
  let target = null;

  while (Date.now() < deadline) {
    actions = await listChatActions(page, {
      timeoutMs: Math.max(actionsPollMs, 250),
      pollMs: actionsPollMs
    }).catch(() => []);

    const exactMatches = actions.filter((action) => action.label.toLowerCase() === normalizedLabel);
    const containsMatches = actions.filter((action) => action.label.toLowerCase().includes(normalizedLabel));
    matches = exact ? exactMatches : (exactMatches.length > 0 ? exactMatches : containsMatches);

    if (matchIndex >= 0 && matchIndex < matches.length) {
      target = matches[matchIndex];
      if (!target.disabled) {
        break;
      }
    }

    if (matches.length > 0 && matchIndex >= matches.length) {
      break;
    }

    await page.waitForTimeout(actionsPollMs);
  }

  if (matches.length === 0) {
    const visibleActions = actions.map((action) => action.label).join(", ") || "(none)";
    throw new Error(`No visible chat action matched "${label}". Visible actions: ${visibleActions}`);
  }

  if (matchIndex < 0 || matchIndex >= matches.length) {
    throw new Error(
      `Match index ${matchIndex} is out of range for "${label}". Matching actions: ${matches.map((action) => action.label).join(", ")}`
    );
  }

  target = matches[matchIndex];
  if (target.disabled) {
    throw new Error(`Chat action "${target.label}" is currently disabled.`);
  }

  const locator = page.locator(ACTIONABLE_SELECTORS).nth(target.domIndex);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: timeoutMs });
  } catch (error) {
    try {
      await locator.click({ timeout: Math.min(timeoutMs, 5_000), force: true });
    } catch {
      await locator.evaluate((element) => element.click());
    }
  }
  await page.waitForTimeout(settleMs);

  return {
    clicked: target,
    actionsAfterClick: await listChatActions(page, {
      timeoutMs: actionsTimeoutMs,
      pollMs: actionsPollMs
    }).catch(() => [])
  };
}

function normalizeRuntimeErrorActionLabel(value) {
  return normalizeText(value).replace(/([a-z])([A-Z])$/, "$1");
}

async function getVisibleRuntimeErrorSnapshot(page) {
  return page.locator(ACTIONABLE_SELECTORS).evaluateAll((elements, patterns) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const normalizeActionLabel = (value) => normalize(value).replace(/([a-z])([A-Z])$/, "$1");
    const isRendered = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0;
    };

    const textElements = Array.from(document.querySelectorAll("p,div,span,h1,h2,h3,h4"))
      .filter((element) => element instanceof HTMLElement && isRendered(element));

    const errorMessage = textElements
      .map((element) => ({
        element,
        text: normalize(element.textContent || "")
      }))
      .filter(({ text }) => new RegExp(patterns.message, "i").test(text))
      .sort((left, right) => left.text.length - right.text.length)[0]?.element || null;

    if (!(errorMessage instanceof HTMLElement)) {
      return {
        open: false,
        title: null,
        message: null,
        actions: []
      };
    }

    const buildDescriptor = (element, domIndex) => {
      const rect = element.getBoundingClientRect();
      const text = normalize(element.textContent || "");
      const ariaLabel = normalize(element.getAttribute("aria-label") || "");
      const rawLabel = text || ariaLabel;
      const label = normalizeActionLabel(rawLabel);

      return {
        domIndex,
        label,
        rawLabel,
        text,
        ariaLabel,
        tagName: element.tagName.toLowerCase(),
        role: normalize(element.getAttribute("role") || ""),
        disabled: element.matches("[disabled],[aria-disabled='true'],[data-disabled='true']"),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    };

    let root = errorMessage.parentElement || errorMessage;
    for (let current = errorMessage.parentElement; current; current = current.parentElement) {
      if (!(current instanceof HTMLElement) || !isRendered(current)) {
        continue;
      }

      const text = normalize(current.textContent || "");
      if (!new RegExp(patterns.message, "i").test(text)) {
        continue;
      }

      const scopedActions = elements
        .map((element, domIndex) => ({ element, descriptor: buildDescriptor(element, domIndex) }))
        .filter(({ element, descriptor }) => {
          return current.contains(element) &&
            descriptor.label &&
            isRendered(element) &&
            new RegExp(patterns.action, "i").test(descriptor.label);
        });

      if (scopedActions.length > 0) {
        root = current;
        break;
      }
    }

    const actions = elements
      .map((element, domIndex) => ({ element, descriptor: buildDescriptor(element, domIndex) }))
      .filter(({ element, descriptor }) => {
        return root.contains(element) &&
          descriptor.label &&
          isRendered(element) &&
          new RegExp(patterns.action, "i").test(descriptor.label);
      })
      .map(({ descriptor }) => descriptor)
      .sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }
        return left.x - right.x;
      });

    const title = textElements
      .map((element) => normalize(element.textContent || ""))
      .filter((value) => new RegExp(patterns.title, "i").test(value))
      .sort((left, right) => left.length - right.length)[0] || null;

    return {
      open: actions.length > 0,
      title,
      message: normalize(errorMessage.textContent || ""),
      actions
    };
  }, {
    title: RUNTIME_ERROR_TITLE_PATTERN.source,
    message: RUNTIME_ERROR_MESSAGE_PATTERN.source,
    action: RUNTIME_ERROR_ACTION_PATTERN.source
  });
}

export async function getProjectRuntimeErrorState(page, {
  timeoutMs = 5_000,
  pollMs = 250
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = await getVisibleRuntimeErrorSnapshot(page);

  while (Date.now() < deadline) {
    if (lastSnapshot.open) {
      return lastSnapshot;
    }

    await page.waitForTimeout(pollMs);
    lastSnapshot = await getVisibleRuntimeErrorSnapshot(page);
  }

  return lastSnapshot;
}

export async function listRuntimeErrorActions(page, {
  timeoutMs = 5_000,
  pollMs = 250
} = {}) {
  const state = await getProjectRuntimeErrorState(page, {
    timeoutMs,
    pollMs
  });

  return state.actions || [];
}

export async function clickRuntimeErrorAction(page, {
  label,
  exact = false,
  matchIndex = 0,
  timeoutMs = 15_000,
  settleMs = 1_500,
  actionsTimeoutMs = 5_000,
  actionsPollMs = 250
}) {
  const normalizedLabel = normalizeRuntimeErrorActionLabel(label).toLowerCase();
  if (!normalizedLabel) {
    throw new Error("Expected a non-empty runtime error action label.");
  }

  const deadline = Date.now() + actionsTimeoutMs;
  let actions = [];
  let matches = [];
  let target = null;

  while (Date.now() < deadline) {
    actions = await listRuntimeErrorActions(page, {
      timeoutMs: Math.max(actionsPollMs, 250),
      pollMs: actionsPollMs
    }).catch(() => []);

    const exactMatches = actions.filter((action) => action.label.toLowerCase() === normalizedLabel);
    const containsMatches = actions.filter((action) => action.label.toLowerCase().includes(normalizedLabel));
    matches = exact ? exactMatches : (exactMatches.length > 0 ? exactMatches : containsMatches);

    if (matchIndex >= 0 && matchIndex < matches.length) {
      target = matches[matchIndex];
      if (!target.disabled) {
        break;
      }
    }

    if (matches.length > 0 && matchIndex >= matches.length) {
      break;
    }

    await page.waitForTimeout(actionsPollMs);
  }

  if (matches.length === 0) {
    const visibleActions = actions.map((action) => action.label).join(", ") || "(none)";
    throw new Error(`No visible runtime error action matched "${label}". Visible actions: ${visibleActions}`);
  }

  if (matchIndex < 0 || matchIndex >= matches.length) {
    throw new Error(
      `Match index ${matchIndex} is out of range for "${label}". Matching runtime error actions: ${matches.map((action) => action.label).join(", ")}`
    );
  }

  target = matches[matchIndex];
  if (target.disabled) {
    throw new Error(`Runtime error action "${target.label}" is currently disabled.`);
  }

  const locator = page.locator(ACTIONABLE_SELECTORS).nth(target.domIndex);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: timeoutMs });
  } catch (error) {
    try {
      await locator.click({ timeout: Math.min(timeoutMs, 5_000), force: true });
    } catch {
      await locator.evaluate((element) => element.click());
    }
  }
  await page.waitForTimeout(settleMs);

  return {
    clicked: target,
    stateAfterClick: await getProjectRuntimeErrorState(page, {
      timeoutMs: actionsTimeoutMs,
      pollMs: actionsPollMs
    }).catch(() => ({
      open: false,
      title: null,
      message: null,
      actions: []
    }))
  };
}

function buildFindingsLevelCounts(issues = []) {
  const counts = {
    errors: 0,
    warnings: 0,
    info: 0
  };

  for (const issue of issues) {
    const normalizedLevel = normalizeText(issue?.level).toLowerCase();
    if (normalizedLevel === "error") {
      counts.errors += 1;
    } else if (normalizedLevel === "warning") {
      counts.warnings += 1;
    } else if (normalizedLevel === "info") {
      counts.info += 1;
    }
  }

  return counts;
}

function parseFindingsCount(text, label) {
  const match = String(text || "").match(new RegExp(`(\\d+)\\s+${escapeRegExp(label)}`, "i"));
  if (!match) {
    return null;
  }

  const count = Number.parseInt(match[1], 10);
  return Number.isNaN(count) ? null : count;
}

async function readFindingsPaneState(page) {
  const snapshot = await page.evaluate(({ statusPatternSource, statusExactPatternSource }) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();

    const isRendered = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0;
    };

    const dedupe = (values) => Array.from(new Set(values.filter(Boolean)));
    const main = document.querySelector("main");
    if (!(main instanceof HTMLElement)) {
      return {
        open: false,
        title: null,
        scanTitle: null,
        status: null,
        summaryTitle: null,
        availableActions: [],
        advancedViewEnabled: null,
        issues: [],
        rootText: ""
      };
    }

    const visibleElements = Array.from(main.querySelectorAll("*")).filter((element) => {
      return element instanceof HTMLElement && isRendered(element);
    });

    const findVisibleByText = (pattern) => {
      return visibleElements.find((element) => pattern.test(normalize(element.textContent || ""))) || null;
    };

    const scanHeading = findVisibleByText(/^Security scan$/i);
    const issuesHeading = findVisibleByText(/^Detected issues$/i);

    let root = null;
    if (scanHeading instanceof HTMLElement && issuesHeading instanceof HTMLElement) {
      for (let current = scanHeading.parentElement; current; current = current.parentElement) {
        if (!(current instanceof HTMLElement) || !main.contains(current) || !isRendered(current)) {
          continue;
        }

        const text = normalize(current.textContent || "");
        if (
          current.contains(issuesHeading) &&
          /Security scan/i.test(text) &&
          /Detected issues/i.test(text)
        ) {
          root = current;
          break;
        }
      }
    }

    if (!(root instanceof HTMLElement)) {
      return {
        open: false,
        title: null,
        scanTitle: null,
        status: null,
        summaryTitle: null,
        availableActions: [],
        advancedViewEnabled: null,
        issues: [],
        rootText: ""
      };
    }

    const statusPattern = new RegExp(statusPatternSource, "i");
    const statusExactPattern = new RegExp(statusExactPatternSource, "i");
    const rootText = normalize(root.innerText || root.textContent || "");
    const rootVisibleElements = Array.from(root.querySelectorAll("*")).filter((element) => {
      return element instanceof HTMLElement && isRendered(element);
    });

    const getExactText = (pattern) => {
      return rootVisibleElements
        .map((element) => normalize(element.textContent || ""))
        .find((value) => pattern.test(value)) || null;
    };

    const title = dedupe(
      Array.from(main.querySelectorAll("h1,h2,h3,h4,p,span,div"))
        .filter((element) => element instanceof HTMLElement && isRendered(element))
        .map((element) => normalize(element.textContent || ""))
        .filter((value) => /^Security$/i.test(value))
    )[0] || "Security";

    const statusTexts = dedupe(rootVisibleElements.map((element) => normalize(element.textContent || "")));
    const status = statusTexts.find((value) => statusExactPattern.test(value)) ||
      statusTexts.find((value) => statusPattern.test(value) && value.length <= 80) ||
      null;

    const actionElements = Array.from(root.querySelectorAll("button,[role='button'],a,label")).filter((element) => {
      return element instanceof HTMLElement && isRendered(element);
    });
    const actionLabels = dedupe(actionElements.map((element) => {
      return normalize(element.textContent || element.getAttribute("aria-label") || "");
    }));
    const filters = actionLabels.filter((label) => /^(\d+\s+(Errors?|Warnings?|Info)|All)$/i.test(label));
    const issueActions = actionLabels.filter((label) => /^Open finding link$/i.test(label));
    const availableActions = actionLabels.filter((label) => {
      return !filters.includes(label) && !issueActions.includes(label);
    });

    const advancedControl = actionElements.find((element) => {
      const text = normalize(element.textContent || element.getAttribute("aria-label") || "");
      return /Advanced view/i.test(text);
    }) || null;

    let advancedViewEnabled = null;
    if (advancedControl instanceof HTMLElement) {
      const stateElement = advancedControl.matches("input,[role='switch'],[role='checkbox'],button")
        ? advancedControl
        : advancedControl.querySelector("input,[role='switch'],[role='checkbox'],button[aria-pressed],button");

      if (stateElement instanceof HTMLElement) {
        const ariaChecked = stateElement.getAttribute("aria-checked");
        const ariaPressed = stateElement.getAttribute("aria-pressed");
        const dataState = stateElement.getAttribute("data-state");
        const checked = "checked" in stateElement ? Boolean(stateElement.checked) : null;

        if (
          ariaChecked === "true" ||
          ariaPressed === "true" ||
          dataState === "checked" ||
          dataState === "on" ||
          checked === true
        ) {
          advancedViewEnabled = true;
        } else if (
          ariaChecked === "false" ||
          ariaPressed === "false" ||
          dataState === "unchecked" ||
          dataState === "off" ||
          checked === false
        ) {
          advancedViewEnabled = false;
        }
      }
    }

    const issues = Array.from(root.querySelectorAll("table tbody tr"))
      .filter((row) => row instanceof HTMLElement && isRendered(row))
      .map((row) => {
        const cells = Array.from(row.querySelectorAll("th,td"))
          .map((cell) => normalize(cell.textContent || ""))
          .filter(Boolean);
        return {
          level: cells[0] || "",
          issue: cells.slice(1).join(" ") || cells[0] || ""
        };
      })
      .filter((entry) => entry.level || entry.issue);

    return {
      open: true,
      title,
      scanTitle: getExactText(/^Security scan$/i),
      status,
      summaryTitle: getExactText(/^Detected issues$/i),
      availableActions,
      availableFilters: filters,
      issueActions,
      advancedViewEnabled,
      issues,
      rootText
    };
  }, {
    statusPatternSource: FINDINGS_STATUS_PATTERN.source,
    statusExactPatternSource: FINDINGS_STATUS_EXACT_PATTERN.source
  });

  if (!snapshot.open) {
    return snapshot;
  }

  const countsFromIssues = buildFindingsLevelCounts(snapshot.issues);
  const counts = {
    errors: parseFindingsCount(snapshot.rootText, "Errors?") ?? countsFromIssues.errors,
    warnings: parseFindingsCount(snapshot.rootText, "Warnings?") ?? countsFromIssues.warnings,
    info: parseFindingsCount(snapshot.rootText, "Info") ?? countsFromIssues.info
  };

  return {
    ...snapshot,
    counts,
    issueCount: snapshot.issues.length
  };
}

async function waitForFindingsPane(page, {
  timeoutMs = 15_000,
  pollMs = 250
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = await readFindingsPaneState(page);

  while (Date.now() < deadline) {
    if (lastState.open) {
      return lastState;
    }

    await page.waitForTimeout(pollMs);
    lastState = await readFindingsPaneState(page);
  }

  return lastState;
}

export async function openFindingsPane(page, {
  timeoutMs = 15_000,
  pollMs = 250,
  settleMs = 1_500,
  actionsTimeoutMs = 5_000,
  actionsPollMs = 250
} = {}) {
  const existingState = await readFindingsPaneState(page);
  if (existingState.open) {
    return {
      opened: false,
      state: existingState,
      clickedAction: null,
      actionsAfterClick: await listChatActions(page, {
        timeoutMs: actionsTimeoutMs,
        pollMs: actionsPollMs
      }).catch(() => [])
    };
  }

  const clickResult = await clickChatAction(page, {
    label: FINDINGS_ACTION_LABEL,
    exact: true,
    timeoutMs: Math.max(timeoutMs, 15_000),
    settleMs,
    actionsTimeoutMs: Math.max(actionsTimeoutMs, timeoutMs),
    actionsPollMs
  });

  const state = await waitForFindingsPane(page, {
    timeoutMs,
    pollMs
  });

  if (!state.open) {
    throw new Error("Lovable did not open the Security findings pane after clicking View findings.");
  }

  return {
    opened: true,
    state,
    clickedAction: clickResult.clicked,
    actionsAfterClick: clickResult.actionsAfterClick
  };
}

export async function getProjectFindingsState(page, {
  openIfNeeded = true,
  timeoutMs = 15_000,
  pollMs = 250,
  settleMs = 1_500,
  actionsTimeoutMs = 5_000,
  actionsPollMs = 250
} = {}) {
  const chatActionsBefore = await listChatActions(page, {
    timeoutMs: actionsTimeoutMs,
    pollMs: actionsPollMs
  }).catch(() => []);

  let state = await readFindingsPaneState(page);
  let openResult = null;

  if (!state.open && openIfNeeded) {
    openResult = await openFindingsPane(page, {
      timeoutMs,
      pollMs,
      settleMs,
      actionsTimeoutMs,
      actionsPollMs
    });
    state = openResult.state;
  }

  const chatActionsAfter = await listChatActions(page, {
    timeoutMs: actionsTimeoutMs,
    pollMs: actionsPollMs
  }).catch(() => chatActionsBefore);

  return {
    ...state,
    openedViaAction: Boolean(openResult?.opened),
    clickedAction: openResult?.clickedAction || null,
    chatActionsBefore,
    chatActionsAfter
  };
}

export async function ensureSignedIn(page, {
  timeoutMs = 15_000
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await hasLovableSession(page)) {
      return true;
    }
    await page.waitForTimeout(500);
  }

  return false;
}

function normalizePromptMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (!PROMPT_MODES.includes(normalized)) {
    throw new Error(`Unsupported Lovable mode "${mode}". Use one of: ${PROMPT_MODES.join(", ")}`);
  }
  return normalized;
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeJsonParse(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function readResponseBody(response) {
  try {
    const contentType = response.headers()["content-type"] || "";
    if (contentType.includes("application/json")) {
      return await response.json();
    }
    return await response.text();
  } catch {
    return null;
  }
}

function classifyPublishSurface(text) {
  const normalized = String(text || "").trim();

  if (!normalized) {
    return "closed";
  }

  if (/\bPublishing\b/i.test(normalized)) {
    return "publishing";
  }

  if (/\bPublished\b/i.test(normalized) || /\bLive URL\b/i.test(normalized)) {
    return "published";
  }

  if (/Review and publish/i.test(normalized)) {
    return "review";
  }

  if (/Add info to help people find your website/i.test(normalized)) {
    return "website_info";
  }

  if (/Who can see the website/i.test(normalized)) {
    return "visibility";
  }

  if (/Your website URL/i.test(normalized)) {
    return "website_url";
  }

  return "unknown";
}

function normalizePublishUrl(value) {
  if (!value) {
    return null;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:lovable\.app|lovableproject\.com)$/i.test(value)) {
    return `https://${value}`;
  }

  return null;
}

function extractDeploymentId(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0] || null;
  }

  if (typeof value !== "object") {
    return null;
  }

  for (const key of ["deployment_id", "deploymentId", "id"]) {
    const candidate = value[key];
    const nested = extractDeploymentId(candidate);
    if (nested) {
      return nested;
    }
  }

  for (const candidate of Object.values(value)) {
    const nested = extractDeploymentId(candidate);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function summarizePublishState(state) {
  if (!state) {
    return {
      step: "closed",
      liveUrl: null,
      textPreview: ""
    };
  }

  return {
    step: state.step,
    liveUrl: state.liveUrl,
    textPreview: state.text.slice(0, 200)
  };
}

function getPublishSurfaceLocator(page) {
  return page.locator(PUBLISH_SURFACE_SELECTOR).filter({
    hasText: PUBLISH_SURFACE_PATTERN
  }).last();
}

function getPublishEditSettingsLocator(page) {
  return page.locator(PUBLISH_SURFACE_SELECTOR).filter({
    hasText: PUBLISH_EDIT_SETTINGS_PATTERN
  }).last();
}

function getPublishVisibilityLocator(page) {
  return page.locator(PUBLISH_SURFACE_SELECTOR).filter({
    hasText: PUBLISH_VISIBILITY_PATTERN
  }).last();
}

function getPublishWebsiteInfoLocator(page) {
  return page.locator(PUBLISH_SURFACE_SELECTOR).filter({
    hasText: PUBLISH_WEBSITE_INFO_PATTERN
  }).last();
}

function getDomainEditUrlLocator(page) {
  return page.locator(PUBLISH_SURFACE_SELECTOR).filter({
    hasText: DOMAIN_EDIT_URL_PATTERN
  }).last();
}

function projectIdFromUrl(value) {
  return String(value || "").match(/\/projects\/([^/?#]+)/)?.[1] || null;
}

function getProjectDomainsSettingsUrl(projectUrl) {
  const projectId = projectIdFromUrl(projectUrl);
  if (!projectId) {
    throw new Error("Expected a Lovable project URL.");
  }

  const url = new URL(projectUrl);
  url.pathname = `/projects/${projectId}/settings/domains`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeVisibilityKey(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (["public", "anyone", "anyone-with-the-url", "anyone-with-the-link", "link"].includes(normalized)) {
    return "public";
  }

  if (["workspace", "within-workspace", "members"].includes(normalized)) {
    return "workspace";
  }

  if (["selected", "selected-members", "invitees"].includes(normalized)) {
    return "selected";
  }

  throw new Error(`Unsupported publish visibility "${value}". Use one of: public, workspace, selected.`);
}

function classifyVisibilityChoice(label) {
  const normalized = String(label || "").trim().toLowerCase();

  if (!normalized) {
    return "unknown";
  }

  if (
    normalized.includes("public") ||
    normalized.includes("anyone with the url") ||
    normalized.includes("anyone with the link")
  ) {
    return "public";
  }

  if (
    normalized.includes("within workspace") ||
    normalized.includes("all members and invitees")
  ) {
    return "workspace";
  }

  if (normalized.includes("selected members")) {
    return "selected";
  }

  return "unknown";
}

function getVisibilityChoicePattern(choice) {
  switch (normalizeVisibilityKey(choice)) {
    case "public":
      return /Public|Anyone with the URL|Anyone with the link/i;
    case "workspace":
      return /Within workspace|All members and invitees/i;
    case "selected":
      return /Selected members|Selected members and invitees/i;
    default:
      throw new Error(`Unsupported publish visibility "${choice}".`);
  }
}

function normalizeSubdomain(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("Subdomain cannot be empty.");
  }

  if (!/^[a-z0-9-]+$/.test(normalized)) {
    throw new Error("Subdomain must use lowercase letters, numbers, and hyphens only.");
  }

  return normalized;
}

function getLiveHostSuffix(liveUrl) {
  if (!liveUrl) {
    return "lovable.app";
  }

  try {
    const host = new URL(liveUrl).hostname;
    const [, ...suffixParts] = host.split(".");
    return suffixParts.join(".") || "lovable.app";
  } catch {
    return "lovable.app";
  }
}

async function readPublishVisibilityState(menu) {
  const snapshot = await menu.evaluate((root) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const options = Array.from(root.querySelectorAll("button"))
      .map((button) => {
        const text = normalize(button.textContent || "");
        if (!text || /^(Back|Done)$/i.test(text)) {
          return null;
        }

        const radio = button.querySelector("[role='radio']");
        return {
          label: text,
          disabled: Boolean(button.disabled),
          selected: Boolean(
            radio?.getAttribute("aria-checked") === "true" ||
            radio?.getAttribute("data-state") === "checked"
          )
        };
      })
      .filter(Boolean);

    return {
      options
    };
  });

  const options = snapshot.options.map((option) => ({
    ...option,
    key: classifyVisibilityChoice(option.label)
  })).filter((option) => option.key !== "unknown");

  return {
    options,
    current: options.find((option) => option.selected) || null
  };
}

async function readPublishWebsiteInfoState(menu) {
  return menu.evaluate((root) => {
    const titleInput = root.querySelector("input[name='title']");
    const descriptionInput = root.querySelector("textarea[name='description']");
    const generateButton = Array.from(root.querySelectorAll("button"))
      .find((button) => /\bGenerate\b/i.test(button.textContent || ""));

    return {
      title: titleInput?.value || "",
      titlePlaceholder: titleInput?.getAttribute("placeholder") || "",
      description: descriptionInput?.value || "",
      descriptionPlaceholder: descriptionInput?.getAttribute("placeholder") || "",
      canGenerateSocialImage: Boolean(generateButton && !generateButton.disabled)
    };
  });
}

async function gotoProjectDomainsSettings(page, projectUrl, {
  timeoutMs = 120_000
} = {}) {
  const settingsUrl = getProjectDomainsSettingsUrl(projectUrl);
  await page.goto(settingsUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs
  });
  return settingsUrl;
}

async function openPublishedEditSettings(page, {
  timeoutMs = 15_000
} = {}) {
  const state = await openPublishSurface(page, {
    timeoutMs
  });

  if (state.step !== "published") {
    throw new Error("Publish settings are only available after the project has been published.");
  }

  const surface = getPublishSurfaceLocator(page);
  const button = surface.getByRole("button", {
    name: /^Edit settings$/i
  }).first();

  await button.waitFor({ state: "visible", timeout: timeoutMs });
  await button.click();

  const menu = getPublishEditSettingsLocator(page);
  await menu.waitFor({ state: "visible", timeout: timeoutMs });
  return menu;
}

async function openPublishedVisibilitySettings(page, {
  timeoutMs = 15_000
} = {}) {
  const menu = await openPublishedEditSettings(page, {
    timeoutMs
  });
  const button = menu.getByRole("button", {
    name: /Visibility/i
  }).first();
  await button.waitFor({ state: "visible", timeout: timeoutMs });
  await button.click();

  const visibilityMenu = getPublishVisibilityLocator(page);
  await visibilityMenu.waitFor({ state: "visible", timeout: timeoutMs });
  return visibilityMenu;
}

async function openPublishedWebsiteInfoSettings(page, {
  timeoutMs = 15_000
} = {}) {
  const menu = await openPublishedEditSettings(page, {
    timeoutMs
  });
  const button = menu.getByRole("button", {
    name: /Website info/i
  }).first();
  await button.waitFor({ state: "visible", timeout: timeoutMs });
  await button.click();

  const websiteInfoMenu = getPublishWebsiteInfoLocator(page);
  await websiteInfoMenu.waitFor({ state: "visible", timeout: timeoutMs });
  return websiteInfoMenu;
}

async function readDomainsSettingsStateFromPage(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const main = document.querySelector("main[aria-label='Settings content']") || document.querySelector("main");
    if (!main) {
      return null;
    }

    const buttons = Array.from(main.querySelectorAll("button"))
      .map((button) => ({
        text: normalize(button.textContent || ""),
        ariaLabel: button.getAttribute("aria-label") || "",
        disabled: Boolean(button.disabled)
      }))
      .filter((entry) => entry.text || entry.ariaLabel);
    const links = Array.from(main.querySelectorAll("a"))
      .map((anchor) => ({
        text: normalize(anchor.textContent || ""),
        href: anchor.getAttribute("href") || ""
      }))
      .filter((entry) => entry.text || entry.href);
    const suggestedDomains = Array.from(
      new Set(
        buttons.flatMap((entry) => {
          return (entry.text.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi) || [])
            .map((value) => value.toLowerCase());
        })
      )
    );
    const liveUrl = links
      .map((entry) => entry.href || entry.text)
      .find((value) => /\.(?:lovable\.app|lovableproject\.com)(?:\/|$)/i.test(value || "")) || null;

    return {
      liveUrl,
      buttons,
      links,
      suggestedDomains
    };
  });
}

export async function getCurrentPromptMode(page) {
  await page.getByRole("button", {
    name: /^(Build|Plan)$/i
  }).first().waitFor({
    state: "visible",
    timeout: 5_000
  }).catch(() => {});

  for (const mode of PROMPT_MODES) {
    const button = page.getByRole("button", {
      name: new RegExp(`^${capitalize(mode)}$`, "i")
    }).first();

    if (await button.isVisible().catch(() => false)) {
      return mode;
    }
  }

  return null;
}

export async function setPromptMode(page, {
  mode,
  timeoutMs = 15_000
}) {
  const normalizedMode = normalizePromptMode(mode);
  const previousMode = await getCurrentPromptMode(page);

  if (previousMode === normalizedMode) {
    return {
      changed: false,
      previousMode,
      currentMode: previousMode
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const trigger = page.getByRole("button", {
      name: /^(Build|Plan)$/i
    }).first();

    await trigger.waitFor({ state: "visible", timeout: timeoutMs });
    await trigger.click();

    const targetItem = page.getByRole("menuitemradio", {
      name: new RegExp(`^${capitalize(normalizedMode)}\\b`, "i")
    }).first();

    await targetItem.waitFor({ state: "visible", timeout: timeoutMs });

    const isChecked = await targetItem.evaluate((element) => {
      return element.getAttribute("data-state") === "checked";
    }).catch(() => false);

    if (!isChecked) {
      try {
        await targetItem.click({ timeout: timeoutMs / 2 });
      } catch {
        await targetItem.evaluate((element) => element.click());
      }
    } else {
      await page.keyboard.press("Escape");
    }

    await page.waitForTimeout(600);

    const currentMode = await getCurrentPromptMode(page);
    if (currentMode === normalizedMode) {
      return {
        changed: previousMode !== currentMode,
        previousMode,
        currentMode
      };
    }
  }

  const currentMode = await getCurrentPromptMode(page);
  if (currentMode !== normalizedMode) {
    throw new Error(`Failed to switch Lovable mode to ${normalizedMode}. Current mode: ${currentMode || "unknown"}`);
  }

  return {
    changed: previousMode !== currentMode,
    previousMode,
    currentMode
  };
}

export async function chooseWorkspaceForAutosubmit(page, workspaceName) {
  const chooserTitle = page.getByText("Choose workspace for auto-submit", { exact: false });
  const chooserVisible = await chooserTitle.isVisible().catch(() => false);

  if (!chooserVisible) {
    return { chosen: null, required: false };
  }

  const allButtons = await page.getByRole("button").evaluateAll((elements) => {
    return elements.map((element) => ({
      text: (element.textContent || "").replace(/\s+/g, " ").trim(),
      ariaLabel: element.getAttribute("aria-label") || "",
      disabled: element.matches("[disabled],[aria-disabled='true']")
    }));
  });

  const workspaceButtons = allButtons
    .map((button) => button.text)
    .filter((text) => text && !/^(Cancel|Close)$/i.test(text));

  if (!workspaceName) {
    throw new Error(
      `Lovable requires a workspace selection before auto-submit. Re-run with --workspace. Available options: ${workspaceButtons.join(", ")}`
    );
  }

  const escaped = workspaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const button = page.getByRole("button", {
    name: new RegExp(escaped, "i")
  }).first();

  if (!(await button.isVisible().catch(() => false))) {
    throw new Error(
      `Workspace "${workspaceName}" was not found in the auto-submit chooser. Available options: ${workspaceButtons.join(", ")}`
    );
  }

  await button.click();
  return { chosen: workspaceName, required: true };
}

export async function waitForProjectPage(page, {
  timeoutMs = 8 * 60 * 1000,
  pollMs = 2000
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (/\/projects\//.test(currentUrl)) {
      return currentUrl;
    }
    await page.waitForTimeout(pollMs);
  }

  throw new Error("Timed out waiting for Lovable to navigate to a project page.");
}

export async function runCreateFlow(page, {
  createUrl,
  workspace,
  waitForProjectMs = 8 * 60 * 1000
}) {
  await page.goto(createUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForTimeout(3_000);

  const chooserResult = await chooseWorkspaceForAutosubmit(page, workspace).catch((error) => {
    if (!workspace) {
      throw error;
    }
    return { chosen: null, required: false, error };
  });

  const sendButton = page.getByRole("button", { name: /Send message/i }).first();
  const sendVisible = await sendButton.isVisible().catch(() => false);
  if (sendVisible) {
    const sendDisabled = await sendButton.evaluate((element) => {
      return element.matches("[disabled],[aria-disabled='true']");
    }).catch(() => false);

    if (!sendDisabled) {
      await sendButton.click();
    }
  }

  const projectUrl = await waitForProjectPage(page, {
    timeoutMs: waitForProjectMs
  });

  return {
    chooserResult,
    projectUrl
  };
}

export async function getProjectPreviewInfo(page, {
  timeoutMs = 20_000,
  pollMs = 500
} = {}) {
  const previewFrame = page.locator('iframe[title="Project preview"], iframe[name="live-preview-panel"]').first();
  await previewFrame.waitFor({ state: "attached", timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const [src, title, name] = await Promise.all([
      previewFrame.getAttribute("src"),
      previewFrame.getAttribute("title"),
      previewFrame.getAttribute("name")
    ]);

    if (src) {
      return {
        src,
        title: title || "",
        name: name || ""
      };
    }

    await page.waitForTimeout(pollMs);
  }

  throw new Error("Lovable preview iframe is present but never received a src.");
}

export async function capturePreviewSnapshot({
  previewUrl,
  outputPath,
  viewport,
  isMobile = false,
  hasTouch = false,
  deviceScaleFactor = 1,
  headless = true,
  expectText = [],
  forbidText = [],
  timeoutMs = 60_000,
  settleMs = 4_000
}) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const browser = await chromium.launch({
    headless,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    viewport,
    isMobile,
    hasTouch,
    deviceScaleFactor
  });

  const page = await context.newPage();
  const consoleEntries = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on("console", (message) => {
    const type = message.type();
    if (!["error", "warning"].includes(type)) {
      return;
    }

    consoleEntries.push({
      type,
      text: message.text()
    });
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  page.on("requestfailed", (request) => {
    failedRequests.push({
      method: request.method(),
      url: request.url(),
      errorText: request.failure()?.errorText || ""
    });
  });

  try {
    const response = await page.goto(previewUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs
    });
    await page.waitForTimeout(settleMs);

    const snapshot = await page.evaluate((assertions) => {
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      const searchableText = normalize(document.body?.innerText || "");
      const searchableLower = searchableText.toLowerCase();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const root = document.scrollingElement || document.documentElement;
      const scrollWidth = Math.max(
        root?.scrollWidth || 0,
        document.documentElement?.scrollWidth || 0,
        document.body?.scrollWidth || 0
      );
      const scrollHeight = Math.max(
        root?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0
      );

      const normalizeNeedle = (value) => normalize(value).toLowerCase();
      const missingExpectedTexts = assertions.expectText.filter((value) => {
        return !searchableLower.includes(normalizeNeedle(value));
      });
      const forbiddenTextsFound = assertions.forbidText.filter((value) => {
        return searchableLower.includes(normalizeNeedle(value));
      });

      const overflowSamples = [];
      for (const element of Array.from(document.querySelectorAll("body *"))) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }

        if (["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT"].includes(element.tagName)) {
          continue;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (
          rect.width < 24 ||
          rect.height < 12 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity || "1") === 0
        ) {
          continue;
        }

        const leftOverflow = Math.max(0, -rect.left);
        const rightOverflow = Math.max(0, rect.right - viewportWidth);
        if (leftOverflow <= 8 && rightOverflow <= 8) {
          continue;
        }

        overflowSamples.push({
          tag: element.tagName.toLowerCase(),
          text: normalize(element.innerText || element.textContent || "").slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width)
        });

        if (overflowSamples.length >= 5) {
          break;
        }
      }

      const layoutIssues = [];
      if (scrollWidth > viewportWidth + 4) {
        layoutIssues.push({
          type: "horizontal_overflow",
          viewportWidth,
          scrollWidth
        });
      }

      if (overflowSamples.length > 0) {
        layoutIssues.push({
          type: "elements_out_of_viewport",
          samples: overflowSamples
        });
      }

      return {
        title: document.title,
        bodyText: searchableText.slice(0, 500),
        bodyTextLength: searchableText.length,
        htmlLength: document.documentElement?.outerHTML.length || 0,
        viewportWidth,
        viewportHeight,
        scrollWidth,
        scrollHeight,
        layoutIssues,
        missingExpectedTexts,
        forbiddenTextsFound
      };
    }, {
      expectText,
      forbidText
    });

    await page.screenshot({
      path: outputPath,
      fullPage: true
    });

    return {
      ok: true,
      finalUrl: page.url(),
      status: response?.status() ?? null,
      outputPath,
      snapshot,
      consoleEntries,
      pageErrors,
      failedRequests
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function getPromptState(page, prompt) {
  return page.evaluate((expectedPrompt) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const bodyText = normalize(document.body?.innerText || "");
    const input = document.querySelector('[aria-label="Chat input"]');
    const inputText = normalize(input?.textContent || "");
    const bodyWithoutInput = normalize(
      document.body?.innerText?.replace(input?.textContent || "", "") || ""
    );

    return {
      hasPromptText: bodyText.includes(expectedPrompt),
      hasPromptOutsideInput: bodyWithoutInput.includes(expectedPrompt),
      promptStillInInput: inputText.includes(expectedPrompt),
      needsVerification: bodyText.includes("Verification required"),
      isThinking: bodyText.includes("Thinking"),
      inputText,
      bodyText
    };
  }, prompt);
}

export async function waitForPromptResult(page, {
  prompt,
  timeoutMs = 20_000,
  pollMs = 1_000
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await getPromptState(page, prompt);

    if (state.needsVerification) {
      return {
        ok: false,
        reason: "verification_required",
        state
      };
    }

    if (state.hasPromptOutsideInput && !state.promptStillInInput) {
      return {
        ok: true,
        reason: "prompt_visible",
        state
      };
    }

    await page.waitForTimeout(pollMs);
  }

  return {
    ok: false,
    reason: "timeout",
    state: null
  };
}

export async function waitForChatAcceptance(page, {
  projectUrl,
  timeoutMs = 120_000
}) {
  const projectIdMatch = (projectUrl || page.url()).match(/\/projects\/([^/?#]+)/);
  if (!projectIdMatch) {
    return {
      ok: false,
      reason: "invalid_project_url",
      status: null
    };
  }

  const chatPath = `/projects/${projectIdMatch[1]}/chat`;

  return new Promise((resolve) => {
    let settled = false;
    let lastStatus = null;

    const cleanup = () => {
      clearTimeout(timer);
      page.off("response", onResponse);
    };

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const onResponse = (response) => {
      if (response.request().method() !== "POST") {
        return;
      }

      if (!response.url().includes(chatPath)) {
        return;
      }

      lastStatus = response.status();

      if (response.status() === 202) {
        finish({
          ok: true,
          reason: "accepted",
          status: response.status()
        });
      }
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        reason: lastStatus === 428 ? "verification_required" : "timeout",
        status: lastStatus
      });
    }, timeoutMs);

    page.on("response", onResponse);
  });
}

export async function waitForVerificationResolution(page, {
  prompt,
  timeoutMs = 10 * 60 * 1000,
  pollMs = 1_000
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await getPromptState(page, prompt);

    if (!state.needsVerification && !state.promptStillInInput) {
      return {
        ok: true,
        reason: state.hasPromptOutsideInput ? "prompt_visible" : "input_cleared",
        state
      };
    }

    await page.waitForTimeout(pollMs);
  }

  return {
    ok: false,
    reason: "verification_timeout",
    state: await getPromptState(page, prompt)
  };
}

export async function confirmPromptPersistsAfterReload(page, {
  prompt,
  timeoutMs = 20_000,
  settleMs = 6_000,
  pollMs = 1_000
}) {
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForTimeout(settleMs);

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await getPromptState(page, prompt);

    if (state.needsVerification) {
      return {
        ok: false,
        reason: "verification_required",
        state
      };
    }

    if (state.hasPromptOutsideInput && !state.promptStillInInput) {
      return {
        ok: true,
        reason: "persisted_after_reload",
        state
      };
    }

    await page.waitForTimeout(pollMs);
  }

  return {
    ok: false,
    reason: "not_persisted_after_reload",
    state: null
  };
}

export async function getPublishSurfaceState(page, {
  timeoutMs = 0
} = {}) {
  const surface = getPublishSurfaceLocator(page);

  if (timeoutMs > 0) {
    await surface.waitFor({ state: "visible", timeout: timeoutMs });
  }

  const visible = await surface.isVisible().catch(() => false);
  if (!visible) {
    return null;
  }

  const snapshot = await surface.evaluate((root) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const text = normalize(root.textContent || "");
    const buttons = Array.from(root.querySelectorAll("button,[role='button']"))
      .map((element) => ({
        text: normalize(element.textContent || ""),
        ariaLabel: element.getAttribute("aria-label") || ""
      }))
      .filter((entry) => entry.text || entry.ariaLabel);
    const links = Array.from(root.querySelectorAll("a"))
      .map((anchor) => ({
        text: normalize(anchor.textContent || ""),
        href: anchor.getAttribute("href") || ""
      }))
      .filter((entry) => entry.text || entry.href);
    const fragments = Array.from(root.querySelectorAll("*"))
      .map((element) => normalize(element.textContent || ""))
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 200);

    return {
      text,
      buttons,
      links,
      fragments
    };
  });

  const embeddedDomain = [
    ...snapshot.buttons.map((entry) => entry.text),
    ...snapshot.links.map((entry) => entry.text),
    ...snapshot.fragments,
    snapshot.text
  ]
    .flatMap((value) => {
      const match = String(value || "").match(/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:lovable\.app|lovableproject\.com))/i);
      return match?.[1] ? [match[1]] : [];
    })
    .sort((left, right) => left.length - right.length)
    .map((value) => normalizePublishUrl(value))
    .find(Boolean) || null;
  const linkedUrl = snapshot.links
    .map((entry) => normalizePublishUrl(entry.href) || normalizePublishUrl(entry.text))
    .find((value) => {
      return /\.(?:lovable\.app|lovableproject\.com)(?:\/|$)/i.test(value || "");
    }) || null;
  const liveUrl = embeddedDomain || linkedUrl;
  const step = classifyPublishSurface(snapshot.text);
  const buttonLabels = snapshot.buttons.map((entry) => entry.text || entry.ariaLabel);

  return {
    ...snapshot,
    step,
    liveUrl,
    canContinue: buttonLabels.some((label) => /^Continue$/i.test(label)),
    canPublish: buttonLabels.some((label) => /^Publish$/i.test(label)),
    canUpdate: buttonLabels.some((label) => /^Update$/i.test(label)),
    isPublishing: buttonLabels.some((label) => /^Publishing$/i.test(label)) || /\bPublishing\b/i.test(snapshot.text)
  };
}

export async function openPublishSurface(page, {
  timeoutMs = 15_000
} = {}) {
  const trigger = page.getByRole("button", {
    name: /^Publish$/i
  }).first();

  await trigger.waitFor({ state: "visible", timeout: timeoutMs });
  await trigger.click();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getPublishSurfaceState(page).catch(() => null);
    if (state) {
      return state;
    }
    await page.waitForTimeout(250);
  }

  throw new Error("Lovable did not open the publish surface.");
}

async function clickPublishSurfaceButton(page, label, {
  timeoutMs = 15_000
} = {}) {
  const surface = getPublishSurfaceLocator(page);
  const button = surface.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(label)}$`, "i")
  }).first();

  await button.waitFor({ state: "visible", timeout: timeoutMs });
  await button.click();
}

async function waitForPublishSurfaceChange(page, previousState, {
  timeoutMs = 15_000,
  pollMs = 250
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentState = await getPublishSurfaceState(page).catch(() => null);
    if (
      currentState &&
      (!previousState ||
        currentState.step !== previousState.step ||
        currentState.text !== previousState.text ||
        currentState.liveUrl !== previousState.liveUrl)
    ) {
      return currentState;
    }

    await page.waitForTimeout(pollMs);
  }

  return await getPublishSurfaceState(page).catch(() => null);
}

async function probeUrlStatus(url, {
  timeoutMs = 15_000
} = {}) {
  const makeRequest = async (method) => {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });

    return {
      ok: response.ok,
      status: response.status,
      url: response.url
    };
  };

  try {
    const headResponse = await makeRequest("HEAD");
    if (headResponse.status !== 405) {
      return headResponse;
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      url,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    return await makeRequest("GET");
  } catch (error) {
    return {
      ok: false,
      status: null,
      url,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function waitForReachableUrl(url, {
  timeoutMs = 5 * 60 * 1000,
  pollMs = 3_000
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = null;

  while (Date.now() < deadline) {
    lastProbe = await probeUrlStatus(url, {
      timeoutMs: Math.min(15_000, pollMs + 10_000)
    });

    if (lastProbe.ok) {
      return lastProbe;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const detail = lastProbe?.status
    ? ` Last status: ${lastProbe.status}.`
    : lastProbe?.error
      ? ` Last error: ${lastProbe.error}.`
      : "";

  throw new Error(`Timed out waiting for the published site to become reachable at ${url}.${detail}`);
}

export async function publishProject(page, {
  timeoutMs = 6 * 60 * 1000,
  stepTimeoutMs = 60_000,
  liveUrlTimeoutMs = 5 * 60 * 1000,
  pollMs = 2_000
} = {}) {
  const projectId = page.url().match(/\/projects\/([^/?#]+)/)?.[1];
  if (!projectId) {
    throw new Error("Publish expects a Lovable project page URL.");
  }

  let state = await openPublishSurface(page, {
    timeoutMs: stepTimeoutMs
  });
  const stepHistory = [summarizePublishState(state)];

  if (state.step === "published" && !state.canUpdate) {
    const liveCheck = state.liveUrl
      ? await probeUrlStatus(state.liveUrl)
      : null;

    return {
      ok: true,
      alreadyPublished: true,
      liveUrl: state.liveUrl,
      liveCheck,
      state,
      stepHistory,
      publishEvents: [],
      deploymentId: null,
      siteInfoUpdated: false
    };
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (["review", "publishing", "published"].includes(state.step)) {
      break;
    }

    if (!state.canContinue) {
      throw new Error(`Lovable publish wizard stalled at "${state.step}" without a Continue button.`);
    }

    await clickPublishSurfaceButton(page, "Continue", {
      timeoutMs: stepTimeoutMs
    });

    const nextState = await waitForPublishSurfaceChange(page, state, {
      timeoutMs: stepTimeoutMs
    });

    if (!nextState) {
      throw new Error("Lovable publish wizard disappeared unexpectedly.");
    }

    state = nextState;
    stepHistory.push(summarizePublishState(state));
  }

  if (state.step === "published" && !state.canUpdate) {
    return {
      ok: true,
      alreadyPublished: true,
      liveUrl: state.liveUrl,
      liveCheck: state.liveUrl ? await probeUrlStatus(state.liveUrl) : null,
      state,
      stepHistory,
      publishEvents: [],
      deploymentId: null,
      siteInfoUpdated: false
    };
  }

  const isUpdateFlow = state.step === "published" && state.canUpdate;

  if (!isUpdateFlow && state.step !== "review") {
    throw new Error(`Lovable publish flow is not ready. Current step: ${state.step}.`);
  }

  const publishEvents = [];
  const projectPathPattern = new RegExp(`/projects/${escapeRegExp(projectId)}(?:$|/)`);

  const onResponse = async (response) => {
    const request = response.request();
    const url = response.url();

    if (!projectPathPattern.test(url)) {
      return;
    }

    let kind = null;

    if (request.method() === "PUT" && new RegExp(`/projects/${escapeRegExp(projectId)}$`).test(url)) {
      kind = "project_update";
    } else if (request.method() === "POST" && url.includes(`/projects/${projectId}/edit-code`)) {
      kind = "edit_code";
    } else if (request.method() === "POST" && url.includes(`/projects/${projectId}/deployments?async=true`)) {
      kind = "deployment_create";
    } else if (request.method() === "GET" && new RegExp(`/projects/${escapeRegExp(projectId)}/deployments/[^/]+/progress`).test(url)) {
      kind = "deployment_progress";
    }

    if (!kind) {
      return;
    }

    const responseBody = kind === "deployment_progress"
      ? null
      : await readResponseBody(response);
    publishEvents.push({
      kind,
      requestMethod: request.method(),
      requestBody: safeJsonParse(request.postData()),
      responseBody,
      status: response.status(),
      url,
      deploymentId: url.match(/\/deployments\/([^/?#]+)(?:\/progress)?/)?.[1] || extractDeploymentId(responseBody)
    });
  };

  page.on("response", onResponse);

  try {
    const triggerLabel = isUpdateFlow ? "Update" : "Publish";

    await clickPublishSurfaceButton(page, triggerLabel, {
      timeoutMs: stepTimeoutMs
    });

    const publishStartDeadline = Date.now() + stepTimeoutMs;
    while (Date.now() < publishStartDeadline) {
      const currentState = await getPublishSurfaceState(page).catch(() => null);
      if (currentState) {
        state = currentState;
      }

      if (
        state?.isPublishing ||
        publishEvents.some((event) => event.kind === "deployment_create") ||
        (isUpdateFlow && currentState && !currentState.canUpdate) ||
        (!isUpdateFlow && state?.step === "published")
      ) {
        break;
      }

      await page.waitForTimeout(500);
    }

    stepHistory.push(summarizePublishState(state));

    const intendedLiveUrl = state?.liveUrl ||
      [...stepHistory].reverse().map((entry) => entry.liveUrl).find(Boolean) ||
      null;

    if (!intendedLiveUrl) {
      throw new Error("Lovable publish flow never exposed a live URL.");
    }

    const liveCheck = await waitForReachableUrl(intendedLiveUrl, {
      timeoutMs: Math.min(timeoutMs, liveUrlTimeoutMs),
      pollMs
    });

    const finalState = await getPublishSurfaceState(page).catch(() => null);
    if (finalState) {
      stepHistory.push(summarizePublishState(finalState));
      state = finalState;
    }

    const deploymentEvent = [...publishEvents].reverse().find((event) => event.kind === "deployment_create");
    const projectUpdateEvent = [...publishEvents].reverse().find((event) => event.kind === "project_update");
    const editCodeEvent = [...publishEvents].reverse().find((event) => event.kind === "edit_code");
    const deploymentProgress = [...publishEvents].reverse().find((event) => event.kind === "deployment_progress");

    return {
      ok: true,
      alreadyPublished: false,
      updatedExisting: isUpdateFlow,
      liveUrl: intendedLiveUrl,
      liveCheck,
      state,
      stepHistory,
      publishEvents,
      deploymentId: deploymentEvent?.deploymentId || deploymentProgress?.deploymentId || null,
      deploymentEvent,
      deploymentProgress,
      projectUpdateEvent,
      siteInfoUpdated: Boolean(editCodeEvent),
      editCodeEvent
    };
  } finally {
    page.off("response", onResponse);
  }
}

export async function getPublishedSettingsState(page, {
  projectUrl = page.url(),
  timeoutMs = 60_000
} = {}) {
  await page.goto(projectUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs
  });

  const visibilityMenu = await openPublishedVisibilitySettings(page, {
    timeoutMs: Math.min(timeoutMs, 20_000)
  });
  const visibility = await readPublishVisibilityState(visibilityMenu);

  await page.goto(projectUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs
  });

  const websiteInfoMenu = await openPublishedWebsiteInfoSettings(page, {
    timeoutMs: Math.min(timeoutMs, 20_000)
  });
  const websiteInfo = await readPublishWebsiteInfoState(websiteInfoMenu);

  return {
    projectUrl,
    visibility,
    websiteInfo
  };
}

export async function updatePublishedSettings(page, {
  projectUrl = page.url(),
  visibility,
  title,
  description,
  timeoutMs = 60_000
} = {}) {
  const changes = [];
  let hasPendingChanges = false;

  await page.goto(projectUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs
  });

  let editSettingsMenu = await openPublishedEditSettings(page, {
    timeoutMs: Math.min(timeoutMs, 20_000)
  });

  if (visibility !== undefined) {
    const visibilityKey = normalizeVisibilityKey(visibility);
    const visibilityButton = editSettingsMenu.getByRole("button", {
      name: /Visibility/i
    }).first();
    await visibilityButton.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) });
    await visibilityButton.click();

    const visibilityMenu = getPublishVisibilityLocator(page);
    await visibilityMenu.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 20_000) });

    const currentVisibility = await readPublishVisibilityState(visibilityMenu);
    const targetOption = currentVisibility.options.find((option) => option.key === visibilityKey);

    if (!targetOption) {
      throw new Error(`Lovable did not expose a "${visibilityKey}" publish visibility option for this project.`);
    }

    if (targetOption.disabled) {
      throw new Error(`Lovable exposes the "${visibilityKey}" publish visibility option, but it is disabled for this project/workspace.`);
    }

    if (!targetOption.selected) {
      const optionButton = visibilityMenu.getByRole("button", {
        name: getVisibilityChoicePattern(visibilityKey)
      }).first();
      await optionButton.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) });
      await optionButton.click();
      hasPendingChanges = true;
      changes.push(`visibility=${visibilityKey}`);
    }

    await visibilityMenu.getByRole("button", {
      name: /^Done$/i
    }).first().click();

    editSettingsMenu = getPublishEditSettingsLocator(page);
    await editSettingsMenu.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 20_000) });
  }

  if (title !== undefined || description !== undefined) {
    const websiteInfoButton = editSettingsMenu.getByRole("button", {
      name: /Website info/i
    }).first();
    await websiteInfoButton.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) });
    await websiteInfoButton.click();

    const websiteInfoMenu = getPublishWebsiteInfoLocator(page);
    await websiteInfoMenu.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 20_000) });

    const currentWebsiteInfo = await readPublishWebsiteInfoState(websiteInfoMenu);
    const titleInput = websiteInfoMenu.locator("input[name='title']").first();
    const descriptionInput = websiteInfoMenu.locator("textarea[name='description']").first();

    if (title !== undefined) {
      const normalizedTitle = String(title);
      await titleInput.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) });
      if (currentWebsiteInfo.title !== normalizedTitle) {
        await titleInput.fill(normalizedTitle);
        hasPendingChanges = true;
        changes.push(`title=${normalizedTitle || "(empty)"}`);
      }
    }

    if (description !== undefined) {
      const normalizedDescription = String(description);
      await descriptionInput.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) });
      if (currentWebsiteInfo.description !== normalizedDescription) {
        await descriptionInput.fill(normalizedDescription);
        hasPendingChanges = true;
        changes.push(`description=${normalizedDescription || "(empty)"}`);
      }
    }

    await websiteInfoMenu.getByRole("button", {
      name: /^Done$/i
    }).first().click();

    editSettingsMenu = getPublishEditSettingsLocator(page);
    await editSettingsMenu.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 20_000) });
  }

  if (hasPendingChanges) {
    const saveChangesButton = editSettingsMenu.getByRole("button", {
      name: /Save changes/i
    }).first();
    await saveChangesButton.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) });
    await saveChangesButton.click();
    await page.waitForLoadState("networkidle", {
      timeout: 5_000
    }).catch(() => {});
    await page.waitForTimeout(1_000);
  }

  const state = await getPublishedSettingsState(page, {
    projectUrl,
    timeoutMs
  });

  return {
    ok: true,
    projectUrl,
    changes,
    state
  };
}

export async function getProjectDomainSettingsState(page, {
  projectUrl = page.url(),
  timeoutMs = 60_000
} = {}) {
  const settingsUrl = await gotoProjectDomainsSettings(page, projectUrl, {
    timeoutMs
  });
  const main = page.locator("main[aria-label='Settings content'], main").first();
  await main.waitFor({
    state: "visible",
    timeout: Math.min(timeoutMs, 20_000)
  });
  await page.getByText(/Publish your project to custom domains/i).first().waitFor({
    state: "visible",
    timeout: Math.min(timeoutMs, 20_000)
  }).catch(() => {});
  const snapshot = await readDomainsSettingsStateFromPage(page);

  if (!snapshot) {
    throw new Error("Lovable domain settings page did not render.");
  }

  const liveUrl = normalizePublishUrl(snapshot.liveUrl) || null;
  const liveHost = liveUrl ? new URL(liveUrl).hostname : null;
  const suggestedPurchaseDomains = snapshot.suggestedDomains
    .filter((domain) => domain !== liveHost)
    .filter((domain) => !/lovable\.dev$/i.test(domain))
    .filter((domain) => !/lovable\.app$/i.test(domain))
    .slice(0, 10);

  return {
    projectUrl,
    settingsUrl,
    liveUrl,
    subdomain: liveHost ? liveHost.split(".")[0] : null,
    buttons: snapshot.buttons,
    editUrlAvailable: snapshot.buttons.some((button) => /^Edit URL$/i.test(button.text)),
    connectExistingDomainAvailable: snapshot.buttons.some((button) => /^Connect domain$/i.test(button.text)),
    suggestedPurchaseDomains
  };
}

export async function updateProjectSubdomain(page, {
  projectUrl = page.url(),
  subdomain,
  timeoutMs = 60_000,
  liveUrlTimeoutMs = 5 * 60 * 1000,
  pollMs = 3_000
} = {}) {
  const normalizedSubdomain = normalizeSubdomain(subdomain);
  const initialState = await getProjectDomainSettingsState(page, {
    projectUrl,
    timeoutMs
  });

  if (!initialState.editUrlAvailable) {
    throw new Error("Lovable did not expose the default URL editing flow on the domain settings page.");
  }

  const expectedLiveUrl = initialState.liveUrl
    ? `https://${normalizedSubdomain}.${getLiveHostSuffix(initialState.liveUrl)}`
    : `https://${normalizedSubdomain}.lovable.app`;

  if (initialState.subdomain === normalizedSubdomain) {
    const liveCheck = await probeUrlStatus(expectedLiveUrl);
    return {
      ok: true,
      changed: false,
      initialState,
      finalState: initialState,
      liveUrl: expectedLiveUrl,
      liveCheck
    };
  }

  const settingsUrl = await gotoProjectDomainsSettings(page, projectUrl, {
    timeoutMs
  });
  void settingsUrl;

  const main = page.locator("main[aria-label='Settings content'], main").first();
  const editUrlTrigger = main.getByText(/^Edit URL$/i).first();
  await editUrlTrigger.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 20_000) });
  await editUrlTrigger.click();

  const dialog = getDomainEditUrlLocator(page);
  await dialog.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 20_000) });

  const input = dialog.locator("input[name='domain']").first();
  await input.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) });
  await input.fill(normalizedSubdomain);

  const updateButton = dialog.getByRole("button", {
    name: /^Update URL subdomain$/i
  }).first();
  await updateButton.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) });
  await updateButton.click();

  await dialog.waitFor({ state: "hidden", timeout: Math.min(timeoutMs, 30_000) }).catch(() => {});
  await page.waitForLoadState("networkidle", {
    timeout: 5_000
  }).catch(() => {});
  await page.waitForTimeout(1_000);

  const finalState = await getProjectDomainSettingsState(page, {
    projectUrl,
    timeoutMs
  });
  const liveUrl = finalState.liveUrl || expectedLiveUrl;
  const liveCheck = await waitForReachableUrl(liveUrl, {
    timeoutMs: Math.min(timeoutMs, liveUrlTimeoutMs),
    pollMs
  });

  return {
    ok: true,
    changed: true,
    initialState,
    finalState,
    liveUrl,
    liveCheck
  };
}
