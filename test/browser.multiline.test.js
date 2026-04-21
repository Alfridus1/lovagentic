import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { fillPrompt, submitPrompt, waitForPromptResult } from "../src/browser.js";

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

async function withPage(callback) {
  const browser = await chromium.launch({
    headless: true
  });
  const page = await browser.newPage();

  try {
    await callback(page);
  } finally {
    await browser.close();
  }
}

test("fillPrompt inserts multiline contenteditable text without Enter keydowns", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div
        id="prompt"
        contenteditable="true"
        aria-label="Chat input"
        style="min-height: 80px; width: 500px; border: 1px solid #999;"
      >Existing text that must be replaced.</div>
      <button
        id="submit"
        aria-label="Send message"
        onclick="window.submittedText = document.querySelector('#prompt').innerText;"
      >
        Send message
      </button>
      <script>
        window.enterKeydowns = 0;
        const prompt = document.querySelector('#prompt');
        prompt.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            window.enterKeydowns += 1;
          }
        });
      </script>
    `);

    const prompt = [
      "SECTION 1 - HERO:",
      "- Built for AI Agents",
      "- View on GitHub",
      "Terminal mockup showing a realistic agent workflow"
    ].join("\n");

    const fillResult = await fillPrompt(page, prompt, {
      selector: "#prompt"
    });

    assert.equal(fillResult.method, "insertText");

    const insertedText = await page.locator("#prompt").evaluate((element) => {
      return String(element.innerText || "");
    });
    assert.equal(normalizeLineEndings(insertedText), prompt);

    const enterKeydowns = await page.evaluate(() => window.enterKeydowns);
    assert.equal(enterKeydowns, 0);

    const submitResult = await submitPrompt(page, {
      submitSelector: "#submit"
    });
    assert.equal(submitResult.method, "click");

    const submittedText = await page.evaluate(() => window.submittedText);
    assert.equal(normalizeLineEndings(submittedText), prompt);
  });
});

test("fillPrompt and submitPrompt dismiss blocking Radix popovers", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div
        data-radix-popper-content-wrapper
        style="position: fixed; inset: 0; z-index: 9999; background: rgba(0, 0, 0, 0.01);"
      >
        Blocking popover
      </div>
      <div
        id="prompt"
        contenteditable="true"
        aria-label="Chat input"
        style="min-height: 80px; width: 500px; border: 1px solid #999;"
      ></div>
      <button
        id="submit"
        aria-label="Send message"
        onclick="window.submittedText = document.querySelector('#prompt').innerText;"
      >
        Send message
      </button>
    `);

    await fillPrompt(page, "Ship this change.", {
      selector: "#prompt"
    });

    assert.equal(await page.locator("[data-radix-popper-content-wrapper]").count(), 0);

    await page.evaluate(() => {
      const popover = document.createElement("div");
      popover.setAttribute("data-radix-popper-content-wrapper", "");
      popover.style.position = "fixed";
      popover.style.inset = "0";
      popover.style.zIndex = "9999";
      popover.style.background = "rgba(0, 0, 0, 0.01)";
      popover.textContent = "Second blocking popover";
      document.body.appendChild(popover);
    });

    const submitResult = await submitPrompt(page, {
      submitSelector: "#submit"
    });

    assert.match(submitResult.method, /^click/);
    assert.equal(await page.locator("[data-radix-popper-content-wrapper]").count(), 0);
    assert.equal(await page.evaluate(() => window.submittedText), "Ship this change.");
  });
});

test("waitForPromptResult matches multiline prompts after whitespace normalization", async () => {
  await withPage(async (page) => {
    const prompt = [
      "SECTION 1 - HERO",
      "1. Built for AI Agents",
      "2. View on GitHub",
      "3. Terminal mockup"
    ].join("\n");

    await page.setContent(`
      <main>
        <div id="history">
          <p>SECTION 1 - HERO</p>
          <p>1. Built for AI Agents</p>
          <p>2. View on GitHub</p>
          <p>3. Terminal mockup</p>
        </div>
        <div aria-label="Chat input"></div>
      </main>
    `);

    const result = await waitForPromptResult(page, {
      prompt,
      timeoutMs: 250,
      pollMs: 25
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, "prompt_visible");
  });
});

test("waitForPromptResult tolerates Lovable-style rendering that strips bullet markers", async () => {
  await withPage(async (page) => {
    const prompt = [
      "Please confirm this structure.",
      "",
      "SECTION 1 - HERO:",
      "- Built for AI Agents",
      "- View on GitHub",
      "- Terminal mockup showing a realistic agent workflow"
    ].join("\n");

    await page.setContent(`
      <main>
        <div id="history">
          <p>Please confirm this structure.</p>
          <p>SECTION 1 - HERO:</p>
          <p>Built for AI Agents</p>
          <p>View on GitHub</p>
          <p>Terminal mockup showing a realistic agent workflow</p>
        </div>
        <div aria-label="Chat input"></div>
      </main>
    `);

    const result = await waitForPromptResult(page, {
      prompt,
      timeoutMs: 250,
      pollMs: 25
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, "prompt_visible");
  });
});
