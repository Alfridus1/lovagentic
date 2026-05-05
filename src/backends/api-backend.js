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

// Live recon against api.lovable.dev confirmed that GET /v1/projects/{pid}
// returns a slimmer payload than items in GET /v1/workspaces/{wsId}/projects.
// Fields like tech_stack, edit_count, created_at, updated_at, last_edited_at,
// last_viewed_at, app_visitors_*, trending_score, user_display_name,
// user_photo_url, is_starred, remix_count, etc. live ONLY on list items.
//
// We enrich the single-get response by fetching the workspace's project list
// and merging the matching item back in. The list page is cached briefly per
// workspace so consecutive lookups don't multiply the round-trips.
const PROJECT_AGGREGATE_FIELDS = [
  "tech_stack",
  "created_at",
  "updated_at",
  "last_edited_at",
  "last_viewed_at",
  "edit_count",
  "user_display_name",
  "user_photo_url",
  "created_by",
  "user_id",
  "is_starred",
  "remix_count",
  "trending_score",
  "app_visitors_24h",
  "app_visitors_7d",
  "app_visitors_30d",
  "is_deleted",
  "exclude_from_being_read",
  "shared_context_admin_isolated",
];

const PROJECT_LIST_CACHE_TTL_MS = 30_000;
const projectListCache = new Map(); // workspaceId -> { fetchedAt, projects: Map<pid, listItem> }

function projectsCacheKey(workspaceId) {
  return String(workspaceId || "");
}

function getCachedProjectListItem(workspaceId, projectId) {
  const key = projectsCacheKey(workspaceId);
  const entry = projectListCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > PROJECT_LIST_CACHE_TTL_MS) {
    projectListCache.delete(key);
    return null;
  }
  return entry.projects.get(projectId) || null;
}

function storeProjectListInCache(workspaceId, projects) {
  const key = projectsCacheKey(workspaceId);
  const map = new Map();
  for (const p of projects || []) {
    if (p?.id) map.set(p.id, p);
  }
  projectListCache.set(key, { fetchedAt: Date.now(), projects: map });
}

export function clearApiBackendCaches() {
  projectListCache.clear();
}

/**
 * Merge aggregate-only fields from a list-item shape onto a single-get
 * project shape, without overriding fields the single-get already provides
 * (e.g. latest_commit_sha, latest_screenshot_url).
 */
export function mergeProjectAggregates(slim, listItem) {
  if (!slim || !listItem) return slim;
  const enriched = { ...slim };
  for (const f of PROJECT_AGGREGATE_FIELDS) {
    if (enriched[f] === undefined && listItem[f] !== undefined) {
      enriched[f] = listItem[f];
    }
  }
  // The single-get omits `name` (slug) on some plans but keeps display_name;
  // the list always carries both. Surface the slug if missing.
  if (enriched.name === undefined && listItem.name !== undefined) {
    enriched.name = listItem.name;
  }
  return enriched;
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

    async getProjectState(projectId, opts = {}) {
      const slim = await client.getProject(projectId);
      // Per-call escape hatch for callers that don't need aggregates and
      // want to skip the second round-trip.
      if (opts.fast === true) return slim;
      const enriched = await enrichProjectWithAggregates(client, slim);
      return enriched;
    },

    /**
     * Convenience for callers who only want the slim single-get response.
     * Equivalent to `getProjectState(id, { fast: true })`.
     */
    async getProjectStateFast(projectId) {
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
      return await client.remixProject(sourceProjectId, normalizeRemixOptions(options));
    },

    async waitForRemix(sourceProjectId, jobId, options) {
      return await client.waitForRemix(sourceProjectId, jobId, options);
    },

    async listConnectors(workspaceId) {
      const response = await callSdkMethod(client, ["listConnectors", "listMCPServers"], [workspaceId]);
      return normalizeConnectorListResponse(response);
    },

    async addConnector(workspaceId, body) {
      return await callSdkMethod(client, ["addConnector", "addMCPServer"], [workspaceId, body]);
    },

    async removeConnector(workspaceId, connectorId) {
      return await callSdkMethod(client, ["removeConnector", "removeMCPServer"], [workspaceId, connectorId]);
    },

    async listAvailableConnectors(workspaceId) {
      const response = await callSdkMethod(client, ["listAvailableConnectors", "listMCPCatalog"], [workspaceId]);
      return normalizeConnectorCatalogResponse(response);
    },

    async listMCPServers(workspaceId) {
      const response = await callSdkMethod(client, ["listConnectors", "listMCPServers"], [workspaceId]);
      return normalizeMcpServerListResponse(response);
    },

    async addMCPServer(workspaceId, body) {
      return await callSdkMethod(client, ["addConnector", "addMCPServer"], [workspaceId, body]);
    },

    async removeMCPServer(workspaceId, serverId) {
      return await callSdkMethod(client, ["removeConnector", "removeMCPServer"], [workspaceId, serverId]);
    },

    async listMCPCatalog(workspaceId) {
      const response = await callSdkMethod(client, ["listAvailableConnectors", "listMCPCatalog"], [workspaceId]);
      return normalizeConnectorCatalogResponse(response);
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

export function normalizeRemixOptions(options = {}) {
  const out = { ...options };
  delete out.includeAgentState;
  delete out.include_agent_state;
  return out;
}

export function normalizeConnectorListResponse(response) {
  const base = isPlainObject(response) ? { ...response } : {};
  const connectors = firstArray(response?.connectors, response?.servers, response);
  return { ...base, connectors };
}

export function normalizeMcpServerListResponse(response) {
  const normalized = normalizeConnectorListResponse(response);
  const servers = firstArray(response?.servers, normalized.connectors);
  return { ...normalized, servers };
}

export function normalizeConnectorCatalogResponse(response) {
  const base = isPlainObject(response) ? { ...response } : {};
  const catalog = firstArray(response?.catalog, response?.connectors, response);
  return { ...base, catalog };
}

async function callSdkMethod(client, methodNames, args = []) {
  for (const methodName of methodNames) {
    const method = client?.[methodName];
    if (typeof method === "function") {
      return await method.call(client, ...args);
    }
  }
  throw new Error(`@lovable.dev/sdk does not expose any of: ${methodNames.join(", ")}`);
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

/**
 * Take a single-get project response and graft on the aggregate-only fields
 * from the project list endpoint. Caches list pages per workspace for
 * `PROJECT_LIST_CACHE_TTL_MS` so back-to-back enriches share one round-trip.
 *
 * Failure modes are intentionally soft: if the workspace_id is missing on the
 * slim response, or the list endpoint is rate-limited, we return the slim
 * response unchanged rather than failing the call.
 */
export async function enrichProjectWithAggregates(client, slim) {
  if (!slim || typeof slim !== "object") return slim;
  const wsId = slim.workspace_id;
  if (!wsId) return slim;

  // Already enriched? Avoid the round-trip.
  if (slim.tech_stack !== undefined || slim.edit_count !== undefined) {
    return slim;
  }

  const cached = getCachedProjectListItem(wsId, slim.id);
  if (cached) return mergeProjectAggregates(slim, cached);

  try {
    const list = await client.listProjects(wsId, { limit: 100, sort_by: "last_edited_at", sort_order: "desc" });
    const projects = list?.projects || [];
    storeProjectListInCache(wsId, projects);
    const item = projects.find((p) => p?.id === slim.id);
    return mergeProjectAggregates(slim, item);
  } catch {
    // Soft-fail: prefer a slim object over a thrown error.
    return slim;
  }
}

export { CAPABILITIES };
