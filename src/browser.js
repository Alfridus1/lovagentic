import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { DEFAULT_BASE_URL } from "./config.js";
import {
  classifyIdleStateSnapshot,
  DEFAULT_IDLE_POLL_MS,
  DEFAULT_IDLE_STREAK_TARGET,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_QUEUE_RESUME_ATTEMPTS,
  QUEUE_RESUME_ACTION_LABELS
} from "./orchestration.js";

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
const DASHBOARD_PATH = "/dashboard";
const DASHBOARD_READY_PATTERN = /All projects|Shared with me|Recents/i;
const DASHBOARD_WORKSPACE_MENU_PATTERN = /workspace menu/i;

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

async function readEditableText(target) {
  return target.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return String(element.value || "");
    }

    return String(element.innerText ?? element.textContent ?? "");
  });
}

async function fillEditableTarget(page, target, text) {
  const tagName = await target.evaluate((element) => element.tagName.toLowerCase());

  await target.click();

  if (tagName === "textarea" || tagName === "input") {
    await target.fill(text);
    return { method: "fill", tagName };
  }

  await target.evaluate((element) => {
    element.focus();

    const selection = element.ownerDocument.defaultView?.getSelection();
    if (!selection) {
      return;
    }

    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  });

  await page.keyboard.insertText(text);

  const insertedText = await readEditableText(target);
  if (normalizeText(insertedText) !== normalizeText(text)) {
    throw new Error(
      "Failed to verify the Lovable composer contents after insertText. The prompt was not inserted exactly as expected."
    );
  }

  return { method: "insertText", tagName };
}

export async function fillPrompt(page, prompt, {
  selector
} = {}) {
  const handle = await getPromptHandle(page, selector);
  return fillEditableTarget(page, handle, prompt);
}

async function getPromptFileInput(page, timeoutMs = 15_000) {
  await waitForChatComposer(page, {
    timeoutMs,
    pollMs: 250
  });

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const locator = page.locator("form#chat-input input[type='file'], input[type='file']#file-upload, input[type='file']").first();
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      return locator;
    }
    await page.waitForTimeout(250);
  }

  throw new Error("Could not find a Lovable file input near the chat composer.");
}

export async function getPromptAttachmentState(page) {
  return page.evaluate(() => {
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
    const form = document.querySelector("form#chat-input") ||
      document.querySelector('[aria-label="Chat input"]')?.closest("form") ||
      null;

    if (!form) {
      return {
        formFound: false,
        inputPresent: false,
        filenames: [],
        removeActions: [],
        text: "",
        sendEnabled: null
      };
    }

    const fileInput = form.querySelector("input[type='file']") ||
      document.querySelector("input[type='file']#file-upload") ||
      document.querySelector("input[type='file']");
    const sendButton = Array.from(document.querySelectorAll(
      "#chatinput-send-message-button,[type='submit'],button[aria-label*='Send' i],button"
    )).find((element) => {
      if (!(element instanceof HTMLElement) || !isRendered(element)) {
        return false;
      }

      const label = String(element.getAttribute("aria-label") || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      return /send message|^send$/i.test(label);
    }) || null;
    const filenames = fileInput?.files
      ? Array.from(fileInput.files)
        .map((file) => String(file.name || "").trim())
        .filter(Boolean)
      : [];

    const removeActions = Array.from(form.querySelectorAll("[aria-label]"))
      .map((element) => String(element.getAttribute("aria-label") || "").trim())
      .filter((label) => /^Remove\s+/i.test(label));

    return {
      formFound: true,
      inputPresent: Boolean(fileInput),
      filenames,
      removeActions,
      text: String(form.innerText || form.textContent || "").replace(/\s+/g, " ").trim(),
      sendEnabled: sendButton ? !sendButton.matches("[disabled],[aria-disabled='true']") : null
    };
  });
}

export async function uploadPromptAttachments(page, filePaths, {
  timeoutMs = 15_000,
  pollMs = 250
} = {}) {
  const normalizedPaths = Array.isArray(filePaths)
    ? filePaths.map((filePath) => path.resolve(filePath))
    : [];

  if (normalizedPaths.length === 0) {
    return {
      uploaded: [],
      state: await getPromptAttachmentState(page)
    };
  }

  const expectedFilenames = normalizedPaths.map((filePath) => path.basename(filePath));
  const input = await getPromptFileInput(page, timeoutMs);
  await input.setInputFiles(normalizedPaths);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getPromptAttachmentState(page);
    const allPresent = expectedFilenames.every((filename) => {
      return state.filenames.includes(filename) || state.text.includes(filename);
    });

    if (allPresent) {
      return {
        uploaded: expectedFilenames,
        state
      };
    }

    await page.waitForTimeout(pollMs);
  }

  throw new Error(
    `Lovable did not show the uploaded attachments within the expected time. Expected: ${expectedFilenames.join(", ")}`
  );
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

async function listVisiblePageActions(page) {
  return page.locator(ACTIONABLE_SELECTORS).evaluateAll((elements) => {
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
        Number(style.opacity || "1") > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
    };

    return elements
      .map((element, domIndex) => {
        if (!(element instanceof HTMLElement) || !isRendered(element)) {
          return null;
        }

        const rect = element.getBoundingClientRect();
        const text = normalize(element.textContent || "");
        const ariaLabel = normalize(element.getAttribute("aria-label") || "");
        const label = text || ariaLabel;
        if (!label) {
          return null;
        }

        return {
          domIndex,
          label,
          text,
          ariaLabel,
          tagName: element.tagName.toLowerCase(),
          disabled: element.matches("[disabled],[aria-disabled='true'],[data-disabled='true']"),
          x: Math.round(rect.x),
          y: Math.round(rect.y)
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }
        return left.x - right.x;
      });
  });
}

async function clickVisiblePageActionExact(page, {
  labels,
  timeoutMs = 15_000,
  settleMs = 1_000
} = {}) {
  const normalizedLabels = labels
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean);

  if (normalizedLabels.length === 0) {
    throw new Error("Expected at least one visible page action label.");
  }

  const actions = await listVisiblePageActions(page);
  const target = actions.find((action) => {
    return !action.disabled && normalizedLabels.includes(normalizeText(action.label).toLowerCase());
  });

  if (!target) {
    return null;
  }

  const locator = page.locator(ACTIONABLE_SELECTORS).nth(target.domIndex);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: timeoutMs });
  } catch {
    await locator.click({ timeout: Math.min(timeoutMs, 5_000), force: true }).catch(async () => {
      await locator.evaluate((element) => element.click());
    });
  }

  await page.waitForTimeout(settleMs);
  return target;
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

function normalizeQuestionActionLabel(value) {
  return normalizeText(value)
    .replace(/:.*$/, "")
    .replace(/\s+answers?$/i, "");
}

async function getVisibleQuestionSnapshot(page) {
  return page.locator("button,[role='button']").evaluateAll((elements) => {
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

    const getActionLabel = (element) => {
      const text = normalize(element.textContent || "");
      const ariaLabel = normalize(element.getAttribute("aria-label") || "");
      const rawLabel = text || ariaLabel;
      return {
        label: normalize(rawLabel.replace(/:.*$/, "").replace(/\s+answers?$/i, "")),
        text,
        ariaLabel
      };
    };

    const submitButton = elements.find((element) => {
      if (!(element instanceof HTMLElement) || !isRendered(element)) {
        return false;
      }

      const { label, text, ariaLabel } = getActionLabel(element);
      return /^(Submit)$/i.test(label) || /Submit answers/i.test(`${text} ${ariaLabel}`);
    });

    if (!(submitButton instanceof HTMLElement)) {
      return {
        open: false,
        title: null,
        prompt: null,
        mode: null,
        input: {
          present: false,
          tagName: null,
          placeholder: null,
          value: null
        },
        actions: []
      };
    }

    let root = submitButton.closest("div") || submitButton;
    for (let current = submitButton.parentElement; current; current = current.parentElement) {
      const texts = Array.from(current.querySelectorAll("span,p"))
        .map((element) => normalize(element.textContent || ""))
        .filter(Boolean);
      if (texts.some((value) => /^Questions$/i.test(value))) {
        root = current;
        break;
      }
    }

    const prompt = Array.from(root.querySelectorAll("p"))
      .map((element) => normalize(element.textContent || ""))
      .find((value) => {
        return value &&
          !/^Questions$/i.test(value) &&
          !/^Select\b/i.test(value) &&
          !/^(Skip|Submit)$/i.test(value);
      }) || null;

    const mode = Array.from(root.querySelectorAll("span,p,div"))
      .map((element) => normalize(element.textContent || ""))
      .find((value) => /^Select\b/i.test(value)) || null;

    const input = root.querySelector(
      "[contenteditable='true'][aria-label*='Mention input' i],textarea,input:not([type='button']):not([type='submit']):not([type='radio']):not([type='checkbox'])"
    );
    const placeholder = input
      ? normalize(
        input.getAttribute("placeholder") ||
        input.closest("div")?.querySelector("span")?.textContent ||
        ""
      )
      : null;
    const inputValue = input
      ? normalize("value" in input ? input.value : input.textContent || "")
      : null;

    const actions = elements
      .map((element, domIndex) => {
        if (!(element instanceof HTMLElement) || !root.contains(element) || !isRendered(element)) {
          return null;
        }

        const rect = element.getBoundingClientRect();
        const { label, text, ariaLabel } = getActionLabel(element);
        if (!label) {
          return null;
        }

        return {
          domIndex,
          label,
          text,
          ariaLabel,
          disabled: element.matches("[disabled],[aria-disabled='true'],[data-disabled='true']"),
          tagName: element.tagName.toLowerCase(),
          x: Math.round(rect.x),
          y: Math.round(rect.y)
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }
        return left.x - right.x;
      });

    return {
      open: true,
      title: "Questions",
      prompt,
      mode,
      input: {
        present: Boolean(input),
        tagName: input ? input.tagName.toLowerCase() : null,
        placeholder: placeholder || null,
        value: inputValue
      },
      actions
    };
  });
}

export async function getProjectQuestionState(page, {
  timeoutMs = 2_000,
  pollMs = 250
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = await getVisibleQuestionSnapshot(page);

  while (Date.now() < deadline) {
    if (lastSnapshot.open) {
      return lastSnapshot;
    }

    await page.waitForTimeout(pollMs);
    lastSnapshot = await getVisibleQuestionSnapshot(page);
  }

  return lastSnapshot;
}

export async function listQuestionActions(page, {
  timeoutMs = 2_000,
  pollMs = 250
} = {}) {
  const state = await getProjectQuestionState(page, {
    timeoutMs,
    pollMs
  });

  return state.actions || [];
}

export async function clickQuestionAction(page, {
  label,
  exact = false,
  matchIndex = 0,
  timeoutMs = 15_000,
  settleMs = 1_500,
  actionsTimeoutMs = 2_000,
  actionsPollMs = 250
}) {
  const normalizedLabel = normalizeQuestionActionLabel(label).toLowerCase();
  if (!normalizedLabel) {
    throw new Error("Expected a non-empty question action label.");
  }

  const deadline = Date.now() + actionsTimeoutMs;
  let actions = [];
  let matches = [];
  let target = null;

  while (Date.now() < deadline) {
    actions = await listQuestionActions(page, {
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
    throw new Error(`No visible question action matched "${label}". Visible actions: ${visibleActions}`);
  }

  if (matchIndex < 0 || matchIndex >= matches.length) {
    throw new Error(
      `Match index ${matchIndex} is out of range for "${label}". Matching question actions: ${matches.map((action) => action.label).join(", ")}`
    );
  }

  target = matches[matchIndex];
  if (target.disabled) {
    throw new Error(`Question action "${target.label}" is currently disabled.`);
  }

  const locator = page.locator("button,[role='button']").nth(target.domIndex);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: timeoutMs });
  } catch {
    await locator.click({ timeout: Math.min(timeoutMs, 5_000), force: true }).catch(async () => {
      await locator.evaluate((element) => element.click());
    });
  }

  await page.waitForTimeout(settleMs);

  return {
    clicked: target,
    stateAfterClick: await getProjectQuestionState(page, {
      timeoutMs: actionsTimeoutMs,
      pollMs: actionsPollMs
    }).catch(() => ({
      open: false,
      title: null,
      prompt: null,
      mode: null,
      input: {
        present: false,
        tagName: null,
        placeholder: null,
        value: null
      },
      actions: []
    }))
  };
}

function getQuestionPaneLocator(page) {
  const submitButton = page.getByRole("button", {
    name: /Submit answers|^Submit$/i
  }).first();

  return submitButton.locator("xpath=ancestor::div[.//span[normalize-space()='Questions']][1]");
}

async function fillQuestionInput(page, answer, {
  optionLabel = "Other",
  timeoutMs = 15_000
} = {}) {
  const pane = getQuestionPaneLocator(page);
  await pane.waitFor({
    state: "visible",
    timeout: timeoutMs
  });

  const option = pane.getByText(new RegExp(`^${escapeRegExp(optionLabel)}$`, "i")).first();
  if (await option.isVisible().catch(() => false)) {
    await option.click().catch(() => {});
  }

  const editable = pane.locator(
    "[contenteditable='true'][aria-label*='Mention input' i],textarea,input:not([type='button']):not([type='submit']):not([type='radio']):not([type='checkbox'])"
  ).first();
  await editable.waitFor({
    state: "visible",
    timeout: timeoutMs
  });

  return fillEditableTarget(page, editable, answer);
}

async function submitQuestionPane(page, {
  timeoutMs = 15_000
} = {}) {
  const pane = getQuestionPaneLocator(page);
  await pane.waitFor({
    state: "visible",
    timeout: timeoutMs
  });

  const submitButton = pane.getByRole("button", {
    name: /Submit answers|^Submit$/i
  }).first();
  await submitButton.waitFor({
    state: "visible",
    timeout: timeoutMs
  });

  try {
    await submitButton.click({ timeout: timeoutMs });
  } catch {
    await submitButton.click({ timeout: Math.min(timeoutMs, 5_000), force: true }).catch(async () => {
      await submitButton.evaluate((element) => element.click());
    });
  }
}

export async function answerProjectQuestion(page, {
  projectUrl,
  answer,
  attachmentPaths = [],
  optionLabel = "Other",
  submit = true,
  timeoutMs = 15_000,
  settleMs = 1_500,
  actionsTimeoutMs = 2_000,
  actionsPollMs = 250,
  chatAcceptTimeoutMs = 30_000
} = {}) {
  if (!normalizeText(answer)) {
    throw new Error("Expected a non-empty question answer.");
  }

  const questionState = await getProjectQuestionState(page, {
    timeoutMs: actionsTimeoutMs,
    pollMs: actionsPollMs
  });

  if (!questionState.open) {
    throw new Error("No visible Lovable question card is open on this page.");
  }

  if (!questionState.input?.present) {
    throw new Error(
      "The current Lovable question does not expose a free-text answer field. Use question-action instead."
    );
  }

  let attachmentResult = null;
  if (Array.isArray(attachmentPaths) && attachmentPaths.length > 0) {
    attachmentResult = await uploadPromptAttachments(page, attachmentPaths, {
      timeoutMs,
      pollMs: 250
    });
  }

  const fillResult = await fillQuestionInput(page, answer, {
    optionLabel,
    timeoutMs
  });

  let submitResult = null;
  let chatAccepted = null;

  if (submit) {
    const acceptancePromise = waitForChatAcceptance(page, {
      projectUrl,
      timeoutMs: chatAcceptTimeoutMs
    }).catch(() => ({
      ok: false,
      reason: "timeout",
      status: null
    }));

    try {
      await submitQuestionPane(page, {
        timeoutMs
      });
      await page.waitForTimeout(settleMs);
      chatAccepted = await acceptancePromise;
    } catch (error) {
      const stateAfterFill = await getProjectQuestionState(page, {
        timeoutMs: actionsTimeoutMs,
        pollMs: actionsPollMs
      }).catch(() => ({
        open: false,
        title: null,
        prompt: null,
        mode: null,
        input: {
          present: false,
          tagName: null,
          placeholder: null,
          value: null
        },
        actions: []
      }));

      if (stateAfterFill.open) {
        throw error;
      }

      submitResult = null;
      chatAccepted = await acceptancePromise;
    }
  }

  return {
    attachmentResult,
    fillResult,
    submitResult,
    chatAccepted,
    stateAfter: await getProjectQuestionState(page, {
      timeoutMs: actionsTimeoutMs,
      pollMs: actionsPollMs
    }).catch(() => ({
      open: false,
      title: null,
      prompt: null,
      mode: null,
      input: {
        present: false,
        tagName: null,
        placeholder: null,
        value: null
      },
      actions: []
    }))
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

export async function getProjectIdleState(page, {
  timeoutMs = 750,
  pollMs = 250
} = {}) {
  const [questionState, runtimeErrorState, visibleActions, bodyText] = await Promise.all([
    getProjectQuestionState(page, {
      timeoutMs,
      pollMs
    }).catch(() => ({
      open: false,
      actions: []
    })),
    getProjectRuntimeErrorState(page, {
      timeoutMs,
      pollMs
    }).catch(() => ({
      open: false,
      actions: []
    })),
    listVisiblePageActions(page).catch(() => []),
    page.evaluate(() => document.body?.innerText || "").catch(() => "")
  ]);

  const classification = classifyIdleStateSnapshot({
    bodyText,
    visibleActionLabels: visibleActions.map((action) => action.label),
    questionOpen: questionState.open,
    runtimeErrorOpen: runtimeErrorState.open
  });

  return {
    status: classification.status,
    details: classification.details,
    bodyText,
    bodyExcerpt: String(bodyText || "").slice(0, 2_000),
    visibleActionLabels: Array.from(new Set(visibleActions.map((action) => action.label))),
    questionState,
    runtimeErrorState
  };
}

export async function clickQueueResume(page, {
  timeoutMs = 15_000,
  settleMs = 1_000
} = {}) {
  return clickVisiblePageActionExact(page, {
    labels: QUEUE_RESUME_ACTION_LABELS,
    timeoutMs,
    settleMs
  });
}

export async function waitForProjectIdle(page, {
  timeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  pollMs = DEFAULT_IDLE_POLL_MS,
  idleStreakTarget = DEFAULT_IDLE_STREAK_TARGET,
  autoResume = false,
  maxResumeAttempts = DEFAULT_QUEUE_RESUME_ATTEMPTS
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let idleStreak = 0;
  let resumeAttempts = 0;
  let lastState = await getProjectIdleState(page, {
    timeoutMs: Math.min(pollMs, 750),
    pollMs: Math.min(pollMs, 250)
  });

  while (Date.now() < deadline) {
    lastState = await getProjectIdleState(page, {
      timeoutMs: Math.min(pollMs, 750),
      pollMs: Math.min(pollMs, 250)
    });

    if (lastState.status === "idle") {
      idleStreak += 1;
      if (idleStreak >= idleStreakTarget) {
        return {
          ok: true,
          reason: "idle",
          idleStreak,
          resumeAttempts,
          state: lastState
        };
      }
    } else {
      idleStreak = 0;

      if (lastState.status === "queue_paused" && autoResume) {
        if (resumeAttempts >= maxResumeAttempts) {
          return {
            ok: false,
            reason: "queue_paused",
            idleStreak,
            resumeAttempts,
            state: lastState
          };
        }

        const resumed = await clickQueueResume(page, {
          timeoutMs: Math.max(5_000, Math.min(pollMs, 15_000))
        });
        if (!resumed) {
          return {
            ok: false,
            reason: "queue_paused",
            idleStreak,
            resumeAttempts,
            state: lastState
          };
        }

        resumeAttempts += 1;
      } else if (["queue_paused", "waiting_for_input", "error"].includes(lastState.status)) {
        return {
          ok: false,
          reason: lastState.status,
          idleStreak,
          resumeAttempts,
          state: lastState
        };
      }
    }

    await page.waitForTimeout(pollMs);
  }

  return {
    ok: false,
    reason: "timeout",
    idleStreak,
    resumeAttempts,
    state: lastState
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

function getDashboardCollectionKey(urlValue) {
  try {
    const url = new URL(urlValue);

    if (url.pathname === "/v2/user/projects/starred") {
      return "starred";
    }

    if (url.pathname === "/v2/user/projects/shared") {
      return "shared";
    }

    const workspaceProjectsMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/projects\/search$/);
    if (!workspaceProjectsMatch) {
      return null;
    }

    if (
      url.searchParams.get("sort_by") === "last_viewed_at" &&
      url.searchParams.get("viewed_by_me") === "true"
    ) {
      return "recent";
    }

    if (url.searchParams.get("sort_by") === "last_edited_at") {
      return "workspace";
    }

    return null;
  } catch {
    return null;
  }
}

function getWorkspaceIdFromDashboardUrl(urlValue) {
  return String(urlValue || "").match(/\/workspaces\/([^/]+)\/projects\/search/)?.[1] || null;
}

function isProjectListBody(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.projects));
}

function getPaginationRequestHeaders(headers) {
  const allowedKeys = new Set([
    "authorization",
    "content-type",
    "referer",
    "user-agent",
    "x-client-git-sha"
  ]);
  return Object.fromEntries(
    Object.entries(headers || {}).filter(([key, value]) => {
      return allowedKeys.has(String(key || "").toLowerCase()) && value;
    })
  );
}

async function fetchJsonWithPageSession(requestUrl, {
  headers = {}
} = {}) {
  const response = await fetch(requestUrl, {
    headers: getPaginationRequestHeaders(headers)
  });
  const contentType = response.headers.get("content-type") || "";
  let body = null;

  try {
    if (contentType.includes("application/json")) {
      body = await response.json();
    } else {
      body = await response.text();
    }
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Error(`Lovable dashboard request failed (${response.status}): ${requestUrl}`);
  }

  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    body
  };
}

async function fetchAllDashboardProjects(initialCapture, {
  pageSize = 100,
  maxPages = 50
} = {}) {
  if (!initialCapture?.url) {
    return {
      requestUrl: null,
      total: 0,
      projects: []
    };
  }

  const requestUrl = new URL(initialCapture.url);
  requestUrl.searchParams.set("limit", String(pageSize));

  const projects = [];
  const seenProjectIds = new Set();
  let total = 0;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    requestUrl.searchParams.set("offset", String(pageIndex * pageSize));
    const response = await fetchJsonWithPageSession(requestUrl.toString(), {
      headers: initialCapture.requestHeaders
    });
    const body = response.body;

    if (!isProjectListBody(body)) {
      break;
    }

    total = typeof body.total === "number" ? body.total : total;

    for (const project of body.projects) {
      if (!project?.id || seenProjectIds.has(project.id)) {
        continue;
      }

      seenProjectIds.add(project.id);
      projects.push(project);
    }

    if (!body.has_more || body.projects.length === 0) {
      break;
    }

    if (total > 0 && projects.length >= total) {
      break;
    }
  }

  return {
    requestUrl: requestUrl.toString(),
    total: total || projects.length,
    projects
  };
}

function buildDashboardLookupFromCaptures(captures, {
  dashboardUrl
} = {}) {
  const origin = new URL(dashboardUrl || DEFAULT_BASE_URL).origin;

  return {
    origin,
    collectionSeeds: Object.fromEntries(
      Array.from(captures.entries()).map(([key, capture]) => [
        key,
        {
          key,
          url: capture.url,
          requestHeaders: getPaginationRequestHeaders(capture.requestHeaders)
        }
      ])
    )
  };
}

async function openDashboardWorkspaceMenu(page, {
  timeoutMs = 10_000
} = {}) {
  const trigger = page.getByRole("button", {
    name: DASHBOARD_WORKSPACE_MENU_PATTERN
  }).first();

  await trigger.waitFor({
    state: "visible",
    timeout: timeoutMs
  });
  const triggerAriaLabel = await trigger.evaluate((element) => {
    return element.getAttribute("aria-label") || "";
  });

  const menu = page.locator('[role="menu"]').filter({
    hasText: /All workspaces|Create new workspace|Find workspaces/i
  }).last();

  const visible = await menu.isVisible().catch(() => false);
  if (!visible) {
    await trigger.click();
    await menu.waitFor({
      state: "visible",
      timeout: timeoutMs
    });
    return {
      trigger,
      triggerAriaLabel,
      menu,
      opened: true
    };
  }

  return {
    trigger,
    triggerAriaLabel,
    menu,
    opened: false
  };
}

async function readDashboardWorkspaceState(page, {
  timeoutMs = 10_000
} = {}) {
  const { triggerAriaLabel, menu, opened } = await openDashboardWorkspaceMenu(page, {
    timeoutMs
  });

  const buttonWorkspaceName = normalizeText(
    String(triggerAriaLabel || "").replace(/\s+workspace menu$/i, "")
  );

  const snapshot = await menu.evaluate((root) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const paragraphs = Array.from(root.querySelectorAll("p"))
      .map((element) => normalize(element.textContent || ""))
      .filter(Boolean);
    const currentWorkspaceName = paragraphs[0] || "";
    const currentWorkspaceMeta = paragraphs[1] || "";

    const workspaceItems = Array.from(root.querySelectorAll('[role="menuitem"]'))
      .map((element) => {
        const name = normalize(element.querySelector("p")?.textContent || "");
        const spans = Array.from(element.querySelectorAll("span"))
          .map((span) => normalize(span.textContent || ""))
          .filter(Boolean);
        const plan = spans.find((value) => !/^[A-Z]$/i.test(value)) || null;
        const isCurrent = Boolean(element.querySelector("svg.ml-auto"));

        return {
          name,
          plan,
          current: isCurrent
        };
      })
      .filter((item) => item.name);

    const menuActions = Array.from(root.querySelectorAll("button"))
      .map((button) => normalize(button.textContent || ""))
      .filter((label) => /Create new workspace|Find workspaces|Settings|Invite members/i.test(label));

    return {
      currentWorkspaceName,
      currentWorkspaceMeta,
      workspaceItems,
      menuActions
    };
  });

  if (opened) {
    await page.keyboard.press("Escape").catch(() => {});
  }

  const workspaceItems = Array.from(
    new Map(
      snapshot.workspaceItems.map((item) => [
        item.name.toLowerCase(),
        item
      ])
    ).values()
  );

  const currentWorkspace = {
    name: snapshot.currentWorkspaceName || buttonWorkspaceName || null,
    meta: snapshot.currentWorkspaceMeta || null
  };

  return {
    currentWorkspace,
    workspaces: workspaceItems.map((item) => ({
      ...item,
      current: item.current || item.name === currentWorkspace.name
    })),
    menuActions: snapshot.menuActions
  };
}

async function captureDashboardBootstrap(page, {
  dashboardUrl,
  timeoutMs = 20_000,
  pollMs = 250
} = {}) {
  const captures = new Map();

  const onResponse = async (response) => {
    if (response.request().method() !== "GET") {
      return;
    }

    const key = getDashboardCollectionKey(response.url());
    if (!key) {
      return;
    }

    const body = await readResponseBody(response);
    if (!isProjectListBody(body)) {
      return;
    }

    captures.set(key, {
      key,
      url: response.url(),
      status: response.status(),
      requestHeaders: response.request().headers(),
      body
    });
  };

  page.on("response", onResponse);

  try {
    await page.goto(dashboardUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const dashboardReady = await page.getByText(DASHBOARD_READY_PATTERN, {
        exact: false
      }).first().isVisible().catch(() => false);

      if (captures.has("workspace") && dashboardReady) {
        return {
          dashboardUrl: page.url(),
          captures
        };
      }

      await page.waitForTimeout(pollMs);
    }

    throw new Error("Lovable dashboard loaded, but the workspace project feed never appeared.");
  } finally {
    page.off("response", onResponse);
  }
}

function buildProjectUrl(projectId, baseUrl = DEFAULT_BASE_URL) {
  const url = new URL(baseUrl);
  url.pathname = `/projects/${projectId}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function mergeDashboardProjects({
  collections,
  baseUrl = DEFAULT_BASE_URL,
  currentWorkspaceId,
  currentWorkspaceName
}) {
  const merged = new Map();
  const collectionOrder = {
    workspace: 0,
    recent: 1,
    starred: 2,
    shared: 3
  };

  const mergeProject = (collectionKey, project) => {
    if (!project?.id) {
      return;
    }

    const title = project.display_name || project.name || project.id;
    const existing = merged.get(project.id) || {
      id: project.id,
      title,
      displayName: project.display_name || null,
      slug: project.name || null,
      projectUrl: buildProjectUrl(project.id, baseUrl),
      liveUrl: project.url || null,
      workspaceId: project.workspace_id || null,
      workspaceName: project.workspace_id === currentWorkspaceId ? currentWorkspaceName : null,
      visibility: project.visibility || null,
      publishVisibility: project.publish_visibility || null,
      status: project.status || null,
      published: Boolean(project.is_published),
      starred: Boolean(project.is_starred),
      accessLevel: project.access_level || null,
      ownerDisplayName: project.user_display_name || null,
      createdAt: project.created_at || null,
      updatedAt: project.updated_at || null,
      lastEditedAt: project.last_edited_at || null,
      lastViewedAt: project.last_viewed_at || null,
      editCount: typeof project.edit_count === "number" ? project.edit_count : null,
      remixCount: typeof project.remix_count === "number" ? project.remix_count : null,
      techStack: project.tech_stack || null,
      category: project.category || null,
      collections: []
    };

    existing.title = existing.title || title;
    existing.displayName = existing.displayName || project.display_name || null;
    existing.slug = existing.slug || project.name || null;
    existing.liveUrl = existing.liveUrl || project.url || null;
    existing.workspaceId = existing.workspaceId || project.workspace_id || null;
    existing.workspaceName = existing.workspaceName ||
      (project.workspace_id === currentWorkspaceId ? currentWorkspaceName : null);
    existing.visibility = existing.visibility || project.visibility || null;
    existing.publishVisibility = existing.publishVisibility || project.publish_visibility || null;
    existing.status = existing.status || project.status || null;
    existing.published = existing.published || Boolean(project.is_published);
    existing.starred = existing.starred || Boolean(project.is_starred);
    existing.accessLevel = existing.accessLevel || project.access_level || null;
    existing.ownerDisplayName = existing.ownerDisplayName || project.user_display_name || null;
    existing.createdAt = existing.createdAt || project.created_at || null;
    existing.updatedAt = existing.updatedAt || project.updated_at || null;
    existing.lastEditedAt = existing.lastEditedAt || project.last_edited_at || null;
    existing.lastViewedAt = existing.lastViewedAt || project.last_viewed_at || null;
    existing.editCount = existing.editCount ?? project.edit_count ?? null;
    existing.remixCount = existing.remixCount ?? project.remix_count ?? null;
    existing.techStack = existing.techStack || project.tech_stack || null;
    existing.category = existing.category || project.category || null;

    if (!existing.collections.includes(collectionKey)) {
      existing.collections.push(collectionKey);
      existing.collections.sort((left, right) => collectionOrder[left] - collectionOrder[right]);
    }

    merged.set(project.id, existing);
  };

  Object.entries(collections).forEach(([collectionKey, collection]) => {
    for (const project of collection.projects || []) {
      mergeProject(collectionKey, project);
    }
  });

  return Array.from(merged.values())
    .sort((left, right) => {
      const leftDate = Date.parse(left.lastEditedAt || left.lastViewedAt || left.updatedAt || left.createdAt || 0);
      const rightDate = Date.parse(right.lastEditedAt || right.lastViewedAt || right.updatedAt || right.createdAt || 0);
      return rightDate - leftDate;
    });
}

export async function getDashboardState(page, {
  dashboardUrl = new URL(DASHBOARD_PATH, DEFAULT_BASE_URL).toString(),
  timeoutMs = 20_000,
  pollMs = 250,
  pageSize = 100,
  includeLookup = false
} = {}) {
  const bootstrap = await captureDashboardBootstrap(page, {
    dashboardUrl,
    timeoutMs,
    pollMs
  });

  const workspaceState = await readDashboardWorkspaceState(page, {
    timeoutMs
  });

  const currentWorkspaceId = getWorkspaceIdFromDashboardUrl(
    bootstrap.captures.get("workspace")?.url
  );

  const collections = {
    workspace: await fetchAllDashboardProjects(bootstrap.captures.get("workspace"), {
      pageSize
    }),
    recent: await fetchAllDashboardProjects(bootstrap.captures.get("recent"), {
      pageSize
    }),
    shared: await fetchAllDashboardProjects(bootstrap.captures.get("shared"), {
      pageSize
    }),
    starred: await fetchAllDashboardProjects(bootstrap.captures.get("starred"), {
      pageSize
    })
  };

  const state = {
    dashboardUrl: bootstrap.dashboardUrl,
    currentWorkspace: {
      id: currentWorkspaceId,
      name: workspaceState.currentWorkspace.name,
      meta: workspaceState.currentWorkspace.meta
    },
    workspaces: workspaceState.workspaces,
    workspaceMenuActions: workspaceState.menuActions,
    collections: Object.fromEntries(
      Object.entries(collections).map(([key, value]) => [
        key,
        {
          total: value.total,
          count: value.projects.length,
          requestUrl: value.requestUrl
        }
      ])
    ),
    projects: mergeDashboardProjects({
      collections,
      baseUrl: new URL(dashboardUrl).origin,
      currentWorkspaceId,
      currentWorkspaceName: workspaceState.currentWorkspace.name
    })
  };

  if (includeLookup) {
    state.lookup = buildDashboardLookupFromCaptures(bootstrap.captures, {
      dashboardUrl
    });
  }

  return state;
}

function buildDashboardProjectState(project, {
  baseUrl = DEFAULT_BASE_URL,
  workspaceId = null,
  workspaceName = null,
  collectionKey = "workspace"
} = {}) {
  const collections = {
    workspace: { projects: [], total: 0 },
    recent: { projects: [], total: 0 },
    shared: { projects: [], total: 0 },
    starred: { projects: [], total: 0 }
  };
  collections[collectionKey] = {
    projects: [project],
    total: 1
  };

  return mergeDashboardProjects({
    collections,
    baseUrl,
    currentWorkspaceId: workspaceId,
    currentWorkspaceName: workspaceName
  })[0] || null;
}

function buildWorkspaceSearchSeed({
  origin,
  workspaceId,
  requestHeaders
}) {
  if (!origin || !workspaceId || !requestHeaders || Object.keys(requestHeaders).length === 0) {
    return null;
  }

  const requestUrl = new URL(`/workspaces/${workspaceId}/projects/search`, origin);
  requestUrl.searchParams.set("sort_by", "last_edited_at");

  return {
    key: "workspace",
    url: requestUrl.toString(),
    requestHeaders
  };
}

async function fetchDashboardProjectFromSeed(seed, {
  projectId,
  pageSize = 100,
  maxPages = 50,
  baseUrl = DEFAULT_BASE_URL,
  workspaceId = null,
  workspaceName = null
} = {}) {
  if (!seed?.url || !projectId) {
    return null;
  }

  const collection = await fetchAllDashboardProjects(seed, {
    pageSize,
    maxPages
  });
  const project = (collection.projects || []).find((entry) => entry?.id === projectId);
  if (!project) {
    return null;
  }

  return buildDashboardProjectState(project, {
    baseUrl,
    workspaceId,
    workspaceName,
    collectionKey: seed.key || "workspace"
  });
}

export async function getDashboardProjectState(page, {
  projectId,
  dashboardUrl = new URL(DASHBOARD_PATH, DEFAULT_BASE_URL).toString(),
  timeoutMs = 20_000,
  pollMs = 250,
  pageSize = 100
} = {}) {
  const dashboard = await getDashboardState(page, {
    dashboardUrl,
    timeoutMs,
    pollMs,
    pageSize,
    includeLookup: true
  });

  return {
    dashboard,
    lookup: dashboard.lookup || null,
    project: (dashboard.projects || []).find((entry) => entry.id === projectId) || null
  };
}

function parseDateValue(value) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function compareDashboardProjectState(baseline, current) {
  const baselineEditCount = Number.isFinite(baseline?.editCount) ? baseline.editCount : null;
  const currentEditCount = Number.isFinite(current?.editCount) ? current.editCount : null;
  const baselineLastEditedAt = parseDateValue(baseline?.lastEditedAt);
  const currentLastEditedAt = parseDateValue(current?.lastEditedAt);
  const baselineUpdatedAt = parseDateValue(baseline?.updatedAt);
  const currentUpdatedAt = parseDateValue(current?.updatedAt);

  const editCountIncreased = currentEditCount !== null && (
    baselineEditCount === null
      ? currentEditCount > 0
      : currentEditCount > baselineEditCount
  );
  const lastEditedAtAdvanced = currentLastEditedAt !== null && (
    baselineLastEditedAt === null
      ? true
      : currentLastEditedAt > baselineLastEditedAt
  );
  const updatedAtAdvanced = currentUpdatedAt !== null && (
    baselineUpdatedAt === null
      ? true
      : currentUpdatedAt > baselineUpdatedAt
  );

  return {
    changed: editCountIncreased || lastEditedAtAdvanced,
    editCountIncreased,
    lastEditedAtAdvanced,
    updatedAtAdvanced
  };
}

export async function pollDashboardProjectState(page, {
  projectId,
  baseline,
  lookup,
  timeoutMs = 180_000,
  initialPollMs = 3_000,
  maxPollMs = 20_000,
  pageSize = 100
} = {}) {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  const seedHeaders = lookup?.collectionSeeds?.workspace?.requestHeaders ||
    lookup?.collectionSeeds?.recent?.requestHeaders ||
    lookup?.collectionSeeds?.shared?.requestHeaders ||
    lookup?.collectionSeeds?.starred?.requestHeaders ||
    {};
  const baseUrl = lookup?.origin || DEFAULT_BASE_URL;
  const workspaceSeed = buildWorkspaceSearchSeed({
    origin: baseUrl,
    workspaceId: baseline?.workspaceId,
    requestHeaders: seedHeaders
  });
  const fallbackSeeds = [
    workspaceSeed,
    lookup?.collectionSeeds?.recent || null,
    lookup?.collectionSeeds?.shared || null,
    lookup?.collectionSeeds?.starred || null,
    lookup?.collectionSeeds?.workspace || null
  ].filter(Boolean);

  let lastProject = baseline || null;
  let intervalMs = initialPollMs;

  while (Date.now() <= deadline) {
    for (const seed of fallbackSeeds) {
      const project = await fetchDashboardProjectFromSeed(seed, {
        projectId,
        pageSize,
        baseUrl,
        workspaceId: baseline?.workspaceId || null,
        workspaceName: baseline?.workspaceName || null
      }).catch(() => null);

      if (!project) {
        continue;
      }

      lastProject = project;
      const comparison = compareDashboardProjectState(baseline, project);
      if (comparison.changed) {
        return {
          detected: true,
          final: project,
          comparison,
          durationMs: Date.now() - startTime
        };
      }

      break;
    }

    if (Date.now() >= deadline) {
      break;
    }

    await page.waitForTimeout(intervalMs);
    intervalMs = Math.min(maxPollMs, Math.round(intervalMs * 1.6));
  }

  return {
    detected: false,
    final: lastProject,
    comparison: compareDashboardProjectState(baseline, lastProject),
    durationMs: Date.now() - startTime
  };
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

function normalizePromptComparisonText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/^([>*#]+|\d+[.)]|[-*•])\s+/, ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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

export function classifyPublishSurface(text) {
  const normalized = String(text || "").trim();

  if (!normalized) {
    return "closed";
  }

  if (/Publishing\b/i.test(normalized)) {
    return "publishing";
  }

  // Lovable sometimes concatenates words without whitespace (e.g.
  // "PublishedLive URL" on the already-live wizard surface), so word-
  // boundary regexes like \bPublished\b fail because `d` + `L` is a
  // letter-to-letter transition. Use non-bounded matches for both
  // "Published" and "Live URL" so already-published projects resolve to
  // the published state and the loop breaks out with canUpdate.
  if (/Published/i.test(normalized) || /Live URL/i.test(normalized)) {
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
    const text = normalize(main.innerText || main.textContent || "");
    const lines = String(main.innerText || main.textContent || "")
      .split(/\n+/)
      .map(normalize)
      .filter(Boolean);

    return {
      liveUrl,
      buttons,
      links,
      suggestedDomains,
      text,
      lines
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

export async function readUrlTextSnapshot(context, {
  url,
  timeoutMs = 60_000,
  settleMs = 4_000
} = {}) {
  const page = await context.newPage();

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs
    });
    await page.waitForTimeout(settleMs);

    const snapshot = await page.evaluate(() => {
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      const bodyText = normalize(document.body?.innerText || "");

      return {
        title: document.title,
        bodyText,
        bodyTextLength: bodyText.length,
        htmlLength: document.documentElement?.outerHTML.length || 0
      };
    });

    return {
      status: response?.status() ?? null,
      finalUrl: page.url(),
      snapshot
    };
  } finally {
    await page.close().catch(() => {});
  }
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
  settleMs = 4_000,
  profileDir = null
}) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // When profileDir is provided, reuse the authenticated Lovable profile so
  // unpublished preview URLs (which require an active Lovable session) can be
  // captured instead of falling through to a login page. When profileDir is
  // null, keep the old clean-browser behavior so published public previews
  // still capture without an auth footprint.
  let browser = null;
  let context = null;
  if (profileDir) {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport,
      isMobile,
      hasTouch,
      deviceScaleFactor,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled"
      ]
    });
  } else {
    browser = await chromium.launch({
      headless,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled"
      ]
    });
    context = await browser.newContext({
      viewport,
      isMobile,
      hasTouch,
      deviceScaleFactor
    });
  }

  // When launchPersistentContext is used, a default page already exists —
  // reuse it to avoid duplicate blank pages that occasionally steal focus.
  const page = context.pages()[0] || await context.newPage();
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
    if (browser) {
      await browser.close();
    }
  }
}

export const LONG_PROMPT_MATCH_THRESHOLD = 600;
export const PROMPT_FINGERPRINT_LENGTH = 160;
export const PROMPT_FINGERPRINT_MIN_LENGTH = 40;

function normalizePromptComparisonTextForNode(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/^([>*#]+|\d+[.)]|[-*•])\s+/, ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns true when `haystack` contains `expected` verbatim, OR when `expected`
// is long enough that Lovable may truncate the rendered chat bubble and the
// prefix fingerprint still matches. Exported for unit testing.
export function matchExpectedPromptInHaystack(haystack, expected, {
  longThreshold = LONG_PROMPT_MATCH_THRESHOLD,
  fingerprintLength = PROMPT_FINGERPRINT_LENGTH,
  fingerprintMinLength = PROMPT_FINGERPRINT_MIN_LENGTH
} = {}) {
  const normalizedHaystack = normalizePromptComparisonTextForNode(haystack);
  const normalizedExpected = normalizePromptComparisonTextForNode(expected);
  if (!normalizedExpected) {
    return false;
  }
  if (normalizedHaystack.includes(normalizedExpected)) {
    return true;
  }
  if (normalizedExpected.length > longThreshold) {
    const fingerprint = normalizedExpected.slice(0, fingerprintLength);
    if (fingerprint.length >= fingerprintMinLength && normalizedHaystack.includes(fingerprint)) {
      return true;
    }
  }
  return false;
}

async function getPromptState(page, {
  prompt,
  attachmentNames = []
} = {}) {
  return page.evaluate((expectedPayload) => {
    const normalizePromptComparisonText = (value) => {
      return String(value || "")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.trim().replace(/^([>*#]+|\d+[.)]|[-*•])\s+/, ""))
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    };
    const readElementText = (element) => {
      if (!element) {
        return "";
      }

      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        return String(element.value || "");
      }

      return String(element.innerText ?? element.textContent ?? "");
    };
    const removeFirstOccurrence = (value, fragment) => {
      if (!fragment) {
        return String(value || "");
      }

      const source = String(value || "");
      const index = source.indexOf(fragment);
      if (index < 0) {
        return source;
      }

      return `${source.slice(0, index)} ${source.slice(index + fragment.length)}`;
    };

    const normalizedExpectedPrompt = normalizePromptComparisonText(expectedPayload?.prompt || "");
    const normalizedAttachmentNames = (expectedPayload?.attachmentNames || [])
      .map((value) => normalizePromptComparisonText(value))
      .filter(Boolean);
    const hasExpectedPrompt = normalizedExpectedPrompt.length > 0;
    const hasExpectedAttachments = normalizedAttachmentNames.length > 0;

    const bodyRawText = String(document.body?.innerText || document.body?.textContent || "");
    const input = document.querySelector('[aria-label="Chat input"]');
    const composer = document.querySelector("form#chat-input") || input?.closest("form") || input;
    const inputRawText = readElementText(input);
    const inputText = normalizePromptComparisonText(inputRawText);
    const composerRawText = readElementText(composer);
    const composerText = normalizePromptComparisonText(composerRawText);
    const bodyText = normalizePromptComparisonText(bodyRawText);
    const bodyWithoutComposer = normalizePromptComparisonText(
      removeFirstOccurrence(bodyRawText, composerRawText)
    );

    // Long prompts get collapsed/truncated in Lovable's rendered chat bubbles,
    // so a full verbatim includes() rarely matches for multi-thousand-char
    // prompts. Mirror the same hybrid logic as matchExpectedPromptInHaystack
    // in the node side of the codebase: verbatim includes() always, plus a
    // prefix-fingerprint fallback when the expected prompt exceeds the long
    // threshold. Keep constants in sync with src/browser.js exports.
    const longPromptThreshold = expectedPayload?.longPromptThreshold ?? 600;
    const fingerprintLength = expectedPayload?.fingerprintLength ?? 160;
    const fingerprintMinLength = expectedPayload?.fingerprintMinLength ?? 40;
    const expectedIsLong = normalizedExpectedPrompt.length > longPromptThreshold;
    const expectedFingerprint = hasExpectedPrompt
      ? normalizedExpectedPrompt.slice(0, fingerprintLength)
      : "";
    const fingerprintIsUsable = expectedIsLong && expectedFingerprint.length >= fingerprintMinLength;
    const matchExpected = (haystack) => {
      if (!hasExpectedPrompt) {
        return false;
      }
      if (haystack.includes(normalizedExpectedPrompt)) {
        return true;
      }
      if (fingerprintIsUsable && haystack.includes(expectedFingerprint)) {
        return true;
      }
      return false;
    };

    const hasPromptText = hasExpectedPrompt ? matchExpected(bodyText) : false;
    const hasPromptOutsideInput = hasExpectedPrompt ? matchExpected(bodyWithoutComposer) : false;
    const promptStillInInput = hasExpectedPrompt
      ? (inputText.includes(normalizedExpectedPrompt) ||
          (fingerprintIsUsable && inputText.includes(expectedFingerprint)))
      : false;
    const hasAttachmentsOutsideComposer = hasExpectedAttachments
      ? normalizedAttachmentNames.every((value) => bodyWithoutComposer.includes(value))
      : false;
    const attachmentsStillInComposer = hasExpectedAttachments
      ? normalizedAttachmentNames.some((value) => composerText.includes(value))
      : false;
    const hasExpectedPayloadOutsideComposer = (!hasExpectedPrompt || hasPromptOutsideInput) &&
      (!hasExpectedAttachments || hasAttachmentsOutsideComposer);
    const payloadStillInComposer = (hasExpectedPrompt && promptStillInInput) ||
      (hasExpectedAttachments && attachmentsStillInComposer);

    return {
      hasPromptText,
      hasPromptOutsideInput,
      promptStillInInput,
      hasAttachmentsOutsideComposer,
      attachmentsStillInComposer,
      hasExpectedPayloadOutsideComposer,
      payloadStillInComposer,
      needsVerification: bodyText.includes("Verification required"),
      isThinking: bodyText.includes("Thinking"),
      inputText,
      composerText,
      bodyText
    };
  }, {
    prompt,
    attachmentNames,
    longPromptThreshold: LONG_PROMPT_MATCH_THRESHOLD,
    fingerprintLength: PROMPT_FINGERPRINT_LENGTH,
    fingerprintMinLength: PROMPT_FINGERPRINT_MIN_LENGTH
  });
}

export async function waitForPromptResult(page, {
  prompt,
  attachmentNames = [],
  timeoutMs = 20_000,
  pollMs = 1_000
}) {
  const deadline = Date.now() + timeoutMs;
  const hasPrompt = normalizeText(prompt).length > 0;
  const hasAttachments = Array.isArray(attachmentNames) && attachmentNames.length > 0;

  while (Date.now() < deadline) {
    const state = await getPromptState(page, {
      prompt,
      attachmentNames
    });

    if (state.needsVerification) {
      return {
        ok: false,
        reason: "verification_required",
        state
      };
    }

    if (state.hasExpectedPayloadOutsideComposer && !state.payloadStillInComposer) {
      return {
        ok: true,
        reason: hasPrompt ? "prompt_visible" : hasAttachments ? "attachments_visible" : "payload_visible",
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
  attachmentNames = [],
  timeoutMs = 10 * 60 * 1000,
  pollMs = 1_000
}) {
  const hasPrompt = normalizeText(prompt).length > 0;
  const hasAttachments = Array.isArray(attachmentNames) && attachmentNames.length > 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await getPromptState(page, {
      prompt,
      attachmentNames
    });

    if (!state.needsVerification && !state.payloadStillInComposer) {
      return {
        ok: true,
        reason: state.hasExpectedPayloadOutsideComposer
          ? hasPrompt ? "prompt_visible" : hasAttachments ? "attachments_visible" : "payload_visible"
          : "input_cleared",
        state
      };
    }

    await page.waitForTimeout(pollMs);
  }

  return {
    ok: false,
    reason: "verification_timeout",
    state: await getPromptState(page, {
      prompt,
      attachmentNames
    })
  };
}

export async function confirmPromptPersistsAfterReload(page, {
  prompt,
  attachmentNames = [],
  timeoutMs = 20_000,
  settleMs = 6_000,
  pollMs = 1_000
}) {
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForTimeout(settleMs);

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await getPromptState(page, {
      prompt,
      attachmentNames
    });

    if (state.needsVerification) {
      return {
        ok: false,
        reason: "verification_required",
        state
      };
    }

    if (state.hasExpectedPayloadOutsideComposer && !state.payloadStillInComposer) {
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

  // Helper: fall back to dashboard project record when the wizard surface
  // doesn't expose the live URL (it sometimes lives only inside a copy
  // button). Uses a sibling tab so we don't navigate the project page away.
  const resolveLiveUrlFallback = async (currentLiveUrl) => {
    if (currentLiveUrl || !projectId) {
      return currentLiveUrl;
    }
    let dashPage = null;
    try {
      dashPage = await page.context().newPage();
      const dashState = await getDashboardProjectState(dashPage, { projectId });
      const dashLiveUrl = dashState?.project?.liveUrl || null;
      if (dashLiveUrl) {
        return normalizePublishUrl(dashLiveUrl) || dashLiveUrl;
      }
      return currentLiveUrl;
    } catch {
      return currentLiveUrl;
    } finally {
      if (dashPage) {
        await dashPage.close().catch(() => {});
      }
    }
  };

  if (state.step === "published" && !state.canUpdate) {
    const alreadyLiveUrl = await resolveLiveUrlFallback(state.liveUrl);
    const liveCheck = alreadyLiveUrl
      ? await probeUrlStatus(alreadyLiveUrl)
      : null;

    return {
      ok: true,
      alreadyPublished: true,
      liveUrl: alreadyLiveUrl,
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
    const alreadyLiveUrl = await resolveLiveUrlFallback(state.liveUrl);
    return {
      ok: true,
      alreadyPublished: true,
      liveUrl: alreadyLiveUrl,
      liveCheck: alreadyLiveUrl ? await probeUrlStatus(alreadyLiveUrl) : null,
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

    let intendedLiveUrl = state?.liveUrl ||
      [...stepHistory].reverse().map((entry) => entry.liveUrl).find(Boolean) ||
      null;

    // The wizard surface sometimes hides the live URL behind a copy
    // button; fall back to the dashboard project record via a sibling
    // tab using the shared helper.
    intendedLiveUrl = await resolveLiveUrlFallback(intendedLiveUrl);

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
  const customDomains = Array.from(
    new Set(
      [...(snapshot.lines || []), ...(snapshot.links || []).map((entry) => entry.text || entry.href)]
        .flatMap((value) => {
          return String(value || "").match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi) || [];
        })
        .map((value) => value.toLowerCase())
    )
  )
    .filter((domain) => domain !== liveHost)
    .filter((domain) => !/lovable\.dev$/i.test(domain))
    .filter((domain) => !/lovable\.app$/i.test(domain));

  return {
    projectUrl,
    settingsUrl,
    liveUrl,
    subdomain: liveHost ? liveHost.split(".")[0] : null,
    text: snapshot.text,
    lines: snapshot.lines,
    buttons: snapshot.buttons,
    links: snapshot.links,
    editUrlAvailable: snapshot.buttons.some((button) => /^Edit URL$/i.test(button.text)),
    connectExistingDomainAvailable: snapshot.buttons.some((button) => /^Connect domain$/i.test(button.text)),
    suggestedPurchaseDomains,
    customDomains
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

function getProjectSettingsUrl(projectUrl, section = "") {
  const projectId = projectIdFromUrl(projectUrl);
  if (!projectId) {
    throw new Error("Expected a Lovable project URL.");
  }

  const url = new URL(projectUrl);
  url.pathname = section
    ? `/projects/${projectId}/settings/${section}`
    : `/projects/${projectId}/settings`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeProjectSettingsVisibility(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("Project visibility cannot be empty.");
  }

  if (["public", "anyone"].includes(normalized)) {
    return "Public";
  }

  if (["workspace", "members"].includes(normalized)) {
    return "Workspace";
  }

  if (["restrictedbusiness", "restricted-business", "restricted_business", "business"].includes(normalized)) {
    return "RestrictedBusiness";
  }

  throw new Error(`Unsupported project visibility "${value}". Use one of: public, workspace, restricted-business.`);
}

function normalizeProjectSettingsCategory(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("Project category cannot be empty.");
  }

  const mappings = new Map([
    ["internal tools", "Internal Tools"],
    ["internal-tools", "Internal Tools"],
    ["website", "Website"],
    ["personal", "Personal"],
    ["consumer app", "Consumer App"],
    ["consumer-app", "Consumer App"],
    ["b2b app", "B2B App"],
    ["b2b-app", "B2B App"],
    ["prototype", "Prototype"]
  ]);

  const matched = mappings.get(normalized);
  if (!matched) {
    throw new Error(`Unsupported project category "${value}". Use one of: Internal Tools, Website, Personal, Consumer App, B2B App, Prototype.`);
  }

  return matched;
}

function normalizeWorkspaceSection(section = "all") {
  const normalized = String(section || "all").trim().toLowerCase();
  const mappings = new Map([
    ["all", "all"],
    ["workspace", "workspace"],
    ["people", "people"],
    ["plans-credits", "billing"],
    ["plans", "billing"],
    ["billing", "billing"],
    ["cloud-ai-balance", "usage"],
    ["cloud-ai", "usage"],
    ["usage", "usage"],
    ["workspace-domains", "workspace-domains"],
    ["privacy-security", "privacy-security"],
    ["privacy", "privacy-security"],
    ["account", "account"]
  ]);

  const matched = mappings.get(normalized);
  if (!matched) {
    throw new Error(
      `Unsupported workspace section "${section}". Use one of: all, workspace, people, plans-credits, cloud-ai-balance, workspace-domains, privacy-security, account.`
    );
  }

  return matched;
}

function normalizeGitProvider(value = "github") {
  const normalized = String(value || "github").trim().toLowerCase();
  if (!["github", "gitlab"].includes(normalized)) {
    throw new Error(`Unsupported git provider "${value}". Use one of: github, gitlab.`);
  }
  return normalized;
}

async function gotoProjectSettings(page, projectUrl, section = "", {
  timeoutMs = 120_000
} = {}) {
  const settingsUrl = getProjectSettingsUrl(projectUrl, section);
  await page.goto(settingsUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs
  });
  return settingsUrl;
}

async function waitForSettingsMain(page, {
  timeoutMs = 20_000,
  headingPattern
} = {}) {
  const main = page.locator("main[aria-label='Settings content'], main").first();
  await main.waitFor({
    state: "visible",
    timeout: timeoutMs
  });

  if (headingPattern) {
    await page.getByText(headingPattern, {
      exact: false
    }).first().waitFor({
      state: "visible",
      timeout: timeoutMs
    }).catch(() => {});
  }

  return main;
}

async function readSettingsPageSnapshotFromPage(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const main = document.querySelector("main[aria-label='Settings content']") || document.querySelector("main");
    if (!(main instanceof HTMLElement)) {
      return null;
    }

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

    const dedupeByKey = (items, keyFn) => {
      const seen = new Set();
      return items.filter((item) => {
        const key = keyFn(item);
        if (!key || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    };

    const getLabelForControl = (element) => {
      if (!(element instanceof HTMLElement)) {
        return "";
      }

      const ariaLabel = normalize(element.getAttribute("aria-label") || "");
      if (ariaLabel) {
        return ariaLabel;
      }

      const id = element.getAttribute("id");
      if (id) {
        const explicit = main.querySelector(`label[for="${id}"]`);
        const explicitText = normalize(explicit?.textContent || "");
        if (explicitText) {
          return explicitText;
        }
      }

      for (let current = element.parentElement; current && current !== main; current = current.parentElement) {
        const candidates = Array.from(current.querySelectorAll("h1,h2,h3,h4,label,p,span,strong"))
          .filter((candidate) => candidate instanceof HTMLElement && isRendered(candidate))
          .map((candidate) => normalize(candidate.textContent || ""))
          .filter((value) => value && value.length <= 120);

        const matched = candidates.find((value) => {
          return !/^(Docs|Close|Cancel|Save|Update|Delete|Transfer|Rename|Remix)$/i.test(value);
        });

        if (matched) {
          return matched;
        }
      }

      return "";
    };

    const headings = dedupeByKey(
      Array.from(main.querySelectorAll("h1,h2,h3,h4"))
        .filter((element) => element instanceof HTMLElement && isRendered(element))
        .map((element) => normalize(element.textContent || ""))
        .filter(Boolean),
      (value) => value
    );

    const text = normalize(main.innerText || main.textContent || "");
    const lines = String(main.innerText || main.textContent || "")
      .split(/\n+/)
      .map((value) => normalize(value))
      .filter(Boolean);

    const buttons = dedupeByKey(
      Array.from(main.querySelectorAll("button,[role='button'],a[role='button']"))
        .filter((element) => element instanceof HTMLElement && isRendered(element))
        .map((element) => ({
          text: normalize(element.textContent || ""),
          ariaLabel: normalize(element.getAttribute("aria-label") || ""),
          title: normalize(element.getAttribute("title") || ""),
          disabled: element.matches("[disabled],[aria-disabled='true'],[data-disabled='true']")
        }))
        .filter((entry) => entry.text || entry.ariaLabel || entry.title),
      (entry) => `${entry.text}|${entry.ariaLabel}|${entry.title}|${entry.disabled ? "disabled" : "enabled"}`
    );

    const links = dedupeByKey(
      Array.from(main.querySelectorAll("a"))
        .filter((element) => element instanceof HTMLElement && isRendered(element))
        .map((element) => ({
          text: normalize(element.textContent || ""),
          href: element.getAttribute("href") || ""
        }))
        .filter((entry) => entry.text || entry.href),
      (entry) => `${entry.text}|${entry.href}`
    );

    const comboboxes = dedupeByKey(
      Array.from(main.querySelectorAll("[role='combobox'],button[aria-haspopup='listbox']"))
        .filter((element) => element instanceof HTMLElement && isRendered(element))
        .map((element) => ({
          label: getLabelForControl(element),
          text: normalize(element.textContent || ""),
          expanded: element.getAttribute("aria-expanded") === "true"
        }))
        .filter((entry) => entry.text || entry.label),
      (entry) => `${entry.label}|${entry.text}`
    );

    const switches = Array.from(main.querySelectorAll("[role='switch'],input[type='checkbox']"))
      .filter((element) => element instanceof HTMLElement && isRendered(element))
      .map((element) => {
        const checked = element.getAttribute("aria-checked") === "true" ||
          element.getAttribute("data-state") === "checked" ||
          ("checked" in element && Boolean(element.checked));

        return {
          label: getLabelForControl(element),
          checked,
          disabled: element.matches("[disabled],[aria-disabled='true'],[data-disabled='true']")
        };
      });

    const textareas = Array.from(main.querySelectorAll("textarea"))
      .filter((element) => element instanceof HTMLElement && isRendered(element))
      .map((element) => ({
        label: getLabelForControl(element),
        placeholder: normalize(element.getAttribute("placeholder") || ""),
        value: "value" in element ? element.value : ""
      }));

    const inputs = Array.from(main.querySelectorAll("input:not([type='hidden']):not([type='checkbox']):not([type='radio'])"))
      .filter((element) => element instanceof HTMLElement && isRendered(element))
      .map((element) => ({
        label: getLabelForControl(element),
        type: element.getAttribute("type") || "text",
        name: element.getAttribute("name") || "",
        placeholder: normalize(element.getAttribute("placeholder") || ""),
        value: "value" in element ? element.value : ""
      }));

    const rows = Array.from(main.querySelectorAll("tr"))
      .filter((element) => element instanceof HTMLElement && isRendered(element))
      .map((row) => {
        return Array.from(row.querySelectorAll("th,td"))
          .map((cell) => normalize(cell.textContent || ""))
          .filter(Boolean);
      })
      .filter((row) => row.length > 0);

    return {
      headings,
      text,
      lines,
      buttons,
      links,
      comboboxes,
      switches,
      textareas,
      inputs,
      rows
    };
  });
}

async function readToolbarSnapshotFromPage(page) {
  return page.locator("button,[role='button'],a[role='button'],a").evaluateAll((elements) => {
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
        Number(style.opacity || "1") > 0 &&
        rect.top >= 0 &&
        rect.top <= 120;
    };

    return elements
      .map((element, domIndex) => {
        if (!(element instanceof HTMLElement) || !isRendered(element)) {
          return null;
        }

        const rect = element.getBoundingClientRect();
        const text = normalize(element.textContent || "");
        const ariaLabel = normalize(element.getAttribute("aria-label") || "");
        const title = normalize(element.getAttribute("title") || "");
        const label = text || ariaLabel || title;
        if (!label) {
          return null;
        }

        return {
          domIndex,
          label,
          text,
          ariaLabel,
          title,
          tagName: element.tagName.toLowerCase(),
          disabled: element.matches("[disabled],[aria-disabled='true'],[data-disabled='true']"),
          menuCandidate: Boolean(
            element.getAttribute("aria-haspopup") ||
            /\.\.\.|more|share|github|switch project|settings|menu/i.test(label)
          ),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        if (left.y !== right.y) {
          return left.y - right.y;
        }
        return left.x - right.x;
      });
  });
}

async function readVisibleMenuSurfaceSnapshots(page) {
  return page.evaluate(() => {
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

    return Array.from(document.querySelectorAll("[role='menu'],[role='dialog'],[role='alertdialog']"))
      .filter((element) => element instanceof HTMLElement && isRendered(element))
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const buttons = Array.from(element.querySelectorAll("button,[role='button'],a[role='button']"))
          .filter((candidate) => candidate instanceof HTMLElement && isRendered(candidate))
          .map((candidate) => normalize(candidate.textContent || candidate.getAttribute("aria-label") || ""))
          .filter(Boolean);
        const links = Array.from(element.querySelectorAll("a"))
          .filter((candidate) => candidate instanceof HTMLElement && isRendered(candidate))
          .map((candidate) => ({
            text: normalize(candidate.textContent || ""),
            href: candidate.getAttribute("href") || ""
          }))
          .filter((entry) => entry.text || entry.href);
        const text = normalize(element.innerText || element.textContent || "");
        const lines = String(element.innerText || element.textContent || "")
          .split(/\n+/)
          .map((value) => normalize(value))
          .filter(Boolean);

        return {
          index,
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          text,
          lines,
          buttons,
          links
        };
      })
      .sort((left, right) => {
        if (left.top !== right.top) {
          return left.top - right.top;
        }
        return left.left - right.left;
      });
  });
}

function getMenuSurfaceSignature(surface) {
  return `${surface.top}|${surface.left}|${surface.width}|${surface.height}|${surface.text.slice(0, 160)}`;
}

async function openToolbarMenu(page, buttonDescriptor, {
  timeoutMs = 10_000,
  settleMs = 500
} = {}) {
  const beforeSurfaces = await readVisibleMenuSurfaceSnapshots(page);
  const beforeSignatures = new Set(beforeSurfaces.map((surface) => getMenuSurfaceSignature(surface)));
  const locator = page.locator("button,[role='button'],a[role='button'],a").nth(buttonDescriptor.domIndex);

  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: timeoutMs }).catch(async () => {
    await locator.click({ timeout: Math.min(timeoutMs, 5_000), force: true }).catch(async () => {
      await locator.evaluate((element) => element.click());
    });
  });

  const deadline = Date.now() + timeoutMs;
  let lastSurfaces = beforeSurfaces;

  while (Date.now() < deadline) {
    await page.waitForTimeout(settleMs);
    lastSurfaces = await readVisibleMenuSurfaceSnapshots(page);
    const newSurface = lastSurfaces.find((surface) => !beforeSignatures.has(getMenuSurfaceSignature(surface)));
    if (newSurface) {
      return {
        opened: true,
        surface: newSurface
      };
    }
  }

  const fallbackSurface = [...lastSurfaces].reverse().find((surface) => {
    return !beforeSignatures.has(getMenuSurfaceSignature(surface)) ||
      surface.top <= 180;
  }) || null;

  return {
    opened: Boolean(fallbackSurface),
    surface: fallbackSurface
  };
}

async function closeToolbarMenu(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}

async function getProjectSettingsComboboxLocators(page) {
  const main = page.locator("main[aria-label='Settings content'], main").first();
  const comboboxes = main.locator("[role='combobox'],button[aria-haspopup='listbox']");
  const count = await comboboxes.count();
  const results = [];

  for (let index = 0; index < count; index += 1) {
    const locator = comboboxes.nth(index);
    if (await locator.isVisible().catch(() => false)) {
      results.push(locator);
    }
  }

  const fallbackPatterns = [
    /^Workspace$|^Public$|^RestrictedBusiness$/i,
    /^Select category$|^Internal Tools$|^Website$|^Personal$|^Consumer App$|^B2B App$|^Prototype$/i
  ];

  for (const pattern of fallbackPatterns) {
    const fallback = main.locator("button,[role='button'],[role='combobox']").filter({
      hasText: pattern
    }).first();
    if (!(await fallback.isVisible().catch(() => false))) {
      continue;
    }

    const fallbackText = normalizeText(await fallback.textContent().catch(() => ""));
    const alreadyPresent = await Promise.all(results.map(async (locator) => {
      const text = normalizeText(await locator.textContent().catch(() => ""));
      return text === fallbackText;
    }));

    if (!alreadyPresent.some(Boolean)) {
      results.push(fallback);
    }
  }

  return results;
}

async function readProjectSettingsOptionsFromCombobox(page, locator, {
  timeoutMs = 15_000
} = {}) {
  await locator.click({ timeout: timeoutMs });
  await page.waitForTimeout(250);

  const options = await page.evaluate(() => {
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

    const optionElements = Array.from(document.querySelectorAll("[role='option'],[role='menuitemradio'],[cmdk-item],button"))
      .filter((element) => element instanceof HTMLElement && isRendered(element))
      .map((element) => {
        const label = normalize(element.textContent || element.getAttribute("aria-label") || "");
        if (!label) {
          return null;
        }

        return {
          label,
          disabled: element.matches("[disabled],[aria-disabled='true'],[data-disabled='true']"),
          selected: element.getAttribute("aria-checked") === "true" ||
            element.getAttribute("data-state") === "checked"
        };
      })
      .filter(Boolean);

    return Array.from(
      new Map(optionElements.map((option) => [option.label.toLowerCase(), option])).values()
    );
  });

  await closeToolbarMenu(page);
  return options;
}

async function chooseProjectSettingsComboboxOption(page, locator, label, {
  timeoutMs = 15_000
} = {}) {
  if (typeof locator === "string") {
    const deadline = Date.now() + timeoutMs;
    let clicked = false;

    while (Date.now() < deadline) {
      clicked = await page.evaluate((targetLabel) => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const main = document.querySelector("main[aria-label='Settings content']") || document.querySelector("main");
        if (!(main instanceof HTMLElement)) {
          return false;
        }

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

        const candidates = Array.from(main.querySelectorAll("[role='combobox'],button,[role='button']"))
          .filter((element) => element instanceof HTMLElement && isRendered(element))
          .filter((element) => normalize(element.textContent || "") === targetLabel);

        const candidate = candidates[0];
        if (!(candidate instanceof HTMLElement)) {
          return false;
        }

        candidate.click();
        return true;
      }, locator);

      if (clicked) {
        break;
      }

      await page.waitForTimeout(250);
    }

    if (!clicked) {
      throw new Error(`Lovable project settings page did not expose the "${locator}" control.`);
    }
  } else {
    await locator.click({ timeout: timeoutMs });
  }
  await page.waitForTimeout(250);

  const escapedLabel = escapeRegExp(label);
  const optionMatchers = [
    page.getByRole("option", { name: new RegExp(`^${escapedLabel}$`, "i") }).first(),
    page.getByRole("menuitemradio", { name: new RegExp(`^${escapedLabel}$`, "i") }).first(),
    page.locator("[cmdk-item],button,[role='option'],[role='menuitemradio']").filter({
      hasText: new RegExp(`^${escapedLabel}$`, "i")
    }).first()
  ];

  for (const option of optionMatchers) {
    if (await option.isVisible().catch(() => false)) {
      await option.click({ timeout: timeoutMs }).catch(async () => {
        await option.click({ timeout: Math.min(timeoutMs, 5_000), force: true }).catch(async () => {
          await option.evaluate((element) => element.click());
        });
      });
      await page.waitForTimeout(500);
      return true;
    }
  }

  await closeToolbarMenu(page);
  throw new Error(`Lovable did not expose a "${label}" option in the current settings combobox.`);
}

async function waitForKnowledgeTextareas(page, {
  timeoutMs = 20_000,
  requireWorkspace = false
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let count = 0;

  while (Date.now() < deadline) {
    count = await page.locator("main textarea").count().catch(() => 0);
    if (count >= (requireWorkspace ? 2 : 1)) {
      return count;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    requireWorkspace
      ? "Lovable knowledge settings did not expose both project and workspace textareas."
      : "Lovable knowledge settings did not expose the project knowledge textarea."
  );
}

function getLineAfter(lines, headingPattern) {
  const index = lines.findIndex((line) => headingPattern.test(line));
  if (index === -1) {
    return null;
  }

  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const value = lines[cursor];
    if (!value) {
      continue;
    }
    return value;
  }

  return null;
}

function parseRepositorySlugFromLines(lines) {
  for (const line of lines) {
    const match = line.match(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/);
    if (match) {
      return match[0];
    }
  }

  return null;
}

async function clickSettingsButton(page, labelPattern, {
  timeoutMs = 15_000
} = {}) {
  const main = page.locator("main[aria-label='Settings content'], main").first();
  const button = main.getByRole("button", {
    name: labelPattern
  }).first();
  await button.waitFor({
    state: "visible",
    timeout: timeoutMs
  });
  await button.click({ timeout: timeoutMs });
  return button;
}

export async function getProjectToolbarState(page, {
  projectUrl = page.url(),
  menus = [],
  timeoutMs = 20_000
} = {}) {
  await page.goto(projectUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs
  });

  await page.waitForLoadState("networkidle", {
    timeout: 5_000
  }).catch(() => {});

  const buttons = await readToolbarSnapshotFromPage(page);
  const normalizedRequestedMenus = menus.map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
  const requestedButtons = normalizedRequestedMenus.length > 0
    ? buttons.filter((button) => {
      const label = normalizeText(button.label).toLowerCase();
      return normalizedRequestedMenus.some((requested) => label === requested || label.includes(requested));
    })
    : buttons.filter((button) => button.menuCandidate);

  const openedMenus = [];
  for (const button of requestedButtons) {
    const result = await openToolbarMenu(page, button, {
      timeoutMs: Math.min(timeoutMs, 10_000)
    });
    openedMenus.push({
      button,
      opened: result.opened,
      surface: result.surface || null
    });
    await closeToolbarMenu(page);
  }

  return {
    projectUrl,
    buttons,
    openedMenus
  };
}

export async function getProjectSettingsState(page, {
  projectUrl = page.url(),
  timeoutMs = 60_000
} = {}) {
  const settingsUrl = await gotoProjectSettings(page, projectUrl, "", {
    timeoutMs
  });
  await waitForSettingsMain(page, {
    timeoutMs: Math.min(timeoutMs, 20_000),
    headingPattern: /Project settings/i
  });
  await page.waitForLoadState("networkidle", {
    timeout: 5_000
  }).catch(() => {});
  await page.waitForTimeout(1_000);

  let snapshot = await readSettingsPageSnapshotFromPage(page);
  if (!snapshot?.text && !snapshot?.lines?.length) {
    await page.waitForTimeout(1_500);
    snapshot = await readSettingsPageSnapshotFromPage(page);
  }
  if (!snapshot) {
    throw new Error("Lovable project settings page did not render.");
  }

  const comboboxLocators = await getProjectSettingsComboboxLocators(page);
  const visibilityOptions = comboboxLocators[0]
    ? await readProjectSettingsOptionsFromCombobox(page, comboboxLocators[0], {
      timeoutMs: Math.min(timeoutMs, 15_000)
    }).catch(() => [])
    : [];
  const categoryOptions = comboboxLocators[1]
    ? await readProjectSettingsOptionsFromCombobox(page, comboboxLocators[1], {
      timeoutMs: Math.min(timeoutMs, 15_000)
    }).catch(() => [])
    : [];

  const switches = snapshot.switches || [];
  const visibilityLabelAllowList = new Set(["Public", "Workspace", "RestrictedBusiness"]);
  const categoryLabelAllowList = new Set([
    "Internal Tools",
    "Website",
    "Personal",
    "Consumer App",
    "B2B App",
    "Prototype"
  ]);

  return {
    projectUrl,
    settingsUrl,
    title: snapshot.headings[0] || "Project settings",
    projectName: getLineAfter(snapshot.lines, /^Project name$/i),
    urlSubdomain: getLineAfter(snapshot.lines, /^URL subdomain$/i),
    owner: getLineAfter(snapshot.lines, /^Owner$/i),
    createdAt: getLineAfter(snapshot.lines, /^Created at$/i),
    techStack: getLineAfter(snapshot.lines, /^Tech stack$/i),
    messagesCount: getLineAfter(snapshot.lines, /^Messages count$/i),
    aiEditsCount: getLineAfter(snapshot.lines, /^AI edits count$/i),
    visibility: {
      current: snapshot.comboboxes[0]?.text || null,
      label: snapshot.comboboxes[0]?.label || "Project visibility",
      options: visibilityOptions.filter((option) => visibilityLabelAllowList.has(option.label))
    },
    category: {
      current: snapshot.comboboxes[1]?.text || null,
      label: snapshot.comboboxes[1]?.label || "Project category",
      options: categoryOptions.filter((option) => categoryLabelAllowList.has(option.label))
    },
    hideLovableBadge: {
      checked: switches[0]?.checked ?? null,
      label: "Hide Lovable badge"
    },
    disableAnalytics: {
      checked: switches[1]?.checked ?? null,
      label: "Disable analytics"
    },
    crossProjectSharing: {
      checked: switches[2]?.checked ?? null,
      label: "Cross-project sharing"
    },
    availableActions: snapshot.buttons.map((button) => button.text || button.ariaLabel).filter(Boolean),
    lines: snapshot.lines,
    text: snapshot.text
  };
}

export async function updateProjectSettings(page, {
  projectUrl = page.url(),
  visibility,
  category,
  hideLovableBadge,
  disableAnalytics,
  rename,
  timeoutMs = 60_000
} = {}) {
  const initialState = await getProjectSettingsState(page, {
    projectUrl,
    timeoutMs
  });

  await gotoProjectSettings(page, projectUrl, "", {
    timeoutMs
  });
  await waitForSettingsMain(page, {
    timeoutMs: Math.min(timeoutMs, 20_000),
    headingPattern: /Project settings/i
  });

  const changes = [];
  const comboboxes = await getProjectSettingsComboboxLocators(page);
  const main = page.locator("main[aria-label='Settings content'], main").first();
  const directComboboxes = main.locator("[role='combobox']");
  const directComboboxCount = await directComboboxes.count().catch(() => 0);
  const visibleDirectComboboxes = [];
  const directComboboxTexts = [];
  for (let index = 0; index < directComboboxCount; index += 1) {
    const locator = directComboboxes.nth(index);
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }
    visibleDirectComboboxes.push(locator);
    directComboboxTexts.push(
      normalizeText(await locator.textContent().catch(() => ""))
    );
  }

  if (visibility !== undefined) {
    const targetVisibility = normalizeProjectSettingsVisibility(visibility);
    if (normalizeText(initialState.visibility.current).toLowerCase() !== targetVisibility.toLowerCase()) {
      const directVisibilityIndex = directComboboxTexts.findIndex((text) => {
        return text.toLowerCase() === normalizeText(initialState.visibility.current || "Workspace").toLowerCase();
      });
      const visibilityTrigger = directVisibilityIndex >= 0
        ? visibleDirectComboboxes[directVisibilityIndex]
        : visibleDirectComboboxes.length > 0
          ? visibleDirectComboboxes[0]
          : comboboxes[0] || main.getByText(
        new RegExp(`^${escapeRegExp(initialState.visibility.current || "Workspace")}$`, "i")
      ).first();
      await chooseProjectSettingsComboboxOption(page, visibilityTrigger, targetVisibility, {
        timeoutMs: Math.min(timeoutMs, 15_000)
      });
      changes.push(`visibility=${targetVisibility}`);
    }
  }

  if (category !== undefined) {
    const targetCategory = normalizeProjectSettingsCategory(category);
    if (normalizeText(initialState.category.current).toLowerCase() !== targetCategory.toLowerCase()) {
      const currentCategoryLabel = initialState.category.current || "Select category";
      const directCategoryIndex = directComboboxTexts.findIndex((text) => {
        return text.toLowerCase() === normalizeText(currentCategoryLabel).toLowerCase();
      });
      const categoryTrigger = directCategoryIndex >= 0
        ? visibleDirectComboboxes[directCategoryIndex]
        : visibleDirectComboboxes.length > 1
          ? visibleDirectComboboxes[1]
          : comboboxes[1] || currentCategoryLabel;
      await chooseProjectSettingsComboboxOption(page, categoryTrigger, targetCategory, {
        timeoutMs: Math.min(timeoutMs, 15_000)
      });
      changes.push(`category=${targetCategory}`);
    }
  }

  const visibleSwitches = page.locator("main [role='switch'], main input[type='checkbox']");
  const switchCount = await visibleSwitches.count().catch(() => 0);
  const setSwitch = async (index, desired, label) => {
    if (desired === undefined) {
      return;
    }

    if (index >= switchCount) {
      throw new Error(`Lovable project settings page did not expose the ${label} switch.`);
    }

    const locator = visibleSwitches.nth(index);
    const current = await locator.evaluate((element) => {
      return element.getAttribute("aria-checked") === "true" ||
        element.getAttribute("data-state") === "checked" ||
        ("checked" in element && Boolean(element.checked));
    });
    if (current !== desired) {
      await locator.click({ timeout: Math.min(timeoutMs, 15_000) });
      await page.waitForTimeout(500);
      changes.push(`${label}=${desired ? "on" : "off"}`);
    }
  };

  await setSwitch(0, hideLovableBadge, "hideLovableBadge");
  await setSwitch(1, disableAnalytics, "disableAnalytics");

  if (rename !== undefined) {
    const normalizedRename = String(rename).trim();
    if (!normalizedRename) {
      throw new Error("Rename value cannot be empty.");
    }

    if (normalizeText(initialState.projectName).toLowerCase() !== normalizedRename.toLowerCase()) {
      await clickSettingsButton(page, /^Rename$/i, {
        timeoutMs: Math.min(timeoutMs, 15_000)
      });
      const dialog = page.locator("[role='dialog'],[role='alertdialog']").filter({
        hasText: /Rename project/i
      }).last();
      await dialog.waitFor({
        state: "visible",
        timeout: Math.min(timeoutMs, 15_000)
      });
      const input = dialog.locator("input[name='displayName']").first();
      await input.waitFor({
        state: "visible",
        timeout: Math.min(timeoutMs, 15_000)
      });
      await input.fill(normalizedRename);
      const saveButton = dialog.getByRole("button", {
        name: /^Save$/i
      }).first();
      await saveButton.click({
        timeout: Math.min(timeoutMs, 15_000)
      });
      await dialog.waitFor({
        state: "hidden",
        timeout: Math.min(timeoutMs, 20_000)
      }).catch(() => {});
      changes.push(`rename=${normalizedRename}`);
    }
  }

  await page.waitForLoadState("networkidle", {
    timeout: 5_000
  }).catch(() => {});
  await page.waitForTimeout(1_000);

  const state = await getProjectSettingsState(page, {
    projectUrl,
    timeoutMs
  });

  return {
    ok: true,
    changes,
    initialState,
    state
  };
}

export async function getProjectKnowledgeState(page, {
  projectUrl = page.url(),
  timeoutMs = 60_000
} = {}) {
  const settingsUrl = await gotoProjectSettings(page, projectUrl, "knowledge", {
    timeoutMs
  });
  await waitForSettingsMain(page, {
    timeoutMs: Math.min(timeoutMs, 20_000),
    headingPattern: /Knowledge/i
  });
  await waitForKnowledgeTextareas(page, {
    timeoutMs: Math.min(timeoutMs, 20_000),
    requireWorkspace: false
  });

  const snapshot = await readSettingsPageSnapshotFromPage(page);
  if (!snapshot) {
    throw new Error("Lovable knowledge settings page did not render.");
  }

  return {
    projectUrl,
    settingsUrl,
    title: snapshot.headings[0] || "Knowledge",
    projectKnowledge: snapshot.textareas[0]?.value || "",
    projectPlaceholder: snapshot.textareas[0]?.placeholder || "",
    workspaceKnowledge: snapshot.textareas[1]?.value || "",
    workspacePlaceholder: snapshot.textareas[1]?.placeholder || "",
    availableActions: snapshot.buttons.map((button) => button.text || button.ariaLabel).filter(Boolean),
    lines: snapshot.lines,
    text: snapshot.text
  };
}

export async function updateProjectKnowledge(page, {
  projectUrl = page.url(),
  projectText,
  workspaceText,
  timeoutMs = 60_000
} = {}) {
  const initialState = await getProjectKnowledgeState(page, {
    projectUrl,
    timeoutMs
  });

  await gotoProjectSettings(page, projectUrl, "knowledge", {
    timeoutMs
  });
  await waitForSettingsMain(page, {
    timeoutMs: Math.min(timeoutMs, 20_000),
    headingPattern: /Knowledge/i
  });
  await waitForKnowledgeTextareas(page, {
    timeoutMs: Math.min(timeoutMs, 20_000),
    requireWorkspace: workspaceText !== undefined
  });

  const textareas = page.locator("main textarea");
  const changes = [];

  if (projectText !== undefined) {
    const normalizedProjectText = String(projectText);
    if (initialState.projectKnowledge !== normalizedProjectText) {
      await textareas.nth(0).fill(normalizedProjectText);
      changes.push("projectKnowledge");
    }
  }

  if (workspaceText !== undefined) {
    const normalizedWorkspaceText = String(workspaceText);
    if (await textareas.count().catch(() => 0) < 2) {
      throw new Error("Lovable knowledge settings did not expose the workspace knowledge textarea.");
    }
    if (initialState.workspaceKnowledge !== normalizedWorkspaceText) {
      await textareas.nth(1).fill(normalizedWorkspaceText);
      changes.push("workspaceKnowledge");
    }
  }

  if (changes.length > 0) {
    await page.locator("main").first().click({
      position: {
        x: 8,
        y: 8
      }
    }).catch(() => {});
    await page.waitForLoadState("networkidle", {
      timeout: 5_000
    }).catch(() => {});
    await page.waitForTimeout(2_000);
  }

  const state = await getProjectKnowledgeState(page, {
    projectUrl,
    timeoutMs
  });

  const mismatches = [];
  if (projectText !== undefined && state.projectKnowledge !== String(projectText)) {
    mismatches.push("project knowledge");
  }
  if (workspaceText !== undefined && state.workspaceKnowledge !== String(workspaceText)) {
    mismatches.push("workspace knowledge");
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Lovable did not persist ${mismatches.join(" and ")} after reload.`
    );
  }

  return {
    ok: true,
    changes,
    initialState,
    state
  };
}

export async function getWorkspaceSettingsState(page, {
  projectUrl = page.url(),
  section = "all",
  timeoutMs = 60_000
} = {}) {
  const normalizedSection = normalizeWorkspaceSection(section);
  if (normalizedSection === "all") {
    const sections = {};
    for (const key of ["workspace", "people", "billing", "usage", "workspace-domains", "privacy-security", "account"]) {
      sections[key] = await getWorkspaceSettingsState(page, {
        projectUrl,
        section: key,
        timeoutMs
      });
    }
    return {
      projectUrl,
      section: "all",
      sections
    };
  }

  const settingsUrl = await gotoProjectSettings(page, projectUrl, normalizedSection, {
    timeoutMs
  });
  await waitForSettingsMain(page, {
    timeoutMs: Math.min(timeoutMs, 20_000)
  });
  await page.waitForLoadState("networkidle", {
    timeout: 5_000
  }).catch(() => {});
  await page.waitForTimeout(1_000);

  let snapshot = await readSettingsPageSnapshotFromPage(page);
  if (!snapshot?.text && !snapshot?.lines?.length) {
    await page.waitForTimeout(1_500);
    snapshot = await readSettingsPageSnapshotFromPage(page);
  }
  if (!snapshot) {
    throw new Error(`Lovable workspace settings page "${normalizedSection}" did not render.`);
  }

  return {
    projectUrl,
    section: normalizedSection,
    settingsUrl,
    title: snapshot.headings[0] || normalizedSection,
    headings: snapshot.headings,
    buttons: snapshot.buttons,
    links: snapshot.links,
    comboboxes: snapshot.comboboxes,
    switches: snapshot.switches,
    rows: snapshot.rows,
    lines: snapshot.lines,
    text: snapshot.text
  };
}

async function readProjectGitStateFromToolbar(page, {
  projectUrl,
  provider = "github",
  timeoutMs = 20_000
} = {}) {
  await page.goto(projectUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs
  });
  await page.waitForLoadState("networkidle", {
    timeout: 5_000
  }).catch(() => {});

  const buttons = await readToolbarSnapshotFromPage(page);
  const normalizedProvider = normalizeGitProvider(provider);
  const targetButton = buttons.find((button) => {
    const label = normalizeText(button.label).toLowerCase();
    return label.includes(`manage ${normalizedProvider}`);
  });

  if (!targetButton) {
    return null;
  }

  const result = await openToolbarMenu(page, targetButton, {
    timeoutMs: Math.min(timeoutMs, 10_000)
  });
  const surface = result.surface || null;
  await closeToolbarMenu(page);

  if (!surface) {
    return null;
  }

  const repoLink = surface.links.find((link) => {
    return /^https:\/\/github\.com\/[^/]+\/[^/]+/i.test(link.href || "") &&
      !/github\.dev/i.test(link.href || "");
  });
  const repository = repoLink?.text || surface.lines.find((line) => /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/.test(line)) || null;
  const connected = /Connected/i.test(surface.text) || Boolean(repository);

  return {
    projectUrl,
    provider: normalizedProvider,
    settingsUrl: getProjectSettingsUrl(projectUrl, `git/${normalizedProvider}`),
    connected,
    repository,
    branch: null,
    account: repository ? repository.split("/")[0] : null,
    title: capitalize(normalizedProvider),
    availableActions: Array.from(
      new Set([
        ...surface.buttons,
        ...surface.links.map((link) => link.text).filter(Boolean)
      ])
    ),
    lines: surface.lines,
    text: surface.text,
    source: "toolbar"
  };
}

export async function getProjectGitState(page, {
  projectUrl = page.url(),
  provider = "github",
  timeoutMs = 60_000
} = {}) {
  const normalizedProvider = normalizeGitProvider(provider);
  const toolbarState = await readProjectGitStateFromToolbar(page, {
    projectUrl,
    provider: normalizedProvider,
    timeoutMs: Math.min(timeoutMs, 20_000)
  }).catch(() => null);

  if (toolbarState?.connected) {
    return toolbarState;
  }

  const settingsUrl = await gotoProjectSettings(page, projectUrl, `git/${normalizedProvider}`, {
    timeoutMs
  });
  await waitForSettingsMain(page, {
    timeoutMs: Math.min(timeoutMs, 20_000),
    headingPattern: /Git\/GitHub|Connect project|Repository connection|GitHub|GitLab/i
  });

  const snapshot = await readSettingsPageSnapshotFromPage(page);
  if (!snapshot) {
    throw new Error("Lovable git settings page did not render.");
  }

  const lines = snapshot.lines || [];
  const repository = getLineAfter(lines, /^Repository$/i) || parseRepositorySlugFromLines(lines);
  const branch = getLineAfter(lines, /^Branch$/i);
  const account = getLineAfter(lines, /^Account$/i);
  const connected = Boolean(repository) || lines.some((line) => /^Connected$/i.test(line));
  const availableActions = snapshot.buttons.map((button) => button.text || button.ariaLabel).filter(Boolean);

  return {
    projectUrl,
    provider: normalizedProvider,
    settingsUrl,
    connected,
    repository,
    branch,
    account,
    title: snapshot.headings[0] || `Git/${capitalize(normalizedProvider)}`,
    availableActions,
    lines,
    text: snapshot.text,
    source: "settings"
  };
}

async function clickGitAction(page, patterns, {
  timeoutMs = 15_000
} = {}) {
  const main = page.locator("main[aria-label='Settings content'], main").first();
  for (const pattern of patterns) {
    const button = main.getByRole("button", {
      name: pattern
    }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({
        timeout: timeoutMs
      });
      return true;
    }
  }
  return false;
}

async function waitForGitConnectionState(page, {
  projectUrl,
  provider,
  desiredConnected,
  timeoutMs = 90_000,
  pollMs = 1_000
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = await getProjectGitState(page, {
    projectUrl,
    provider,
    timeoutMs: Math.min(timeoutMs, 30_000)
  });

  while (Date.now() < deadline) {
    if (lastState.connected === desiredConnected) {
      return lastState;
    }
    await page.waitForTimeout(pollMs);
    lastState = await getProjectGitState(page, {
      projectUrl,
      provider,
      timeoutMs: Math.min(timeoutMs, 30_000)
    });
  }

  return lastState;
}

export async function connectProjectGitProvider(page, {
  projectUrl = page.url(),
  provider = "github",
  timeoutMs = 90_000,
  headless = false
} = {}) {
  const initialState = await getProjectGitState(page, {
    projectUrl,
    provider,
    timeoutMs
  });

  if (initialState.connected) {
    return {
      ok: true,
      changed: false,
      initialState,
      state: initialState
    };
  }

  if (headless) {
    throw new Error(
      `Connecting ${normalizeGitProvider(provider)} may require interactive provider OAuth. Re-run without --headless.`
    );
  }

  await gotoProjectSettings(page, projectUrl, `git/${normalizeGitProvider(provider)}`, {
    timeoutMs
  });
  await waitForSettingsMain(page, {
    timeoutMs: Math.min(timeoutMs, 20_000)
  });

  const clicked = await clickGitAction(page, [/^Add connection$/i, /^Connect$/i, /^Reconnect$/i], {
    timeoutMs: Math.min(timeoutMs, 15_000)
  });

  if (!clicked) {
    throw new Error(`Lovable did not expose a visible connect action for ${normalizeGitProvider(provider)}.`);
  }

  const state = await waitForGitConnectionState(page, {
    projectUrl,
    provider,
    desiredConnected: true,
    timeoutMs
  });

  if (!state.connected) {
    throw new Error(
      `Lovable did not confirm the ${normalizeGitProvider(provider)} connection. Finish any provider auth in the browser and retry.`
    );
  }

  return {
    ok: true,
    changed: true,
    initialState,
    state
  };
}

export async function reconnectProjectGitProvider(page, {
  projectUrl = page.url(),
  provider = "github",
  timeoutMs = 90_000,
  headless = false
} = {}) {
  if (headless) {
    throw new Error(
      `Reconnecting ${normalizeGitProvider(provider)} may require interactive provider OAuth. Re-run without --headless.`
    );
  }

  const initialState = await getProjectGitState(page, {
    projectUrl,
    provider,
    timeoutMs
  });

  await gotoProjectSettings(page, projectUrl, `git/${normalizeGitProvider(provider)}`, {
    timeoutMs
  });
  await waitForSettingsMain(page, {
    timeoutMs: Math.min(timeoutMs, 20_000)
  });

  const clicked = await clickGitAction(page, [/^Reconnect$/i, /^Connect$/i, /^Add connection$/i], {
    timeoutMs: Math.min(timeoutMs, 15_000)
  });

  if (!clicked) {
    throw new Error(`Lovable did not expose a visible reconnect action for ${normalizeGitProvider(provider)}.`);
  }

  const state = await waitForGitConnectionState(page, {
    projectUrl,
    provider,
    desiredConnected: true,
    timeoutMs
  });

  if (!state.connected) {
    throw new Error(
      `Lovable did not confirm the ${normalizeGitProvider(provider)} reconnect flow. Finish any provider auth in the browser and retry.`
    );
  }

  return {
    ok: true,
    changed: true,
    initialState,
    state
  };
}

export async function disconnectProjectGitProvider(page, {
  projectUrl = page.url(),
  provider = "github",
  timeoutMs = 60_000
} = {}) {
  const initialState = await getProjectGitState(page, {
    projectUrl,
    provider,
    timeoutMs
  });

  if (!initialState.connected) {
    return {
      ok: true,
      changed: false,
      initialState,
      state: initialState
    };
  }

  await gotoProjectSettings(page, projectUrl, `git/${normalizeGitProvider(provider)}`, {
    timeoutMs
  });
  await waitForSettingsMain(page, {
    timeoutMs: Math.min(timeoutMs, 20_000)
  });

  const clicked = await clickGitAction(page, [/^Disconnect$/i, /Remove connection/i, /Unlink/i], {
    timeoutMs: Math.min(timeoutMs, 15_000)
  });

  if (!clicked) {
    throw new Error(
      `Lovable does not expose a visible disconnect action for ${normalizeGitProvider(provider)} on this project.`
    );
  }

  const confirmDialog = page.locator("[role='dialog'],[role='alertdialog']").last();
  if (await confirmDialog.isVisible().catch(() => false)) {
    const confirmButton = confirmDialog.getByRole("button", {
      name: /^Disconnect$|^Remove$|^Confirm$/i
    }).first();
    if (await confirmButton.isVisible().catch(() => false)) {
      await confirmButton.click({
        timeout: Math.min(timeoutMs, 15_000)
      }).catch(() => {});
    }
  }

  const state = await waitForGitConnectionState(page, {
    projectUrl,
    provider,
    desiredConnected: false,
    timeoutMs
  });

  if (state.connected) {
    throw new Error(`Lovable did not confirm the ${normalizeGitProvider(provider)} disconnect.`);
  }

  return {
    ok: true,
    changed: true,
    initialState,
    state
  };
}

export async function connectProjectDomain(page, {
  projectUrl = page.url(),
  domain,
  advanced = false,
  timeoutMs = 60_000
} = {}) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();
  if (!normalizedDomain || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(normalizedDomain)) {
    throw new Error("Expected a valid fully-qualified custom domain, e.g. example.com or www.example.com.");
  }

  const initialState = await getProjectDomainSettingsState(page, {
    projectUrl,
    timeoutMs
  });

  if (initialState.customDomains.includes(normalizedDomain)) {
    return {
      ok: true,
      changed: false,
      initialState,
      finalState: initialState,
      listed: true
    };
  }

  await gotoProjectDomainsSettings(page, projectUrl, {
    timeoutMs
  });
  await waitForSettingsMain(page, {
    timeoutMs: Math.min(timeoutMs, 20_000),
    headingPattern: /Domains/i
  });

  await clickSettingsButton(page, /^Connect domain$/i, {
    timeoutMs: Math.min(timeoutMs, 15_000)
  });

  const dialog = page.locator("[role='dialog'],[role='alertdialog']").filter({
    hasText: /Connect a domain/i
  }).last();
  await dialog.waitFor({
    state: "visible",
    timeout: Math.min(timeoutMs, 15_000)
  });

  const input = dialog.locator("input[placeholder='example.com'],input[type='text']").first();
  await input.waitFor({
    state: "visible",
    timeout: Math.min(timeoutMs, 15_000)
  });
  await input.fill(normalizedDomain);

  if (advanced) {
    const advancedButton = dialog.getByRole("button", {
      name: /^Advanced$/i
    }).first();
    if (await advancedButton.isVisible().catch(() => false)) {
      await advancedButton.click({
        timeout: Math.min(timeoutMs, 10_000)
      }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }

  const connectButton = dialog.getByRole("button", {
    name: /^Connect$/i
  }).first();
  await connectButton.click({
    timeout: Math.min(timeoutMs, 15_000)
  });

  await dialog.waitFor({
    state: "hidden",
    timeout: Math.min(timeoutMs, 30_000)
  }).catch(() => {});
  await page.waitForLoadState("networkidle", {
    timeout: 5_000
  }).catch(() => {});
  await page.waitForTimeout(1_000);

  const finalState = await getProjectDomainSettingsState(page, {
    projectUrl,
    timeoutMs
  });
  const listed = finalState.customDomains.includes(normalizedDomain);

  if (!listed) {
    throw new Error(
      `Lovable accepted the custom domain dialog, but the domain "${normalizedDomain}" is not visible on the domains page yet.`
    );
  }

  return {
    ok: true,
    changed: true,
    initialState,
    finalState,
    listed
  };
}
