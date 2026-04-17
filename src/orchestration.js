export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_IDLE_POLL_MS = 3_000;
export const DEFAULT_IDLE_STREAK_TARGET = 3;
export const DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_CHARS = 1_000;
export const DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_NON_EMPTY_LINES = 24;
export const DEFAULT_PROMPT_AUTO_SPLIT_MAX_CHUNK_CHARS = 1_200;
export const DEFAULT_PROMPT_MARKDOWN_HARD_CHUNK_CHARS = 50_000;
export const DEFAULT_QUEUE_RESUME_ATTEMPTS = 3;
export const DEFAULT_PROMPT_LENIENT_ACK_THRESHOLD_CHARS = 900;
export const DEFAULT_PROMPT_LENIENT_ACK_THRESHOLD_NON_EMPTY_LINES = 16;
export const DEFAULT_SINGLE_PROMPT_LENIENT_ACK_TIMEOUT_MS = 45_000;
export const DEFAULT_FINAL_MULTIPART_PROMPT_TIMEOUT_MS = 60_000;
export const PROMPT_SOFT_SINGLE_SHOT_LIMIT_CHARS = 8_000;
export const PROMPT_STRONG_SPLIT_WARNING_CHARS = 32_000;

export const QUEUE_RESUME_ACTION_LABELS = [
  "Resume queue",
  "Continue queue"
];

export const NON_BUSY_ACTION_LABELS = [
  "Helpful",
  "Not helpful",
  "Copy message",
  "More options"
];

function normalizePromptInput(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function getNonEmptyPromptLines(prompt) {
  return normalizePromptInput(prompt)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeActionLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function splitLongLine(line, maxChunkChars) {
  const normalized = String(line || "");
  if (normalized.length <= maxChunkChars) {
    return [normalized];
  }

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > maxChunkChars) {
    let splitIndex = remaining.lastIndexOf(" ", maxChunkChars);
    if (splitIndex <= 0) {
      splitIndex = maxChunkChars;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

function splitOversizedBlock(block, maxChunkChars) {
  const lines = String(block || "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
  const chunks = [];
  let currentLines = [];

  for (const originalLine of lines) {
    const normalizedLines = splitLongLine(originalLine, maxChunkChars);

    for (const line of normalizedLines) {
    const next = currentLines.length > 0
      ? `${currentLines.join("\n")}\n${line}`
      : line;

    if (next.length > maxChunkChars && currentLines.length > 0) {
      chunks.push(currentLines.join("\n").trim());
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    chunks.push(currentLines.join("\n").trim());
  }

  return chunks.filter(Boolean);
}

function normalizeSplitStrategy(splitBy) {
  const normalized = String(splitBy || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (["chars", "char", "character", "character-count"].includes(normalized)) {
    return "chars";
  }

  if (["markdown", "md"].includes(normalized)) {
    return "markdown";
  }

  throw new Error(`Unsupported split strategy "${splitBy}". Use "chars" or "markdown".`);
}

function isFenceDelimiter(line) {
  return /^```/.test(String(line || "").trim());
}

function getMarkdownHeadingDepth(lines) {
  let inFence = false;
  let hasLevel2 = false;
  let hasLevel3 = false;

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (isFenceDelimiter(trimmed)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    if (/^##(?!#)\s+\S/.test(trimmed)) {
      hasLevel2 = true;
      continue;
    }

    if (/^###(?!#)\s+\S/.test(trimmed)) {
      hasLevel3 = true;
    }
  }

  if (hasLevel2) {
    return 2;
  }

  if (hasLevel3) {
    return 3;
  }

  return null;
}

function splitMarkdownBlocks(prompt, headingDepth) {
  const lines = normalizePromptInput(prompt).split("\n");
  const headingPattern = headingDepth === 2
    ? /^##(?!#)\s+\S/
    : /^###(?!#)\s+\S/;
  const blocks = [];
  const preamble = [];
  let currentBlock = null;
  let inFence = false;

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (isFenceDelimiter(trimmed)) {
      if (currentBlock) {
        currentBlock.push(line);
      } else {
        preamble.push(line);
      }
      inFence = !inFence;
      continue;
    }

    const isHeading = !inFence && headingPattern.test(trimmed);
    if (isHeading) {
      if (currentBlock) {
        blocks.push(currentBlock.join("\n").trim());
      }
      currentBlock = preamble.splice(0, preamble.length);
      currentBlock.push(line);
      continue;
    }

    if (currentBlock) {
      currentBlock.push(line);
    } else {
      preamble.push(line);
    }
  }

  if (currentBlock) {
    blocks.push(currentBlock.join("\n").trim());
  } else {
    const standalone = preamble.join("\n").trim();
    if (standalone) {
      blocks.push(standalone);
    }
  }

  return blocks.filter(Boolean);
}

function getPromptSizeWarnings(normalizedPrompt) {
  const warnings = [];
  if (normalizedPrompt.length > PROMPT_STRONG_SPLIT_WARNING_CHARS) {
    warnings.push(
      "Prompt exceeds ~32KB. Strongly recommend splitting, ideally with `--chunked` or `--split-by markdown`."
    );
  } else if (normalizedPrompt.length > PROMPT_SOFT_SINGLE_SHOT_LIMIT_CHARS) {
    warnings.push(
      "Prompt exceeds Lovable's soft single-shot limit (~8KB). Consider `--chunked` or `--no-auto-split`."
    );
  }
  return warnings;
}

export function shouldAutoSplitPrompt(prompt, {
  thresholdChars = DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_CHARS,
  thresholdNonEmptyLines = DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_NON_EMPTY_LINES
} = {}) {
  const normalized = normalizePromptInput(prompt);
  if (!normalized) {
    return false;
  }

  const nonEmptyLines = getNonEmptyPromptLines(normalized);

  return normalized.length > thresholdChars || nonEmptyLines.length > thresholdNonEmptyLines;
}

export function shouldUseLenientPromptAck(prompt, {
  thresholdChars = DEFAULT_PROMPT_LENIENT_ACK_THRESHOLD_CHARS,
  thresholdNonEmptyLines = DEFAULT_PROMPT_LENIENT_ACK_THRESHOLD_NON_EMPTY_LINES
} = {}) {
  const normalized = normalizePromptInput(prompt);
  if (!normalized) {
    return false;
  }

  const nonEmptyLines = getNonEmptyPromptLines(normalized);
  return normalized.length > thresholdChars || nonEmptyLines.length > thresholdNonEmptyLines;
}

export function getPromptTurnPostSubmitTimeoutMs({
  prompt,
  baseTimeoutMs = 20_000,
  partIndex = 1,
  totalParts = 1
} = {}) {
  const isFinalPart = partIndex === totalParts;
  if (!isFinalPart) {
    return Math.min(baseTimeoutMs, 8_000);
  }

  if (totalParts > 1) {
    return Math.max(baseTimeoutMs, DEFAULT_FINAL_MULTIPART_PROMPT_TIMEOUT_MS);
  }

  if (shouldUseLenientPromptAck(prompt)) {
    return Math.max(baseTimeoutMs, DEFAULT_SINGLE_PROMPT_LENIENT_ACK_TIMEOUT_MS);
  }

  return baseTimeoutMs;
}

export function splitPromptIntoChunks(prompt, {
  thresholdChars = DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_CHARS,
  thresholdNonEmptyLines = DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_NON_EMPTY_LINES,
  maxChunkChars = DEFAULT_PROMPT_AUTO_SPLIT_MAX_CHUNK_CHARS
} = {}) {
  const normalized = normalizePromptInput(prompt);
  if (!normalized) {
    return [];
  }

  if (!shouldAutoSplitPrompt(normalized, {
    thresholdChars,
    thresholdNonEmptyLines
  })) {
    return [normalized];
  }

  const blocks = normalized
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  const pieces = blocks.flatMap((block) => {
    if (block.length > maxChunkChars) {
      return splitOversizedBlock(block, maxChunkChars);
    }
    return [block];
  });

  const chunks = [];
  let currentPieces = [];

  for (const piece of pieces) {
    const next = currentPieces.length > 0
      ? `${currentPieces.join("\n\n")}\n\n${piece}`
      : piece;

    if (next.length > maxChunkChars && currentPieces.length > 0) {
      chunks.push(currentPieces.join("\n\n"));
      currentPieces = [piece];
      continue;
    }

    currentPieces.push(piece);
  }

  if (currentPieces.length > 0) {
    chunks.push(currentPieces.join("\n\n"));
  }

  return chunks.filter(Boolean);
}

export function hasMarkdownSplitHeadings(prompt) {
  const normalized = normalizePromptInput(prompt);
  if (!normalized) {
    return false;
  }

  return getMarkdownHeadingDepth(normalized.split("\n")) !== null;
}

export function splitPromptIntoMarkdownChunks(prompt, {
  hardLimitChars = DEFAULT_PROMPT_MARKDOWN_HARD_CHUNK_CHARS,
  fallbackMaxChunkChars = DEFAULT_PROMPT_AUTO_SPLIT_MAX_CHUNK_CHARS
} = {}) {
  const normalized = normalizePromptInput(prompt);
  if (!normalized) {
    return {
      chunks: [],
      headingDepth: null,
      warnings: [],
      usedFallback: false
    };
  }

  const headingDepth = getMarkdownHeadingDepth(normalized.split("\n"));
  if (!headingDepth) {
    return {
      chunks: [normalized],
      headingDepth: null,
      warnings: [],
      usedFallback: false
    };
  }

  const chunks = splitMarkdownBlocks(normalized, headingDepth);
  if (chunks.some((chunk) => chunk.length > hardLimitChars)) {
    return {
      chunks: splitPromptIntoChunks(normalized, {
        thresholdChars: 0,
        thresholdNonEmptyLines: 0,
        maxChunkChars: fallbackMaxChunkChars
      }),
      headingDepth,
      warnings: [
        `A markdown section exceeded the hard chunk limit (~${hardLimitChars.toLocaleString()} chars). Falling back to character-based splitting.`
      ],
      usedFallback: true
    };
  }

  return {
    chunks,
    headingDepth,
    warnings: [],
    usedFallback: false
  };
}

export function estimatePromptTokenCount(prompt, {
  charsPerToken = 4
} = {}) {
  const normalized = normalizePromptInput(prompt);
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.ceil(normalized.length / charsPerToken));
}

export function planPromptSequence(prompt, {
  autoSplit = true,
  chunked = false,
  splitBy,
  thresholdChars = DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_CHARS,
  thresholdNonEmptyLines = DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_NON_EMPTY_LINES,
  maxChunkChars = DEFAULT_PROMPT_AUTO_SPLIT_MAX_CHUNK_CHARS,
  markdownHardLimitChars = DEFAULT_PROMPT_MARKDOWN_HARD_CHUNK_CHARS
} = {}) {
  const normalized = normalizePromptInput(prompt);
  if (!normalized) {
    return {
      normalizedPrompt: "",
      sequence: [],
      warnings: [],
      estimatedTokens: 0,
      strategy: "none"
    };
  }

  const normalizedStrategy = normalizeSplitStrategy(splitBy);
  const useMarkdownSplit = normalizedStrategy === "markdown" ||
    (!normalizedStrategy && chunked && hasMarkdownSplitHeadings(normalized));
  const warnings = getPromptSizeWarnings(normalized);
  let rawChunks = [normalized];
  let strategy = "none";

  if (useMarkdownSplit && (autoSplit || chunked)) {
    const markdownPlan = splitPromptIntoMarkdownChunks(normalized, {
      hardLimitChars: markdownHardLimitChars,
      fallbackMaxChunkChars: maxChunkChars
    });
    rawChunks = markdownPlan.chunks;
    warnings.push(...markdownPlan.warnings);
    strategy = markdownPlan.usedFallback ? "chars" : "markdown";
  } else if (autoSplit || chunked) {
    rawChunks = splitPromptIntoChunks(normalized, {
      thresholdChars: chunked ? 0 : thresholdChars,
      thresholdNonEmptyLines: chunked ? 0 : thresholdNonEmptyLines,
      maxChunkChars
    });
    strategy = rawChunks.length > 1 ? "chars" : "none";
  }

  const sequence = rawChunks.map((chunk, index) => ({
    index: index + 1,
    total: rawChunks.length,
    rawPrompt: chunk,
    prompt: chunk,
    autoSplit: rawChunks.length > 1,
    splitStrategy: strategy
  }));

  return {
    normalizedPrompt: normalized,
    sequence,
    warnings,
    estimatedTokens: estimatePromptTokenCount(normalized),
    strategy,
    autoSplitTriggered: rawChunks.length > 1
  };
}

export function buildPromptSequence(prompt, {
  autoSplit = true,
  chunked = false,
  splitBy,
  thresholdChars = DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_CHARS,
  thresholdNonEmptyLines = DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_NON_EMPTY_LINES,
  maxChunkChars = DEFAULT_PROMPT_AUTO_SPLIT_MAX_CHUNK_CHARS,
  markdownHardLimitChars = DEFAULT_PROMPT_MARKDOWN_HARD_CHUNK_CHARS
} = {}) {
  return planPromptSequence(prompt, {
    autoSplit,
    chunked,
    splitBy,
    thresholdChars,
    thresholdNonEmptyLines,
    maxChunkChars,
    markdownHardLimitChars
  }).sequence;
}

export function parseAssertionLines(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function buildFidelityFollowUpPrompt({
  missingExpectedTexts = [],
  forbiddenTextsFound = []
} = {}) {
  const lines = [
    "Continue the existing implementation. Keep all correct work untouched."
  ];

  if (missingExpectedTexts.length > 0) {
    lines.push("", "The preview still misses these required items:");
    missingExpectedTexts.forEach((value) => {
      lines.push(`- ${value}`);
    });
  }

  if (forbiddenTextsFound.length > 0) {
    lines.push("", "The preview still contains these forbidden items:");
    forbiddenTextsFound.forEach((value) => {
      lines.push(`- ${value}`);
    });
  }

  lines.push(
    "",
    "Only fix these listed gaps. Do not redesign unrelated sections. When done, stop."
  );

  return lines.join("\n");
}

export function classifyIdleStateSnapshot(snapshot = {}) {
  const bodyText = String(snapshot.bodyText || "");
  const normalizedActionLabels = (snapshot.visibleActionLabels || []).map(normalizeActionLabel);
  const hasQueueResumeAction = QUEUE_RESUME_ACTION_LABELS.some((label) => {
    return normalizedActionLabels.includes(normalizeActionLabel(label));
  }) || /resume queue|continue queue/i.test(bodyText);
  const hasQueueText = /\bqueue\b/i.test(bodyText) || /waiting for answers/i.test(bodyText);
  const hasThinking = /\bthinking\b/i.test(bodyText);

  let status = "idle";
  if (snapshot.questionOpen) {
    status = "waiting_for_input";
  } else if (snapshot.runtimeErrorOpen) {
    status = "error";
  } else if (hasQueueResumeAction) {
    status = "queue_paused";
  } else if (hasThinking || hasQueueText) {
    status = "busy";
  }

  return {
    status,
    details: {
      questionOpen: Boolean(snapshot.questionOpen),
      runtimeErrorOpen: Boolean(snapshot.runtimeErrorOpen),
      hasQueueResumeAction,
      hasQueueText,
      hasThinking,
      visibleActionLabels: normalizedActionLabels.filter((label) => !NON_BUSY_ACTION_LABELS.map(normalizeActionLabel).includes(label))
    }
  };
}
