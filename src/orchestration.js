export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_IDLE_POLL_MS = 3_000;
export const DEFAULT_IDLE_STREAK_TARGET = 3;
export const DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_CHARS = 1_000;
export const DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_NON_EMPTY_LINES = 24;
export const DEFAULT_PROMPT_AUTO_SPLIT_MAX_CHUNK_CHARS = 1_200;
export const DEFAULT_QUEUE_RESUME_ATTEMPTS = 3;
export const DEFAULT_PROMPT_LENIENT_ACK_THRESHOLD_CHARS = 900;
export const DEFAULT_PROMPT_LENIENT_ACK_THRESHOLD_NON_EMPTY_LINES = 16;
export const DEFAULT_SINGLE_PROMPT_LENIENT_ACK_TIMEOUT_MS = 45_000;
export const DEFAULT_FINAL_MULTIPART_PROMPT_TIMEOUT_MS = 60_000;

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

function getPromptPartWrapper(partNumber, totalParts, isFinal) {
  if (isFinal) {
    return `This is the final part of the same request. Use all parts together and now proceed. Part ${partNumber}/${totalParts}:`;
  }

  return `This request is being sent in ${totalParts} parts due to Lovable prompt limits. Do not implement yet; wait for the final part. Part ${partNumber}/${totalParts}:`;
}

function ensureWrappedChunksWithinLimit(rawChunks, maxChunkChars) {
  const chunks = [...rawChunks];

  for (let guard = 0; guard < 100; guard += 1) {
    let changed = false;
    const totalParts = chunks.length;

    for (let index = 0; index < chunks.length; index += 1) {
      const wrapper = getPromptPartWrapper(index + 1, totalParts, index + 1 === totalParts);
      const allowedRawLength = Math.max(1, maxChunkChars - `${wrapper}\n\n`.length);
      const currentChunk = chunks[index];

      if (currentChunk.length <= allowedRawLength) {
        continue;
      }

      const split = splitPromptIntoChunks(currentChunk, {
        thresholdChars: 0,
        thresholdNonEmptyLines: 0,
        maxChunkChars: allowedRawLength
      });

      if (split.length <= 1 && split[0]?.length > allowedRawLength) {
        return chunks;
      }

      chunks.splice(index, 1, ...split);
      changed = true;
      break;
    }

    if (!changed) {
      return chunks;
    }
  }

  return chunks;
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

export function buildPromptSequence(prompt, {
  autoSplit = true,
  thresholdChars = DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_CHARS,
  thresholdNonEmptyLines = DEFAULT_PROMPT_AUTO_SPLIT_THRESHOLD_NON_EMPTY_LINES,
  maxChunkChars = DEFAULT_PROMPT_AUTO_SPLIT_MAX_CHUNK_CHARS
} = {}) {
  const normalized = normalizePromptInput(prompt);
  if (!normalized) {
    return [];
  }

  const rawChunks = autoSplit
    ? splitPromptIntoChunks(normalized, {
      thresholdChars,
      thresholdNonEmptyLines,
      maxChunkChars
    })
    : [normalized];

  if (rawChunks.length <= 1) {
    return [{
      index: 1,
      total: 1,
      rawPrompt: normalized,
      prompt: normalized,
      autoSplit: false
    }];
  }

  const wrappedChunks = ensureWrappedChunksWithinLimit(rawChunks, maxChunkChars);

  return wrappedChunks.map((chunk, index) => {
    const partNumber = index + 1;
    const isFinal = partNumber === wrappedChunks.length;
    const wrapper = getPromptPartWrapper(partNumber, wrappedChunks.length, isFinal);

    return {
      index: partNumber,
      total: wrappedChunks.length,
      rawPrompt: chunk,
      prompt: `${wrapper}\n\n${chunk}`,
      autoSplit: true
    };
  });
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
