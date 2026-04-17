export function classifyPublishFailure(output = "") {
  const text = String(output || "");

  if (/npm error(?: code)?\s+E?404/i.test(text) && /not in this registry/i.test(text)) {
    return {
      retryable: true,
      reason: "registry_visibility_race"
    };
  }

  if (/cannot publish over the previously published versions/i.test(text)) {
    return {
      retryable: true,
      reason: "version_already_exists"
    };
  }

  return {
    retryable: false,
    reason: "unknown_failure"
  };
}

export function shouldTreatPublishFailureAsSuccess({
  publishOutput = "",
  currentGitHead,
  publishedGitHead
} = {}) {
  const failure = classifyPublishFailure(publishOutput);
  if (!failure.retryable) {
    return {
      ok: false,
      reason: failure.reason
    };
  }

  const normalizedCurrentGitHead = String(currentGitHead || "").trim().toLowerCase();
  const normalizedPublishedGitHead = String(publishedGitHead || "").trim().toLowerCase();

  if (!normalizedPublishedGitHead) {
    return {
      ok: false,
      reason: "missing_published_githead"
    };
  }

  if (normalizedCurrentGitHead && normalizedCurrentGitHead !== normalizedPublishedGitHead) {
    return {
      ok: false,
      reason: "published_githead_mismatch"
    };
  }

  return {
    ok: true,
    reason: failure.reason
  };
}
