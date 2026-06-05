"use strict";

const { MB, ensureBufferLimit } = require("./memory");

const DEFAULT_MAX_SSE_BUFFER_BYTES = 6 * MB;
const INTERNAL_INSTRUCTION_MARKER_RE = /CRITICAL\s+INSTRUCTION\s+\d+\s*:/i;
const INTERNAL_INSTRUCTION_PREFIX = "CRITICAL INSTRUCTION ";
const TEXT_PAYLOAD_KEYS = new Set(["content", "delta", "message", "output_text", "text"]);

// ── <think> block stripper ────────────────────────────────────────────────────
// claude-to-openai.js emits "<think>" / "</think>" as plain delta.content
// openai-to-antigravity.js passes these through as { text: "<think>" } parts
// (not thought:true) so stripThoughtPartsFromGeminiPayload doesn't catch them.
// This stateful stripper handles tags split across SSE chunk boundaries.
function createThinkBlockStripper() {
  let suppressing = false;
  let pending = "";

  function push(text) {
    let input = pending + String(text || "");
    pending = "";
    let output = "";

    while (input.length > 0) {
      if (suppressing) {
        const closeIdx = input.indexOf("</think>");
        if (closeIdx === -1) {
          // Entire remaining input is inside a think block — discard
          return output;
        }
        // Skip everything up to and including </think>
        input = input.slice(closeIdx + "</think>".length);
        suppressing = false;
        continue;
      }

      const openIdx = input.indexOf("<think>");
      if (openIdx === -1) {
        // No opening tag — check if tail could be a partial tag
        const partialLen = partialTagSuffixLength(input, "<think>");
        output += input.slice(0, input.length - partialLen);
        pending = input.slice(input.length - partialLen);
        return output;
      }

      // Emit text before <think>
      output += input.slice(0, openIdx);
      input = input.slice(openIdx + "<think>".length);
      suppressing = true;
    }

    return output;
  }

  function flush() {
    const out = suppressing ? "" : pending;
    pending = "";
    suppressing = false;
    return out;
  }

  return { push, flush };
}

/**
 * Return the length of the longest suffix of `text` that could be a
 * partial prefix of `tag` (e.g. "<thi" when tag is "<think>").
 */
function partialTagSuffixLength(text, tag) {
  const maxLen = Math.min(text.length, tag.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (tag.startsWith(text.slice(-len))) return len;
  }
  return 0;
}

/**
 * Strip <think>...</think> blocks from a plain text string (non-streaming).
 * Handles nested-free, single-pass replacement.
 */
function stripThinkBlocks(text) {
  if (!text || !text.includes("<think>")) return text;
  const stripper = createThinkBlockStripper();
  return (stripper.push(text) + stripper.flush()).trimStart();
}

function isInternalInstructionLeak(text) {
  return INTERNAL_INSTRUCTION_MARKER_RE.test(String(text || ""));
}

function isInternalInstructionMarkerPrefix(value) {
  const upper = String(value || "").toUpperCase();
  if (!upper) return false;
  if (INTERNAL_INSTRUCTION_PREFIX.startsWith(upper)) return true;
  if (!upper.startsWith(INTERNAL_INSTRUCTION_PREFIX)) return false;
  return /^\d{0,6}\s*:?\s*$/.test(upper.slice(INTERNAL_INSTRUCTION_PREFIX.length));
}

function internalInstructionMarkerPrefixSuffixLength(value) {
  const text = String(value || "");
  const maxLength = Math.min(text.length, INTERNAL_INSTRUCTION_PREFIX.length + 10);
  for (let length = maxLength; length > 0; length -= 1) {
    if (isInternalInstructionMarkerPrefix(text.slice(-length))) return length;
  }
  return 0;
}

function internalInstructionBoundaryIndex(value) {
  const text = String(value || "");
  const semicolon = text.indexOf(";");
  const blankLine = text.search(/\r?\n\s*\r?\n/);
  if (semicolon === -1) return blankLine;
  if (blankLine === -1) return semicolon;
  return Math.min(semicolon, blankLine);
}

function createInternalInstructionTextSanitizer() {
  let pending = "";
  let suppressing = false;

  function push(value) {
    pending += String(value || "");
    let output = "";

    while (pending) {
      if (suppressing) {
        const boundary = internalInstructionBoundaryIndex(pending);
        if (boundary === -1) {
          pending = "";
          return output;
        }
        pending = pending.slice(boundary + 1).replace(/^\s+/, "");
        suppressing = false;
        continue;
      }

      const match = INTERNAL_INSTRUCTION_MARKER_RE.exec(pending);
      if (!match) {
        const suffixLength = internalInstructionMarkerPrefixSuffixLength(pending);
        const emitLength = pending.length - suffixLength;
        output += pending.slice(0, emitLength);
        pending = pending.slice(emitLength);
        return output;
      }

      output += pending.slice(0, match.index).replace(/[;\s]+$/, (trimmed) => trimmed.includes("\n") ? "\n" : "");
      pending = pending.slice(match.index + match[0].length);
      suppressing = true;
    }

    return output;
  }

  function flush() {
    if (suppressing) {
      pending = "";
      suppressing = false;
      return "";
    }
    const output = pending;
    pending = "";
    return output;
  }

  return { push, flush };
}

function stripInternalInstructionLeaks(text) {
  const sanitizer = createInternalInstructionTextSanitizer();
  return (sanitizer.push(text) + sanitizer.flush()).trimStart();
}

function shouldSanitizeStringKey(key) {
  return TEXT_PAYLOAD_KEYS.has(String(key || ""));
}

function sanitizeInternalInstructionValue(value, sanitizer, thinkStripper, key = "") {
  if (typeof value === "string") {
    if (!shouldSanitizeStringKey(key)) return value;
    const afterThink = thinkStripper ? thinkStripper.push(value) : value;
    return sanitizer.push(afterThink);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeInternalInstructionValue(item, sanitizer, thinkStripper));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeInternalInstructionValue(childValue, sanitizer, thinkStripper, childKey);
    }
    return result;
  }
  return value;
}

function sanitizeInternalInstructionJsonText(text) {
  const sanitizer = createInternalInstructionTextSanitizer();
  const thinkStripper = createThinkBlockStripper();
  try {
    const parsed = JSON.parse(String(text || ""));
    stripThoughtPartsFromGeminiPayload(parsed);
    const sanitized = sanitizeInternalInstructionValue(parsed, sanitizer, thinkStripper);
    sanitizer.flush();
    thinkStripper.flush();
    return JSON.stringify(sanitized);
  } catch {
    return stripInternalInstructionLeaks(stripThinkBlocks(text));
  }
}

/**
 * Strip thought:true parts from a Gemini-format candidates array in-place.
 * Antigravity does not expect to receive thinking parts from the proxy —
 * they show up as raw text on screen when forwarded.
 * Mutates the parsed object directly to avoid an extra JSON round-trip.
 */
function stripThoughtPartsFromGeminiPayload(parsed) {
  if (!parsed || typeof parsed !== "object") return;

  // Support both wrapped { response: { candidates } } and flat { candidates }
  const root = parsed.response && typeof parsed.response === "object"
    ? parsed.response
    : parsed;

  const candidates = Array.isArray(root.candidates) ? root.candidates : null;
  if (!candidates) return;

  for (const candidate of candidates) {
    if (!candidate || !candidate.content) continue;
    const parts = candidate.content.parts;
    if (!Array.isArray(parts)) continue;
    const filtered = parts.filter((p) => !(p && p.thought === true));
    // Only mutate when something was actually removed
    if (filtered.length !== parts.length) {
      candidate.content.parts = filtered;
    }
  }
}

function sanitizeInternalInstructionSseEvent(event, sanitizer, thinkStripper) {
  const lines = String(event || "").split(/\r?\n/);
  const dataLines = [];
  const otherLines = [];

  for (const line of lines) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (line) otherLines.push(line);
  }

  if (dataLines.length === 0) return event;

  const data = dataLines.join("\n");
  if (data === "[DONE]" || data === "null") {
    return [...otherLines, `data: ${data}`].join("\n");
  }

  try {
    const parsed = JSON.parse(data);
    stripThoughtPartsFromGeminiPayload(parsed);
    const sanitized = sanitizeInternalInstructionValue(parsed, sanitizer, thinkStripper);
    return [...otherLines, `data: ${JSON.stringify(sanitized)}`].join("\n");
  } catch {
    return [...otherLines, `data: ${sanitizer.push(thinkStripper ? thinkStripper.push(data) : data)}`].join("\n");
  }
}

function nextSseEventBoundary(text) {
  const lf = text.indexOf("\n\n");
  const crlf = text.indexOf("\r\n\r\n");
  if (lf === -1) return crlf === -1 ? null : { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function createInternalInstructionSseSanitizer(maxBufferBytes = DEFAULT_MAX_SSE_BUFFER_BYTES) {
  let buffer = "";
  const sanitizer = createInternalInstructionTextSanitizer();
  const thinkStripper = createThinkBlockStripper();

  function push(chunk) {
    buffer += String(chunk || "");
    ensureBufferLimit(Buffer.byteLength(buffer), maxBufferBytes, "SSE buffer");
    let output = "";

    while (true) {
      const boundary = nextSseEventBoundary(buffer);
      if (!boundary) break;
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      output += `${sanitizeInternalInstructionSseEvent(event, sanitizer, thinkStripper)}\n\n`;
    }

    return output;
  }

  function flush() {
    const output = buffer ? sanitizeInternalInstructionSseEvent(buffer, sanitizer, thinkStripper) : "";
    buffer = "";
    sanitizer.flush();
    thinkStripper.flush();
    return output;
  }

  return { push, flush };
}

module.exports = {
  createInternalInstructionSseSanitizer,
  createInternalInstructionTextSanitizer,
  createThinkBlockStripper,
  isInternalInstructionLeak,
  sanitizeInternalInstructionJsonText,
  stripInternalInstructionLeaks,
  stripThinkBlocks,
  stripThoughtPartsFromGeminiPayload,
};
