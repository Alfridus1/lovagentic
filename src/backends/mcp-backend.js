// MCP backend — scaffold for a future public Lovable MCP surface.
//
// When Lovable ships the official Model Context Protocol, this file wires
// an MCP client against it and exposes the same Backend contract as
// browser-backend.js. Until then, createMcpBackend() refuses to construct
// so auto-selection falls back to the browser backend.
//
// Expected env:
//   LOVABLE_MCP_URL       — stdio command or https URL for the MCP server
//   LOVABLE_MCP_TOKEN     — bearer token (if the transport needs it)
//   LOVABLE_MCP_TRANSPORT — 'stdio' | 'http' | 'websocket' (default: infer)

import { CAPABILITIES } from "./capabilities.js";

export async function createMcpBackend(options = {}) {
  const url = options.serverUrl ?? process.env.LOVABLE_MCP_URL;
  if (!url) {
    throw new Error("LOVABLE_MCP_URL is not set. MCP backend cannot be constructed.");
  }

  // The SDK is an optional dep. We only require it when a user opts into MCP.
  let McpClient;
  try {
    // Lazy import so missing dep does not break CLI for browser-only users.
    McpClient = (await import("@modelcontextprotocol/sdk/client/index.js")).default;
  } catch {
    throw new Error(
      "@modelcontextprotocol/sdk is not installed. " +
        "Run `npm install @modelcontextprotocol/sdk` to enable the MCP backend. " +
        "Until Lovable's MCP ships, use the default browser backend."
    );
  }

  // Placeholder: real capability discovery will come from the server handshake.
  // Until we have the live MCP schema, treat this as unavailable.
  void McpClient;
  throw new Error(
    "Lovable MCP is not yet publicly available as a documented production surface. " +
      "Use the default browser backend until an official MCP transport exists."
  );
}

export { CAPABILITIES };
