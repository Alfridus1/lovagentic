import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { waitForProjectIdle } from "../src/browser.js";

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

test("waitForProjectIdle auto-resumes an exact Resume queue action", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main>
        <div id="status">Queue paused.</div>
        <button
          aria-label="Resume queue"
          onclick="
            document.querySelector('#status').textContent = 'All caught up.';
            this.remove();
          "
        >
          Resume queue
        </button>
      </main>
    `);

    const result = await waitForProjectIdle(page, {
      timeoutMs: 2_000,
      pollMs: 100,
      autoResume: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, "idle");
    assert.equal(result.resumeAttempts, 1);
    assert.equal(result.state.status, "idle");
  });
});

test("waitForProjectIdle reports queue_paused without auto-resume", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main>
        <div id="status">Queue paused.</div>
        <button aria-label="Resume queue">Resume queue</button>
      </main>
    `);

    const result = await waitForProjectIdle(page, {
      timeoutMs: 500,
      pollMs: 100,
      autoResume: false
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "queue_paused");
    assert.equal(result.resumeAttempts, 0);
    assert.equal(result.state.status, "queue_paused");
  });
});
