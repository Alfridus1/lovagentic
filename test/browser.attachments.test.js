import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { getPromptAttachmentState, uploadPromptAttachments } from "../src/browser.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures");

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

test("uploadPromptAttachments attaches multiple files and waits for visible chips", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <form id="chat-input">
        <div aria-label="Chat input" contenteditable="true"></div>
        <div id="attachment-list"></div>
        <input id="file-upload" type="file" multiple hidden>
        <button id="chatinput-send-message-button" type="submit" disabled>
          <span class="sr-only">Send message</span>
        </button>
      </form>
      <script>
        const input = document.querySelector('#file-upload');
        const list = document.querySelector('#attachment-list');
        const send = document.querySelector('#chatinput-send-message-button');

        input.addEventListener('change', () => {
          list.innerHTML = '';
          for (const file of input.files) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.setAttribute('aria-label', file.name);
            chip.textContent = file.name;
            list.appendChild(chip);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.setAttribute('aria-label', 'Remove ' + file.name);
            list.appendChild(remove);
          }

          send.disabled = input.files.length === 0;
        });
      </script>
    `);

    const attachments = [
      path.join(FIXTURE_DIR, "reference-image.svg"),
      path.join(FIXTURE_DIR, "reference-data.csv"),
      path.join(FIXTURE_DIR, "reference-doc.pdf")
    ];

    const result = await uploadPromptAttachments(page, attachments, {
      timeoutMs: 1_000,
      pollMs: 25
    });

    assert.deepEqual(result.uploaded, [
      "reference-image.svg",
      "reference-data.csv",
      "reference-doc.pdf"
    ]);
    assert.deepEqual(result.state.filenames, [
      "reference-image.svg",
      "reference-data.csv",
      "reference-doc.pdf"
    ]);
    assert.equal(result.state.sendEnabled, true);
    assert.match(result.state.text, /reference-image\.svg/);
    assert.match(result.state.text, /reference-data\.csv/);
    assert.match(result.state.text, /reference-doc\.pdf/);

    const state = await getPromptAttachmentState(page);
    assert.equal(state.inputPresent, true);
    assert.equal(state.removeActions.length, 3);
  });
});
