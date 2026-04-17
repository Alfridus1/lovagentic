import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import {
  answerProjectQuestion,
  getPromptAttachmentState,
  submitPrompt,
  uploadPromptAttachments,
  waitForPromptResult
} from "../src/browser.js";

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

test("waitForPromptResult supports attachment-only sends", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main>
        <div id="history"></div>
        <form id="chat-input">
          <div aria-label="Chat input" contenteditable="true"></div>
          <div id="attachment-list"></div>
          <input id="file-upload" type="file" multiple hidden>
          <button id="chatinput-send-message-button" type="button">
            <span class="sr-only">Send message</span>
          </button>
        </form>
      </main>
      <script>
        const input = document.querySelector('#file-upload');
        const list = document.querySelector('#attachment-list');
        const history = document.querySelector('#history');

        const render = () => {
          list.innerHTML = '';
          for (const file of input.files) {
            const chip = document.createElement('span');
            chip.textContent = file.name;
            list.appendChild(chip);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.setAttribute('aria-label', 'Remove ' + file.name);
            list.appendChild(remove);
          }
        };

        input.addEventListener('change', render);

        document.querySelector('#chatinput-send-message-button').addEventListener('click', () => {
          history.textContent = Array.from(input.files).map((file) => file.name).join(' ');
          input.value = '';
          render();
        });
      </script>
    `);

    const attachments = [
      path.join(FIXTURE_DIR, "reference-note.txt"),
      path.join(FIXTURE_DIR, "reference-doc.pdf")
    ];

    await uploadPromptAttachments(page, attachments, {
      timeoutMs: 1_000,
      pollMs: 25
    });
    await submitPrompt(page);

    const result = await waitForPromptResult(page, {
      prompt: "",
      attachmentNames: [
        "reference-note.txt",
        "reference-doc.pdf"
      ],
      timeoutMs: 500,
      pollMs: 25
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, "attachments_visible");
    assert.equal(result.state.hasExpectedPayloadOutsideComposer, true);
    assert.equal(result.state.payloadStillInComposer, false);
  });
});

test("answerProjectQuestion uploads attachments before submitting the answer", async () => {
  await withPage(async (page) => {
    await page.route("https://lovable.dev/projects/test-project/chat", async (route) => {
      await route.fulfill({
        status: 202,
        headers: {
          "access-control-allow-origin": "*",
          "content-type": "application/json"
        },
        body: JSON.stringify({ ok: true })
      });
    });

    await page.setContent(`
      <form id="chat-input">
        <div aria-label="Chat input" contenteditable="true"></div>
        <div id="attachment-list"></div>
        <input id="file-upload" type="file" multiple hidden>
      </form>
      <div id="question-card">
        <span>Questions</span>
        <p>Please clarify the upload.</p>
        <button type="button">Other</button>
        <textarea placeholder="Type your answer"></textarea>
        <button id="submit-question" type="button">Submit</button>
      </div>
      <div id="submitted"></div>
      <script>
        const input = document.querySelector('#file-upload');
        const list = document.querySelector('#attachment-list');
        const textarea = document.querySelector('textarea');
        const submitted = document.querySelector('#submitted');

        const render = () => {
          list.innerHTML = '';
          for (const file of input.files) {
            const chip = document.createElement('span');
            chip.textContent = file.name;
            list.appendChild(chip);
          }
        };

        input.addEventListener('change', render);

        document.querySelector('#submit-question').addEventListener('click', async () => {
          submitted.textContent = JSON.stringify({
            answer: textarea.value,
            attachments: Array.from(input.files).map((file) => file.name)
          });
          document.querySelector('#question-card').remove();
          await fetch('https://lovable.dev/projects/test-project/chat', {
            method: 'POST',
            mode: 'cors'
          });
        });
      </script>
    `);

    const result = await answerProjectQuestion(page, {
      projectUrl: "https://lovable.dev/projects/test-project",
      answer: "Use the attached reference files.",
      attachmentPaths: [
        path.join(FIXTURE_DIR, "reference-data.csv"),
        path.join(FIXTURE_DIR, "reference-doc.pdf")
      ],
      timeoutMs: 1_000,
      settleMs: 50,
      actionsTimeoutMs: 250,
      actionsPollMs: 25,
      chatAcceptTimeoutMs: 1_000
    });

    assert.deepEqual(result.attachmentResult.uploaded, [
      "reference-data.csv",
      "reference-doc.pdf"
    ]);
    assert.equal(result.chatAccepted.ok, true);
    assert.equal(result.stateAfter.open, false);

    const submitted = JSON.parse(await page.locator("#submitted").textContent());
    assert.equal(submitted.answer, "Use the attached reference files.");
    assert.deepEqual(submitted.attachments, [
      "reference-data.csv",
      "reference-doc.pdf"
    ]);
  });
});
