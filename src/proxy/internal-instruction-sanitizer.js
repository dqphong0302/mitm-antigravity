"use strict";

const { MB, ensureBufferLimit } = require("./memory");

const DEFAULT_MAX_SSE_BUFFER_BYTES = 6 * MB;
const INTERNAL_INSTRUCTION_MARKER_RE = /CRITICAL\s+INSTRUCTION\s+\d+\s*:/i;
const INTERNAL_INSTRUCTION_PREFIX = "CRITICAL INSTRUCTION ";
const TEXT_PAYLOAD_KEYS = new Set(["content", "delta", "message", "output_text", "text"]);

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

function sanitizeInternalInstructionValue(value, sanitizer, key = "") {
  if (typeof value === "string") {
    if (!shouldSanitizeStringKey(key)) return value;
    return sanitizer.push(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeInternalInstructionValue(item, sanitizer));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeInternalInstructionValue(childValue, sanitizer, childKey);
    }
    return result;
  }
  return value;
}

function sanitizeInternalInstructionJsonText(text) {
  const sanitizer = createInternalInstructionTextSanitizer();
  try {
    const parsed = JSON.parse(String(text || ""));
    const sanitized = sanitizeInternalInstructionValue(parsed, sanitizer);
    sanitizer.flush();
    return JSON.stringify(sanitized);
  } catch {
    return stripInternalInstructionLeaks(text);
  }
}

function sanitizeInternalInstructionSseEvent(event, sanitizer) {
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
    const sanitized = sanitizeInternalInstructionValue(parsed, sanitizer);
    return [...otherLines, `data: ${JSON.stringify(sanitized)}`].join("\n");
  } catch {
    return [...otherLines, `data: ${sanitizer.push(data)}`].join("\n");
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

  function push(chunk) {
    buffer += String(chunk || "");
    ensureBufferLimit(Buffer.byteLength(buffer), maxBufferBytes, "SSE buffer");
    let output = "";

    while (true) {
      const boundary = nextSseEventBoundary(buffer);
      if (!boundary) break;
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      output += `${sanitizeInternalInstructionSseEvent(event, sanitizer)}\n\n`;
    }

    return output;
  }

  function flush() {
    const output = buffer ? sanitizeInternalInstructionSseEvent(buffer, sanitizer) : "";
    buffer = "";
    sanitizer.flush();
    return output;
  }

  return { push, flush };
}

module.exports = {
  createInternalInstructionSseSanitizer,
  createInternalInstructionTextSanitizer,
  isInternalInstructionLeak,
  sanitizeInternalInstructionJsonText,
  stripInternalInstructionLeaks,
};
