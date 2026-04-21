// Backend selector. Entry point for CLI and programmatic callers.
//
// Usage:
//   import { getBackend } from './backends/index.js';
//   const backend = await getBackend({
//     backend: 'auto',                 // 'auto' | 'browser' | 'api' | 'mcp'
//     features: ['prompt.submit', 'verify.desktop'],
//     browserOptions: { profileDir, headless: true },
//     apiOptions: { apiKey: process.env.LOVABLE_API_KEY },
//     mcpOptions: { transport: 'stdio', serverUrl: process.env.LOVABLE_MCP_URL }
//   });

import { CAPABILITIES, missingCapabilities } from "./capabilities.js";

/** @typedef {'auto'|'browser'|'api'|'mcp'} BackendKind */

/**
 * Resolve and construct a backend.
 *
 * @param {{
 *   backend?: BackendKind,
 *   features?: string[],
 *   browserOptions?: object,
 *   apiOptions?: object,
 *   mcpOptions?: object
 * }} options
 */
export async function getBackend(options = {}) {
  const kind = options.backend ?? "auto";
  const required = new Set(options.features ?? []);

  if (kind === "browser") {
    return await createBrowserBackend(options.browserOptions ?? {});
  }

  if (kind === "api") {
    const api = await tryCreateApiBackend(options.apiOptions ?? {}, { silent: false });
    if (!api) {
      throw new Error("API backend requested but not available. Configure LOVABLE_API_KEY.");
    }
    failOnMissing(required, api.features, "api");
    return api;
  }

  if (kind === "mcp") {
    const mcp = await tryCreateMcpBackend(options.mcpOptions ?? {});
    if (!mcp) {
      throw new Error(
        "MCP backend requested but not available. Configure LOVABLE_MCP_URL or pass mcpOptions.serverUrl."
      );
    }
    failOnMissing(required, mcp.features, "mcp");
    return mcp;
  }

  // 'auto'
  const api = await tryCreateApiBackend(options.apiOptions ?? {});
  if (api && missingCapabilities(required, api.features).length === 0) {
    return api;
  }

  const mcp = await tryCreateMcpBackend(options.mcpOptions ?? {});
  if (mcp && missingCapabilities(required, mcp.features).length === 0) {
    return mcp;
  }
  // fallback
  return await createBrowserBackend(options.browserOptions ?? {});
}

function failOnMissing(required, supported, kind) {
  const miss = missingCapabilities(required, supported);
  if (miss.length > 0) {
    throw new Error(
      `Backend '${kind}' is missing capabilities: ${miss.join(", ")}`
    );
  }
}

async function createBrowserBackend(options) {
  const { createBrowserBackend } = await import("./browser-backend.js");
  return await createBrowserBackend(options);
}

async function tryCreateApiBackend(options, control = {}) {
  const apiKey = options.apiKey ?? process.env.LOVABLE_API_KEY;
  const bearerToken = options.bearerToken ?? process.env.LOVABLE_BEARER_TOKEN;
  if (!apiKey && !bearerToken) return null;
  try {
    const { createApiBackend } = await import("./api-backend.js");
    return await createApiBackend(options);
  } catch (err) {
    if (control.silent === false) throw err;
    if (process.env.LOVAGENTIC_DEBUG) {
      console.error("[lovagentic] API backend unavailable:", err?.message || err);
    }
    return null;
  }
}

async function tryCreateMcpBackend(options) {
  const url = options.serverUrl ?? process.env.LOVABLE_MCP_URL;
  if (!url) return null;
  try {
    const { createMcpBackend } = await import("./mcp-backend.js");
    return await createMcpBackend({ ...options, serverUrl: url });
  } catch (err) {
    if (process.env.LOVAGENTIC_DEBUG) {
      console.error("[lovagentic] MCP backend unavailable:", err?.message || err);
    }
    return null;
  }
}

export { CAPABILITIES };
