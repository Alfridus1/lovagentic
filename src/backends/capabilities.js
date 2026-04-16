// Canonical capability flags for lovagentic backends.
// Keep this list small and additive — external callers ship these strings.

export const CAPABILITIES = Object.freeze({
  // Session / auth
  AUTH_SESSION: "auth.session",

  // Projects
  PROJECT_LIST: "project.list",
  PROJECT_STATE: "project.state",
  PROJECT_IDLE: "project.idle",
  PROJECT_CREATE: "project.create",
  PROJECT_DELETE: "project.delete",

  // Prompting
  PROMPT_SUBMIT: "prompt.submit",
  PROMPT_MULTI_PART: "prompt.multi-part",
  PROMPT_MODE: "prompt.mode",
  PROMPT_CHAT_LOOP: "prompt.chat-loop",
  PROMPT_FIDELITY_LOOP: "prompt.fidelity-loop",
  PROMPT_QUESTIONS: "prompt.questions",

  // Actions
  ACTIONS_LIST: "actions.list",
  ACTIONS_CLICK: "actions.click",

  // Knowledge
  KNOWLEDGE_READ: "knowledge.read",
  KNOWLEDGE_WRITE: "knowledge.write",

  // Runtime errors / findings
  ERRORS_LIST: "errors.list",
  ERRORS_AUTOFIX: "errors.autofix",
  FINDINGS_LIST: "findings.list",

  // Publish / domain
  PUBLISH_RUN: "publish.run",
  PUBLISH_SETTINGS: "publish.settings",
  DOMAIN_CONNECT: "domain.connect",
  DOMAIN_DISCONNECT: "domain.disconnect",
  DOMAIN_SUBDOMAIN: "domain.subdomain",

  // Git
  GIT_CONNECT: "git.connect",
  GIT_DISCONNECT: "git.disconnect",
  GIT_RECONNECT: "git.reconnect",

  // Verify / speed
  VERIFY_DESKTOP: "verify.desktop",
  VERIFY_MOBILE: "verify.mobile",
  VERIFY_CONSOLE: "verify.console",
  VERIFY_LAYOUT: "verify.layout",
  SPEED_LIGHTHOUSE: "speed.lighthouse"
});

// Every capability as a Set for quick intersection checks.
export const ALL_CAPABILITIES = Object.freeze(new Set(Object.values(CAPABILITIES)));

/**
 * Missing capabilities = requested \ supported.
 * @param {Iterable<string>} requested
 * @param {Set<string>} supported
 * @returns {string[]}
 */
export function missingCapabilities(requested, supported) {
  const out = [];
  for (const cap of requested) {
    if (!supported.has(cap)) out.push(cap);
  }
  return out;
}
