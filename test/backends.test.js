import assert from "node:assert/strict";
import test from "node:test";

import {
  createApiBackend,
  DEFAULT_LOVABLE_API_BASE_URL,
  getApiBackendCapabilities,
  resolveApiBackendConfig
} from "../src/backends/api-backend.js";
import { CAPABILITIES } from "../src/backends/capabilities.js";
import { getBackend } from "../src/backends/index.js";

test("api backend config detects env-free state without exposing secrets", () => {
  const config = resolveApiBackendConfig({ apiKey: "lov_test_key" });
  assert.equal(config.apiKey, "lov_test_key");
  assert.equal(config.hasApiKey, true);
  assert.equal(config.configured, true);
  assert.equal(config.baseUrl, DEFAULT_LOVABLE_API_BASE_URL);
});

test("api backend advertises official SDK-backed capabilities", () => {
  const capabilities = getApiBackendCapabilities();
  assert.equal(capabilities.has(CAPABILITIES.AUTH_API_KEY), true);
  assert.equal(capabilities.has(CAPABILITIES.PROJECT_LIST), true);
  assert.equal(capabilities.has(CAPABILITIES.PROJECT_CREATE), true);
  assert.equal(capabilities.has(CAPABILITIES.PROMPT_SUBMIT), true);
  assert.equal(capabilities.has(CAPABILITIES.PUBLISH_RUN), true);
  assert.equal(capabilities.has(CAPABILITIES.MCP_SERVERS), true);
  assert.equal(capabilities.has(CAPABILITIES.VERIFY_DESKTOP), false);
});

test("explicit api backend fails closed without an API key", async () => {
  const previousApiKey = process.env.LOVABLE_API_KEY;
  const previousBearerToken = process.env.LOVABLE_BEARER_TOKEN;
  delete process.env.LOVABLE_API_KEY;
  delete process.env.LOVABLE_BEARER_TOKEN;
  try {
    await assert.rejects(
      () => createApiBackend({}),
      /LOVABLE_API_KEY or LOVABLE_BEARER_TOKEN is not set/
    );
    await assert.rejects(
      () => getBackend({ backend: "api" }),
      /Configure LOVABLE_API_KEY/
    );
  } finally {
    restoreEnv("LOVABLE_API_KEY", previousApiKey);
    restoreEnv("LOVABLE_BEARER_TOKEN", previousBearerToken);
  }
});

function restoreEnv(name, value) {
  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
