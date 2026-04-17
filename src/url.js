import { DEFAULT_BASE_URL } from "./config.js";

function normalizeBaseUrl(baseUrl = DEFAULT_BASE_URL) {
  const url = new URL(baseUrl);
  url.hash = "";
  return url;
}

export function buildCreateUrl({
  prompt,
  images = [],
  autosubmit = true,
  baseUrl = DEFAULT_BASE_URL
}) {
  const url = normalizeBaseUrl(baseUrl);
  url.searchParams.set("autosubmit", String(Boolean(autosubmit)));

  const hashParams = new URLSearchParams();
  hashParams.set("prompt", prompt);

  for (const image of images) {
    hashParams.append("images", image);
  }

  url.hash = hashParams.toString();
  return url.toString();
}

export function normalizeTargetUrl(target, baseUrl = DEFAULT_BASE_URL) {
  const url = new URL(target, baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Target URL must use http:// or https://.");
  }
  return url.toString();
}

export function normalizePreviewRoute(route = "/") {
  const trimmed = String(route || "").trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    return `${url.pathname || "/"}${url.search}${url.hash}` || "/";
  }

  if (trimmed.startsWith("?") || trimmed.startsWith("#")) {
    return `/${trimmed}`;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function buildPreviewRouteUrl(baseUrl, route = "/") {
  const target = new URL(baseUrl);
  const normalizedRoute = normalizePreviewRoute(route);
  if (normalizedRoute === "/") {
    target.pathname = "/";
    target.search = "";
    target.hash = "";
    return target.toString();
  }

  return new URL(normalizedRoute, target).toString();
}

export function slugifyPreviewRoute(route = "/") {
  const normalizedRoute = normalizePreviewRoute(route);
  if (normalizedRoute === "/") {
    return "root";
  }

  const normalizedUrl = new URL(`https://example.invalid${normalizedRoute}`);
  const slugSource = `${normalizedUrl.pathname}${normalizedUrl.search}${normalizedUrl.hash}`
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  return slugSource || "root";
}

export function getVerificationScreenshotFilename(variant, route = "/", {
  explicitRoute = false
} = {}) {
  if (!explicitRoute) {
    return `${variant}.png`;
  }

  return `${variant}__${slugifyPreviewRoute(route)}.png`;
}
