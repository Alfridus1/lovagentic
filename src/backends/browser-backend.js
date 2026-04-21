// Browser backend — wraps the existing ../browser.js Playwright flows
// behind the shared Backend contract.
//
// For now this is mostly a re-export layer so CLI commands can keep using the
// thin helpers. As the backend contract matures, this file can absorb the
// orchestration glue that currently lives in cli.js.

import { CAPABILITIES, ALL_CAPABILITIES } from "./capabilities.js";

export async function createBrowserBackend(options = {}) {
  const browser = await import("../browser.js");
  const profile = await import("../profile.js");

  const features = new Set([
    CAPABILITIES.AUTH_SESSION,
    CAPABILITIES.PROJECT_LIST,
    CAPABILITIES.PROJECT_STATE,
    CAPABILITIES.PROJECT_IDLE,
    CAPABILITIES.PROJECT_CREATE,
    CAPABILITIES.PROMPT_SUBMIT,
    CAPABILITIES.PROMPT_MULTI_PART,
    CAPABILITIES.PROMPT_MODE,
    CAPABILITIES.PROMPT_CHAT_LOOP,
    CAPABILITIES.PROMPT_FIDELITY_LOOP,
    CAPABILITIES.PROMPT_QUESTIONS,
    CAPABILITIES.ACTIONS_LIST,
    CAPABILITIES.ACTIONS_CLICK,
    CAPABILITIES.KNOWLEDGE_READ,
    CAPABILITIES.KNOWLEDGE_WRITE,
    CAPABILITIES.ERRORS_LIST,
    CAPABILITIES.ERRORS_AUTOFIX,
    CAPABILITIES.FINDINGS_LIST,
    CAPABILITIES.PUBLISH_RUN,
    CAPABILITIES.PUBLISH_SETTINGS,
    CAPABILITIES.DOMAIN_CONNECT,
    CAPABILITIES.DOMAIN_DISCONNECT,
    CAPABILITIES.DOMAIN_SUBDOMAIN,
    CAPABILITIES.GIT_CONNECT,
    CAPABILITIES.GIT_DISCONNECT,
    CAPABILITIES.GIT_RECONNECT,
    CAPABILITIES.CODE_LIST,
    CAPABILITIES.CODE_READ,
    CAPABILITIES.VERIFY_DESKTOP,
    CAPABILITIES.VERIFY_MOBILE,
    CAPABILITIES.VERIFY_CONSOLE,
    CAPABILITIES.VERIFY_LAYOUT,
    CAPABILITIES.SPEED_LIGHTHOUSE
  ]);

  return {
    kind: "browser",
    features,
    raw: { browser, profile, options },

    async close() {
      // Browser contexts are owned by individual CLI commands today; nothing
      // to do at the backend level. Placeholder for a future long-lived context.
    }
  };
}

export { CAPABILITIES, ALL_CAPABILITIES };
