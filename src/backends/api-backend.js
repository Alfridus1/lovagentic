// Official Lovable API backend.
//
// This adapter is intentionally thin: it exposes the public @lovable.dev/sdk
// behind the same backend capability model as the browser backend. CLI
// commands can migrate to API-first behavior one command at a time while
// keeping Playwright as the fallback for UI-only surfaces.

import fs from "node:fs/promises";
import path from "node:path";

import { CAPABILITIES } from "./capabilities.js";

export const DEFAULT_LOVABLE_API_BASE_URL = "https://api.lovable.dev";

export function resolveApiBackendConfig(options = {}) {
  const apiKey = options.apiKey ?? process.env.LOVABLE_API_KEY;
  const bearerToken = options.bearerToken ?? process.env.LOVABLE_BEARER_TOKEN;
  const baseUrl = options.baseUrl ?? process.env.LOVABLE_API_BASE_URL ?? DEFAULT_LOVABLE_API_BASE_URL;

  return {
    apiKey,
    bearerToken,
    baseUrl,
    hasApiKey: Boolean(apiKey),
    hasBearerToken: Boolean(bearerToken),
    configured: Boolean(apiKey || bearerToken)
  };
}

/**
 * If no env-provided credentials exist, fall back to the on-disk auth cache
 * managed by `lovagentic auth bootstrap` / `auth refresh`. Returns an updated
 * config object that now carries a valid bearer token, refreshing the cache
 * when needed. Never overwrites credentials passed via options or env vars.
 */
async function fillCredentialsFromCache(config, options) {
  if (config.hasApiKey || config.hasBearerToken) return config;
  if (options.skipAuthCache) return config;
  let getValidAccessToken;
  try {
    ({ getValidAccessToken } = await import("../auth.js"));
  } catch {
    return config;
  }
  try {
    const { accessToken } = await getValidAccessToken({ filePath: options.authFile });
    if (!accessToken) return config;
    return {
      ...config,
      bearerToken: accessToken,
      hasBearerToken: true,
      configured: true,
      source: "auth-cache",
    };
  } catch {
    return config;
  }
}

export function getApiBackendCapabilities() {
  return new Set([
    CAPABILITIES.AUTH_API_KEY,
    CAPABILITIES.PROJECT_LIST,
    CAPABILITIES.PROJECT_STATE,
    CAPABILITIES.PROJECT_CREATE,
    CAPABILITIES.PROJECT_IDLE,
    CAPABILITIES.PROJECT_REMIX,
    CAPABILITIES.PROMPT_SUBMIT,
    CAPABILITIES.PROMPT_MODE,
    CAPABILITIES.KNOWLEDGE_READ,
    CAPABILITIES.KNOWLEDGE_WRITE,
    CAPABILITIES.PUBLISH_RUN,
    CAPABILITIES.CODE_LIST,
    CAPABILITIES.CODE_READ,
    CAPABILITIES.CODE_DIFF,
    CAPABILITIES.EDITS_LIST,
    CAPABILITIES.MCP_SERVERS,
    CAPABILITIES.MCP_CONNECTORS,
    CAPABILITIES.ANALYTICS_READ,
    CAPABILITIES.DATABASE_STATUS,
    CAPABILITIES.DATABASE_ENABLE,
    CAPABILITIES.DATABASE_QUERY
  ]);
}

export async function createApiBackend(options = {}) {
  let config = resolveApiBackendConfig(options);
  if (config.hasApiKey && config.hasBearerToken) {
    throw new Error("Configure either LOVABLE_API_KEY or LOVABLE_BEARER_TOKEN, not both.");
  }
  if (!config.configured) {
    config = await fillCredentialsFromCache(config, options);
  }
  if (!config.configured) {
    throw new Error(
      "Lovable API auth not configured. Set LOVABLE_API_KEY (lov_...) or LOVABLE_BEARER_TOKEN, or run `lovagentic auth bootstrap`."
    );
  }

  let LovableClient;
  try {
    ({ LovableClient } = await import("@lovable.dev/sdk"));
  } catch (err) {
    throw new Error(
      "@lovable.dev/sdk is not installed. Run `npm install @lovable.dev/sdk` to enable the API backend."
    );
  }

  const client = new LovableClient({
    apiKey: config.apiKey,
    bearerToken: config.bearerToken,
    baseUrl: config.baseUrl,
    headers: options.headers
  });

  const features = getApiBackendCapabilities();

  return {
    kind: "api",
    features,
    raw: { client, config: safeConfig(config), options },

    async me() {
      return await client.me();
    },

    async hasSession() {
      try {
        await client.me();
        return true;
      } catch {
        return false;
      }
    },

    async ensureSignedIn() {
      await client.me();
    },

    async listWorkspaces() {
      return await client.listWorkspaces();
    },

    async getWorkspace(workspaceId) {
      return await client.getWorkspace(workspaceId);
    },

    async listProjects(params = {}) {
      if (params.workspaceId) {
        return await client.listProjects(params.workspaceId, stripWorkspaceId(params));
      }

      const workspaces = await client.listWorkspaces();
      const projects = [];
      for (const workspace of workspaces) {
        const response = await client.listProjects(workspace.id, stripWorkspaceId(params));
        for (const project of response.projects ?? []) {
          projects.push({ ...project, workspace_id: project.workspace_id ?? workspace.id });
        }
      }
      return { projects, total: projects.length, has_more: false, workspaces };
    },

    async createProject(workspaceId, options) {
      return await client.createProject(workspaceId, await normalizeProjectOptions(options));
    },

    async getProjectState(projectId) {
      return await client.getProject(projectId);
    },

    getPreviewUrl(projectId) {
      return client.getPreviewUrl(projectId);
    },

    async getProjectIdleState(projectId) {
      const project = await client.getProject(projectId);
      if (project.status === "failed") {
        return { status: "error", project };
      }
      if (project.status === "in_progress") {
        return { status: "busy", project };
      }
      return { status: "idle", project };
    },

    async waitForProjectReady(projectId, options) {
      return await client.waitForProjectReady(projectId, options);
    },

    async submitPrompt(projectId, options = {}) {
      const message = options.message ?? options.text;
      if (!message) {
        throw new Error("submitPrompt requires `message` or `text`.");
      }
      const response = await client.chat(projectId, {
        message,
        files: await normalizeFiles(options.files ?? options.filePaths),
        uploadedFiles: options.uploadedFiles,
        chatOnly: Boolean(options.chatOnly),
        planMode: options.planMode ?? options.mode === "plan",
        customModel: options.customModel,
        customModelDisableRace: options.customModelDisableRace,
        continuation: options.continuation
      });

      if (options.wait === false) {
        return response;
      }

      const completion = await client.waitForMessageCompletion(projectId, response.message_id, {
        pollInterval: options.pollInterval,
        timeout: options.timeout
      });
      return { ...response, completion };
    },

    async waitForResponse(projectId, options) {
      return await client.waitForResponse(projectId, options);
    },

    async getMessage(projectId, messageId) {
      return await client.getMessage(projectId, messageId);
    },

    async waitForMessageCompletion(projectId, messageId, options) {
      return await client.waitForMessageCompletion(projectId, messageId, options);
    },

    async getProjectKnowledge(projectId) {
      return await client.getProjectKnowledge(projectId);
    },

    async setProjectKnowledge(projectId, content) {
      return await client.setProjectKnowledge(projectId, content);
    },

    async getWorkspaceKnowledge(workspaceId) {
      return await client.getWorkspaceKnowledge(workspaceId);
    },

    async setWorkspaceKnowledge(workspaceId, content) {
      return await client.setWorkspaceKnowledge(workspaceId, content);
    },

    async publish(projectId, options) {
      return await client.publish(projectId, options);
    },

    async waitForProjectPublished(projectId, options) {
      return await client.waitForProjectPublished(projectId, options);
    },

    async getPublishedUrl(projectId) {
      return await client.getPublishedUrl(projectId);
    },

    async setProjectVisibility(projectId, visibility) {
      return await client.setProjectVisibility(projectId, visibility);
    },

    async listFiles(projectId, ref = "HEAD") {
      return await client.listFiles(projectId, ref);
    },

    async readFile(projectId, filePath, ref = "HEAD") {
      return await client.readFile(projectId, filePath, ref);
    },

    async getDiff(projectId, params) {
      return await client.getDiff(projectId, params);
    },

    async listEdits(projectId, params) {
      return await client.listEdits(projectId, params);
    },

    async remixProject(sourceProjectId, options) {
      return await client.remixProject(sourceProjectId, options);
    },

    async waitForRemix(sourceProjectId, jobId, options) {
      return await client.waitForRemix(sourceProjectId, jobId, options);
    },

    async listMCPServers(workspaceId) {
      return await client.listMCPServers(workspaceId);
    },

    async addMCPServer(workspaceId, body) {
      return await client.addMCPServer(workspaceId, body);
    },

    async removeMCPServer(workspaceId, serverId) {
      return await client.removeMCPServer(workspaceId, serverId);
    },

    async listMCPCatalog(workspaceId) {
      return await client.listMCPCatalog(workspaceId);
    },

    async listStandardConnectors(workspaceId) {
      return await client.listStandardConnectors(workspaceId);
    },

    async listSeamlessConnectors(workspaceId) {
      return await client.listSeamlessConnectors(workspaceId);
    },

    async listMCPConnectors(workspaceId) {
      return await client.listMCPConnectors(workspaceId);
    },

    async listConnections(workspaceId, params) {
      return await client.listConnections(workspaceId, params);
    },

    async getProjectAnalytics(projectId, params) {
      return await client.getProjectAnalytics(projectId, params);
    },

    async getProjectAnalyticsTrend(projectId) {
      return await client.getProjectAnalyticsTrend(projectId);
    },

    async getDatabaseStatus(projectId) {
      return await client.getDatabaseStatus(projectId);
    },

    async enableDatabase(projectId) {
      return await client.enableDatabase(projectId);
    },

    async queryDatabase(projectId, sql) {
      return await client.queryDatabase(projectId, sql);
    },

    async getDatabaseConnectionInfo(projectId) {
      return await client.getDatabaseConnectionInfo(projectId);
    },

    async close() {
      // API client has no long-lived local resources.
    }
  };
}

function stripWorkspaceId(params) {
  const out = { ...params };
  delete out.workspaceId;
  return out;
}

async function normalizeProjectOptions(options = {}) {
  return {
    ...options,
    files: await normalizeFiles(options.files ?? options.filePaths)
  };
}

async function normalizeFiles(files) {
  if (!files || files.length === 0) return undefined;
  const out = [];
  for (const file of files) {
    if (typeof file !== "string") {
      out.push(file);
      continue;
    }
    const data = await fs.readFile(file);
    out.push({
      name: path.basename(file),
      data,
      type: guessMimeType(file)
    });
  }
  return out;
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".csv") return "text/csv";
  if (ext === ".txt" || ext === ".md") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".xls") return "application/vnd.ms-excel";
  return "application/octet-stream";
}

function safeConfig(config) {
  return {
    baseUrl: config.baseUrl,
    hasApiKey: config.hasApiKey,
    hasBearerToken: config.hasBearerToken,
    configured: config.configured
  };
}

export { CAPABILITIES };
