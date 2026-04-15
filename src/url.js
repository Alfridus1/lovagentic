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
