const dns = require("dns");
const https = require("https");
const fs = require("fs");
const { promisify } = require("util");

const { APP_NAME } = require("../config/constants");
const { certPaths } = require("../cert");
const { primaryTargetHost, targetHostsFrom } = require("../config");
const { collectBodyRaw, sendJson } = require("../system/http");
const {
  extractModelFromBody,
  extractModelFromUrl,
  getMappedEntry,
  modelAliasFromName,
} = require("../models");
const { summarizeAntigravityModelsResponse } = require("../models/serialization");
const {
  buildRouterHeaders,
  bypassInterceptReason,
  isAccountBootstrapRequest,
  isChatRequestUrl,
  isModelBootstrapMergeRequest,
  logChatPassthrough,
  logPassthroughResponse,
  retryWithBackoff,
  safeRequestPath,
  sendUpstreamErrorResponse,
} = require("./helpers");
const {
  logProxyError,
  logProxyMap,
  logProxyOk,
  logProxyReady,
} = require("./logger");

const MB = 1024 * 1024;
// Normal Antigravity chat payloads are much smaller; keep guards ~1.5x larger
// than generous baseline sizes so heavy prompts breathe but bad streams cannot
// grow memory without bound.
const MAX_REQUEST_BODY_BYTES = 96 * MB;
const MAX_RESPONSE_BODY_BYTES = 192 * MB;
const MAX_SSE_BUFFER_BYTES = 6 * MB;
const MAX_PASSTHROUGH_BUFFER_BYTES = 48 * MB;

function bytesLabel(bytes) {
  return `${(bytes / MB).toFixed(1)}MB`;
}

class ProxyMemoryLimitError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = "ProxyMemoryLimitError";
    this.statusCode = statusCode;
  }
}

function ensureBufferLimit(totalBytes, maxBytes, label) {
  if (maxBytes > 0 && totalBytes > maxBytes) {
    throw new ProxyMemoryLimitError(`${label} exceeds ${bytesLabel(maxBytes)}`);
  }
}

// ─── Responses API helpers (for GPT / Responses API models) ────────────────

const INTERNAL_INSTRUCTION_MARKER_RE = /CRITICAL\s+INSTRUCTION\s+\d+\s*:/i;
const INTERNAL_INSTRUCTION_PREFIX = "CRITICAL INSTRUCTION ";
const TEXT_PAYLOAD_KEYS = new Set(["content", "delta", "message", "output_text", "text"]);

/** GPT model names (or legacy cx/ prefix) → OpenAI Responses API instead of chat/completions */
function isGptResponsesModel(modelName) {
  const normalized = String(modelName || "").toLowerCase();
  return normalized.includes("gpt") || normalized.startsWith("cx/");
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

function createInternalInstructionSseSanitizer(maxBufferBytes = MAX_SSE_BUFFER_BYTES) {
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

function normalizeReasoningEffort(value, options = {}) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "xhigh" || raw === "x-high" || raw === "extra-high" || raw === "extra_high") return "xhigh";
  if (raw === "high") return options.preferXhigh ? "xhigh" : "high";
  if (raw === "medium" || raw === "med") return "medium";
  if (raw === "low") return "low";
  return "";
}

function inferReasoningEffort(thinkingCfg, isThinkingModel, options = {}) {
  const preferXhigh = options.preferXhigh !== false;
  if (thinkingCfg) {
    const budget = Number(thinkingCfg.thinkingBudget || 0);
    const level  = String(thinkingCfg.thinkingLevel || "").toUpperCase();
    if (level === "HIGH" || budget >= 10000) return preferXhigh ? "xhigh" : "high";
    if (level === "MEDIUM" || budget >= 4000) return "medium";
    if (level === "LOW"  || budget > 0) return "low";
    if (thinkingCfg.includeThoughts) return "medium";
  }
  return isThinkingModel ? (preferXhigh ? "xhigh" : "high") : "";
}

function adaptiveGptModelForReasoning(modelName, reasoningEffort) {
  const model = String(modelName || "").trim();
  if (!model) return model;
  return model.replace(/(^|[/@:+-])gpt-5\.5-xhigh$/i, "$1gpt-5.5");
}

function shouldUseReasoningEffort(thinkingCfg, isThinkingModel) {
  return Boolean(thinkingCfg || isThinkingModel);
}

// Kiro / AWS CodeWhisperer provider detection.
// 9router exposes Kiro-routed models under multiple prefixes depending on user config:
//   - `kr/...`         (short alias)
//   - `kiro/...`       (full provider name)
// Match both case-insensitively. Bypassing this check causes the proxy to inject
// `thinking` / `reasoning_effort` / `tools` into the upstream body, which Kiro rejects
// with HTTP 400 "Improperly formed request".
function isKiroProviderModel(modelName) {
  return /^(kr|kiro)\//i.test(String(modelName || ""));
}

// Top-level fields Kiro accepts. Anything else (reasoning_effort, thinking,
// generationConfig, tools, safetySettings, etc.) must be stripped.
const KIRO_ALLOWED_TOP_LEVEL = new Set([
  "model", "request", "contents", "messages",
  "userAgent", "stream", "system", "systemInstruction",
]);

// JSON Schema type coercion for tool parameters.
//
// Some MCP servers emit schemas where keyword values are stringified — e.g.
//   { "type": "integer", "default": "10", "minimum": "0" }
// Antigravity forwards these tools verbatim. OpenAI Codex (gpt-5.5) validates
// tool schemas in strict mode and rejects the call with:
//   "Invalid schema for function '...': '10' is not of type 'integer'"
//
// We walk the schema tree and coerce values whose JSON type does not match the
// declared `type`. This only touches schema metadata (default, enum, const,
// minimum, maximum, multipleOf, examples) — never user request payloads.
const SCHEMA_NUMERIC_KEYWORDS = new Set([
  "default", "const", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
]);
const SCHEMA_NUMERIC_LIST_KEYWORDS = new Set(["enum", "examples"]);
const SCHEMA_STRUCTURAL_KEYWORDS = new Set([
  "properties", "patternProperties", "definitions", "$defs",
]);
const SCHEMA_NESTED_LIST_KEYWORDS = new Set([
  "allOf", "anyOf", "oneOf", "prefixItems",
]);
const SCHEMA_NESTED_KEYWORDS = new Set([
  "items", "additionalProperties", "not", "if", "then", "else", "contains",
  "propertyNames", "unevaluatedItems", "unevaluatedProperties",
]);

function normalizeSchemaTypeName(value) {
  // Gemini format uses uppercase ("INTEGER", "NUMBER"); JSON Schema uses lowercase.
  return String(value || "").trim().toLowerCase();
}

function coerceScalarToSchemaType(value, type) {
  if (value === null || value === undefined) return value;
  const normalizedType = normalizeSchemaTypeName(type);

  if (normalizedType === "integer") {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      if (Number.isInteger(parsed)) return parsed;
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  }

  if (normalizedType === "number") {
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim())) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  }

  if (normalizedType === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      if (lowered === "true") return true;
      if (lowered === "false") return false;
    }
    return value;
  }

  if (normalizedType === "string") {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return value;
  }

  return value;
}

function coerceJsonSchemaTypes(node, depth = 0) {
  if (!node || depth > 32) return node;
  if (Array.isArray(node)) {
    for (const item of node) coerceJsonSchemaTypes(item, depth + 1);
    return node;
  }
  if (typeof node !== "object") return node;

  const declaredType = Array.isArray(node.type)
    ? node.type.find((t) => typeof t === "string")
    : node.type;

  if (declaredType) {
    for (const key of SCHEMA_NUMERIC_KEYWORDS) {
      if (key in node) node[key] = coerceScalarToSchemaType(node[key], declaredType);
    }
    for (const key of SCHEMA_NUMERIC_LIST_KEYWORDS) {
      if (Array.isArray(node[key])) {
        node[key] = node[key].map((item) => coerceScalarToSchemaType(item, declaredType));
      }
    }
  }

  for (const key of SCHEMA_STRUCTURAL_KEYWORDS) {
    const child = node[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      for (const propValue of Object.values(child)) coerceJsonSchemaTypes(propValue, depth + 1);
    }
  }
  for (const key of SCHEMA_NESTED_LIST_KEYWORDS) {
    if (Array.isArray(node[key])) {
      for (const item of node[key]) coerceJsonSchemaTypes(item, depth + 1);
    }
  }
  for (const key of SCHEMA_NESTED_KEYWORDS) {
    const child = node[key];
    if (child && typeof child === "object") coerceJsonSchemaTypes(child, depth + 1);
  }

  return node;
}

// Walk a request body and apply schema coercion to every tool definition.
// Supports both Gemini format (request.tools[].functionDeclarations[].parameters)
// and OpenAI format (tools[].function.parameters).
function coerceToolSchemasInBody(body) {
  if (!body || typeof body !== "object") return body;
  const requestBody = body.request && typeof body.request === "object" ? body.request : body;

  const toolBuckets = [requestBody.tools, body.tools].filter(Array.isArray);
  for (const bucket of toolBuckets) {
    for (const tool of bucket) {
      if (!tool || typeof tool !== "object") continue;
      // Gemini: { functionDeclarations: [{ name, parameters }] }
      if (Array.isArray(tool.functionDeclarations)) {
        for (const decl of tool.functionDeclarations) {
          if (decl && decl.parameters) coerceJsonSchemaTypes(decl.parameters);
        }
      }
      // OpenAI: { type: "function", function: { name, parameters } }
      if (tool.function && tool.function.parameters) {
        coerceJsonSchemaTypes(tool.function.parameters);
      }
      // Some adapters put parameters directly on the tool object.
      if (tool.parameters) coerceJsonSchemaTypes(tool.parameters);
    }
  }
  return body;
}

function sanitizeKiroRequestBody(body) {
  if (!body || typeof body !== "object") return body;
  delete body.reasoning_effort;
  delete body.thinking;

  const requestBody = body.request && typeof body.request === "object" ? body.request : body;

  if (requestBody.generationConfig) delete requestBody.generationConfig;
  if (body !== requestBody && body.generationConfig) delete body.generationConfig;
  for (const key of ["tools", "toolConfig", "tool_config", "safetySettings"]) {
    delete requestBody[key];
    if (body !== requestBody) delete body[key];
  }

  for (const key of Object.keys(body)) {
    if (!KIRO_ALLOWED_TOP_LEVEL.has(key)) delete body[key];
  }

  // 9router reads model from top-level body.model. A stale Gemini alias inside
  // request.model confuses the Kiro adapter — drop it.
  if (requestBody !== body) delete requestBody.model;

  return body;
}

function thoughtPart(text) {
  if (!text || isInternalInstructionLeak(text)) return null;
  return { thought: true, text };
}

function chatCompletionsRouterUrl(routerUrl) {
  const raw = String(routerUrl || "").trim().replace(/\/+$/, "");
  if (raw.endsWith("/chat/completions")) return raw;
  if (raw.endsWith("/responses")) return `${raw.slice(0, -"/responses".length)}/chat/completions`;
  return `${raw}/chat/completions`;
}

/**
 * Chuyển Gemini-format request body → OpenAI Responses API body.
 * Responses API dùng `input[]` thay vì `messages[]`, role "model"→"assistant".
 */
function buildResponsesApiBody(geminiBody, reasoningEffort) {
  const requestBody = geminiBody.request && typeof geminiBody.request === "object"
    ? geminiBody.request
    : geminiBody;
  const {
    contents = [],
    systemInstruction,
    generationConfig = {},
    stream,
  } = requestBody;
  const model = geminiBody.model || requestBody.model;

  const input = [];

  // System instruction
  const sysParts = systemInstruction && systemInstruction.parts;
  if (sysParts && sysParts.length) {
    const sysText = sysParts.map((p) => p.text || "").filter(Boolean).join("\n");
    if (sysText) input.push({ role: "system", content: sysText });
  }

  // Conversation turns
  for (const turn of contents) {
    const role = turn.role === "model" ? "assistant" : (turn.role || "user");
    const parts = Array.isArray(turn.parts) ? turn.parts : [];
    const content = [];
    const text = parts
      .filter((p) => typeof p.text === "string" && p.thought !== true)
      .map((p) => p.text)
      .join("");
    if (text) content.push({ type: "input_text", text });
    for (const part of parts) {
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && inlineData.data && inlineData.mimeType) {
        content.push({
          type: "input_image",
          image_url: `data:${inlineData.mimeType};base64,${inlineData.data}`,
        });
      }
    }
    if (content.length === 1 && content[0].type === "input_text") input.push({ role, content: content[0].text });
    else if (content.length > 0) input.push({ role, content });
  }

  // Keep GPT 5.5 on the regular model. Do not auto-upgrade to gpt-5.5-xhigh.
  // reasoning.summary: "detailed" bắt buộc để nhận thinking text trong response.
  const effort = normalizeReasoningEffort(reasoningEffort, { preferXhigh: true }) || "xhigh";

  const result = {
    model,
    reasoning: { effort, summary: "detailed" },
    input,
    stream: stream !== undefined ? stream : undefined,
  };

  // Do not forward Gemini maxOutputTokens to /responses. The current 9router
  // Responses adapter rejects max_output_tokens for cx/gpt-* models.

  return result;
}

/**
 * Chuyển Responses API JSON response → Gemini candidates format.
 * Dùng cho non-streaming (Antigravity gọi :generateContent không có stream).
 */
function responsesApiToGeminiJson(responsesBody) {
  const output = responsesBody.output || [];
  const parts = [];

  for (const item of output) {
    if (item.type === "reasoning") {
      // summary là mảng {type:"summary_text", text:"..."}
      for (const s of item.summary || []) {
        const part = thoughtPart(s.text);
        if (part) parts.push(part);
      }
    } else if (item.type === "message") {
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) {
          parts.push({ text: c.text });
        }
      }
    }
  }

  const usage = responsesBody.usage || {};
  return {
    candidates: [{
      content: { parts, role: "model" },
      finishReason: "STOP",
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount:     usage.input_tokens  || 0,
      candidatesTokenCount: usage.output_tokens || 0,
      totalTokenCount:      usage.total_tokens  || 0,
    },
  };
}

/**
 * Transform streaming Responses API SSE → Gemini SSE.
 * Đọc từng chunk từ response.body, parse SSE events, emit Gemini format.
 *
 * Responses API events quan tâm:
 *   response.reasoning_summary_text.delta → thought:true part
 *   response.output_text.delta            → text part
 *   response.completed                    → finishReason:STOP + [DONE]
 */
async function transformResponsesApiStream(responseBody, res) {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let outputText = "";

  async function emitGeminiText(text, finishReason) {
    if (!text) return;
    const candidate = {
      content: { parts: [{ text }], role: "model" },
    };
    if (finishReason) candidate.finishReason = finishReason;
    const chunk = JSON.stringify({
      response: {
        candidates: [candidate],
      },
    });
    await writeResponseChunk(res, `data: ${chunk}\n\n`, reader);
  }

  async function emitFinish() {
    if (finished) return;
    finished = true;
    // Buffer GPT Responses deltas into one Gemini chunk. Antigravity 1.107.0
    // can crash on empty/final-only chunks while consuming Gemini SSE. It also
    // expects an explicit stream sentinel on this internal Cloud Code path.
    await emitGeminiText(stripInternalInstructionLeaks(outputText) || " ", "STOP");
    await writeResponseChunk(res, "data: [DONE]\n\n", reader);
  }

  try {
    while (true) {
      if (res.writableEnded || res.destroyed) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      ensureBufferLimit(Buffer.byteLength(buffer), MAX_SSE_BUFFER_BYTES, "Responses API SSE buffer");

      // SSE events được phân tách bởi "\n\n"
      const events = buffer.split("\n\n");
      buffer = events.pop(); // giữ phần chưa hoàn chỉnh

      for (const event of events) {
        // Tìm dòng "data: ..."
        const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;

        const raw = dataLine.slice(5).trim();
        if (raw === "[DONE]" || raw === "null") continue;

        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }

        const type = parsed.type || "";

        if (type === "response.reasoning_summary_text.delta") {
          // Do not stream reasoning summary as Gemini thought parts. Some
          // Antigravity builds crash while consuming thought-only stream chunks.
          continue;

        } else if (type === "response.output_text.delta") {
          const delta = parsed.delta || "";
          if (delta) outputText += delta;

        } else if (type === "response.completed") {
          await emitFinish();
        }
        // Các events khác (response.created, in_progress, v.v.) → bỏ qua
      }
    }
    if (!finished && !res.writableEnded && !res.destroyed) await emitFinish();
  } finally {
    reader.releaseLock();
  }
}

function isResponseWritable(res) {
  return !res.writableEnded && !res.destroyed;
}

function writeResponseChunk(res, chunk, reader = null) {
  if (!chunk || !isResponseWritable(res)) return Promise.resolve(false);
  if (typeof res.once !== "function" || typeof res.off !== "function") {
    res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Promise.resolve(true);
  }

  return new Promise((resolve, reject) => {
    const onDrain = () => cleanup(true);
    const onClose = () => {
      if (reader && typeof reader.cancel === "function") reader.cancel().catch(() => {});
      cleanup(false);
    };
    const onError = (error) => cleanup(false, error);
    const cleanup = (ok, error) => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      if (error) reject(error);
      else resolve(ok);
    };

    res.once("close", onClose);
    res.once("error", onError);
    if (res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))) cleanup(true);
    else res.once("drain", onDrain);
  });
}

async function streamSanitizedSseResponse(responseBody, res) {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  const sseSanitizer = createInternalInstructionSseSanitizer();
  try {
    while (isResponseWritable(res)) {
      const { done, value } = await reader.read();
      if (done) break;
      const safeChunk = sseSanitizer.push(decoder.decode(value, { stream: true }));
      if (safeChunk) await writeResponseChunk(res, safeChunk, reader);
    }
    if (!isResponseWritable(res)) return;

    const decodedTail = decoder.decode();
    if (decodedTail) {
      const safeTailChunk = sseSanitizer.push(decodedTail);
      if (safeTailChunk) await writeResponseChunk(res, safeTailChunk, reader);
    }
    const tail = sseSanitizer.flush();
    if (tail) await writeResponseChunk(res, tail, reader);
    if (isResponseWritable(res)) res.end();
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedTextResponse(responseBody, maxBytes = MAX_RESPONSE_BODY_BYTES) {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let rawBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawBytes += value.byteLength;
      ensureBufferLimit(rawBytes, maxBytes, "Upstream response body");
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    return raw;
  } finally {
    reader.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function runProxy(options) {
  const targetHosts = targetHostsFrom(options);
  const cert = certPaths();

  // CRITICAL: cert files không tồn tại → crash rõ ràng thay vì ENOENT ẩn
  let sslOptions;
  try {
    sslOptions = {
      key:  fs.readFileSync(cert.keyPath),
      cert: fs.readFileSync(cert.certPath),
    };
  } catch (err) {
    throw new Error(
      `Cannot read TLS certificate files. Run setup first.\n` +
      `  key:  ${cert.keyPath}\n` +
      `  cert: ${cert.certPath}\n` +
      `  Cause: ${err.message}`
    );
  }

  const cachedTargetIPs = new Map();
  const IP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 phút – tránh stale IP khi Google rotate địa chỉ

  function pruneTargetIPCache(now = Date.now()) {
    for (const [host, cached] of cachedTargetIPs.entries()) {
      if (!cached || now - cached.ts >= IP_CACHE_TTL_MS) cachedTargetIPs.delete(host);
    }
  }

  // Resolve host → IP dùng Google Public DNS để bypass /etc/hosts của chúng ta.
  // Ưu tiên IPv4 (A record); fallback sang IPv6 (AAAA) nếu không có A record.
  async function resolveTargetIP(targetHost) {
    const cached = cachedTargetIPs.get(targetHost);
    if (cached && Date.now() - cached.ts < IP_CACHE_TTL_MS) return cached.ip;

    const resolver = new dns.Resolver();
    resolver.setServers(["8.8.8.8"]);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const resolve6 = promisify(resolver.resolve6.bind(resolver));

    let ip;
    try {
      const addresses = await resolve4(targetHost);
      if (!addresses || addresses.length === 0) throw new Error("empty A record");
      ip = addresses[0];
    } catch {
      // Không có A record – thử AAAA (Google đôi khi dùng IPv6-only endpoint)
      const addresses = await resolve6(targetHost);
      if (!addresses || addresses.length === 0) {
        throw new Error(`Cannot resolve ${targetHost}: no A or AAAA record`);
      }
      ip = addresses[0];
    }

    pruneTargetIPCache();
    cachedTargetIPs.set(targetHost, { ip, ts: Date.now() });
    return ip;
  }
  async function passthrough(req, res, bodyBuffer) {
    try {
      const requestHost = String(req.headers.host || "").split(":")[0];
      const targetHost = targetHosts.includes(requestHost) ? requestHost : primaryTargetHost(options);
      const targetIP = await resolveTargetIP(targetHost);
      const requestPath = safeRequestPath(req.url);

      const forwardReq = https.request({
        hostname: targetIP,
        port: 443,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: targetHost },
        servername: targetHost,
        rejectUnauthorized: false,
      }, (forwardRes) => {
        const collectAndSend = ({ shouldLog = false } = {}) => {
          const chunks = [];
          let total = 0;
          forwardRes.on("data", (chunk) => {
            total += chunk.length;
            if (total > MAX_PASSTHROUGH_BUFFER_BYTES) {
              forwardReq.destroy(new ProxyMemoryLimitError(`Passthrough response exceeds ${bytesLabel(MAX_PASSTHROUGH_BUFFER_BYTES)}`));
              return;
            }
            chunks.push(chunk);
          });
          forwardRes.on("end", () => {
            const raw = Buffer.concat(chunks, total);
            if (shouldLog) {
              const modelSummary = isModelBootstrapMergeRequest(req.url)
                ? summarizeAntigravityModelsResponse(raw, forwardRes.headers)
                : "";
              logPassthroughResponse({
                req,
                statusCode: forwardRes.statusCode,
                targetHost,
                requestPath,
                raw,
                headers: forwardRes.headers,
                bodyBuffer,
                extra: `bytes=${raw.length}${modelSummary ? ` ${modelSummary}` : ""}`,
              });
            }
            res.writeHead(forwardRes.statusCode, forwardRes.headers);
            res.end(raw);
          });
        };

        if (isAccountBootstrapRequest(req.url)) {
          collectAndSend({ shouldLog: true });
          return;
        }

        if (forwardRes.statusCode >= 400) {
          collectAndSend({ shouldLog: true });
          return;
        }

        logChatPassthrough({ req, bodyBuffer, statusCode: forwardRes.statusCode, targetHost, requestPath });

        res.writeHead(forwardRes.statusCode, forwardRes.headers);
        forwardRes.pipe(res);
      });

      forwardReq.on("error", (err) => {
        logProxyError({ message: `passthrough ${err.message}`, method: req.method, targetHost, requestPath });
        if (!res.headersSent) res.writeHead(502);
        res.end("Bad Gateway");
      });

      if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer);
      forwardReq.end();
    } catch (error) {
      logProxyError({ message: `passthrough ${error.message}` });
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      if (!res.writableEnded) res.end("Bad Gateway");
    }
  }

  async function intercept(req, res, bodyBuffer, mappedEntry, requestedModel) {
    try {
      let body;
      try {
        body = JSON.parse(bodyBuffer.toString());
      } catch {
        throw new Error(`Request body is not valid JSON (${bodyBuffer.length} bytes)`);
      }
      const requestBody = body.request && typeof body.request === "object" ? body.request : body;
      const originalModel = requestedModel || body.model || requestBody.model;
      if (mappedEntry && mappedEntry.model) {
        body.model = mappedEntry.model;
      } else {
        // Fallback for unmapped native Antigravity models (like claude-opus-4.7)
        // Ensure they route to valid Kiro upstream models rather than failing with 400.
        const modelLower = String(originalModel || "").toLowerCase();
        if (modelLower.includes("claude-opus-4.7") || modelLower.includes("claude-opus-4.6") || modelLower.includes("claude-opus-4-6-thinking")) {
          body.model = "kr/claude-sonnet-4.6-thinking-agentic";
        } else if (modelLower.includes("claude-sonnet-4.6") || modelLower.includes("claude-sonnet-4-6")) {
          body.model = "kr/claude-sonnet-4.6-agentic";
        } else if (modelLower.includes("claude-sonnet-4.5")) {
          body.model = "kr/claude-sonnet-4.5-agentic";
        } else if (modelLower.includes("claude-opus-4.5")) {
          body.model = "kr/claude-sonnet-4.5-thinking-agentic";
        }
      }
      if (body.request && requestBody.contents && !body.userAgent) body.userAgent = "antigravity";

      // ─── Thinking / Reasoning passthrough ───────────────────────────────────
      // Antigravity gửi thinkingConfig theo Gemini API format; proxy phải map sang
      // format mà upstream router (thường OpenAI-compatible / Anthropic) hiểu.
      // Ưu tiên: (1) config mapping có reasoning_effort → giữ nguyên
      //          (2) body có thinkingConfig → map thinkingBudget/thinkingLevel → reasoning_effort
      //          (3) model target kết thúc "-thinking" → mặc định bật thinking
      const thinkingCfg = (requestBody.generationConfig && requestBody.generationConfig.thinkingConfig)
        || (requestBody.config && requestBody.config.thinkingConfig)
        || (body.generationConfig && body.generationConfig.thinkingConfig)
        || (body.config && body.config.thinkingConfig)
        || null;
      const targetModelName = String(body.model || originalModel || "").toLowerCase();
      const isThinkingModel = targetModelName.endsWith("-thinking");

      if (shouldUseReasoningEffort(thinkingCfg, isThinkingModel)) {
        if (mappedEntry && mappedEntry.reasoning_effort) body.reasoning_effort = mappedEntry.reasoning_effort;
        if (!body.reasoning_effort) {
          body.reasoning_effort = inferReasoningEffort(thinkingCfg, isThinkingModel, { preferXhigh: true });
          if (!body.reasoning_effort) delete body.reasoning_effort;
        }
      } else {
        delete body.reasoning_effort;
      }

      if (body.reasoning_effort) {
        body.reasoning_effort = normalizeReasoningEffort(body.reasoning_effort, { preferXhigh: true }) || body.reasoning_effort;
      }

      if (body.model) {
        body.model = adaptiveGptModelForReasoning(body.model, body.reasoning_effort);
      }

      // Inject thinkingConfig vào Gemini body nếu chưa có.
      // 9router đọc field này khi translate Antigravity/Gemini format → provider format.
      // Thiếu field này → 9router không activate thinking dù model hỗ trợ.
      if (isThinkingModel && !thinkingCfg) {
        const budgetByEffort = { low: 4000, medium: 8000, high: 16000, xhigh: 24000 };
        const budget = budgetByEffort[body.reasoning_effort] || 8000;
        if (!requestBody.generationConfig) requestBody.generationConfig = {};
        requestBody.generationConfig.thinkingConfig = {
          thinkingBudget: budget,
          includeThoughts: true,
        };
      } else if (thinkingCfg && thinkingCfg.includeThoughts == null) {
        // thinkingConfig có nhưng thiếu includeThoughts → thêm vào
        thinkingCfg.includeThoughts = true;
      }

      // Thêm Anthropic-format thinking block chỉ khi model target là Claude VÀ không phải Kiro provider.
      // Kiro/AWS CodeWhisperer API không chấp nhận `thinking` hoặc `reasoning_effort` ở top-level
      // → sẽ trả về HTTP 400 "Improperly formed request" nếu inject vào.
      // 9router tự quản lý thinking cho Kiro thông qua model name (-thinking-agentic suffix).
      const targetModelLower = String(body.model || originalModel || "").toLowerCase();
      const targetIsClaudeModel = targetModelLower.includes("claude");
      const targetIsKiroProvider = isKiroProviderModel(body.model || originalModel);
      if (!body.thinking && body.reasoning_effort && targetIsClaudeModel && !targetIsKiroProvider) {
        const budgetByEffort = { low: 4000, medium: 8000, high: 16000, xhigh: 24000 };
        const explicitBudget = thinkingCfg && Number(thinkingCfg.thinkingBudget || 0);
        body.thinking = {
          type: "enabled",
          budget_tokens: explicitBudget || budgetByEffort[body.reasoning_effort] || 8000,
        };
      }
      // ── Kiro (AWS CodeWhisperer) deep sanitization ──────────────────────────
      // Kiro API strict schema: chỉ nhận messages/contents + model field.
      // Bất kỳ field lạ nào ở top-level hoặc trong generationConfig đều gây 400.
      if (targetIsKiroProvider) {
        sanitizeKiroRequestBody(body);
      }
      // ────────────────────────────────────────────────────────────────────────

      // ── MCP tool schema coercion ────────────────────────────────────────────
      // Some MCP servers emit JSON schemas with stringified numerics
      // (default: "10" instead of 10). OpenAI Codex strict mode rejects these
      // with: "Invalid schema for function '...': '10' is not of type 'integer'".
      // Coerce on every request — cheap walk, idempotent, no-op for valid schemas.
      // Skip for Kiro (already stripped tools above).
      if (!targetIsKiroProvider) {
        coerceToolSchemasInBody(body);
      }
      // ────────────────────────────────────────────────────────────────────────

      const headers = buildRouterHeaders(req.headers, options.apiKey);
      const targetModel = body.model || originalModel;

      logProxyMap({
        sourceModel: originalModel,
        targetModel,
        reasoning: body.reasoning_effort || "",
      });

      const startTime = Date.now();

      // Forward Antigravity body to 9router's chat endpoint. 9router detects
      // userAgent:"antigravity" + request.contents, then translates provider
      // output back to wrapped Antigravity SSE (`response.candidates`).
      const requestTimeoutMs = Number.isFinite(Number(options.requestTimeoutMs))
        ? Math.max(0, Number(options.requestTimeoutMs))
        : 10 * 60 * 1000;
      const controller = requestTimeoutMs > 0 ? new AbortController() : null;
      const abortUpstream = () => {
        if (res.writableEnded) return;
        if (controller && !controller.signal.aborted) {
          controller.abort(new Error("client disconnected before upstream completed"));
        }
      };
      res.on("close", abortUpstream);
      const timeoutId = controller
        ? setTimeout(() => controller.abort(new Error(`upstream request timeout after ${requestTimeoutMs}ms`)), requestTimeoutMs)
        : null;

      let response;
      try {
        response = await retryWithBackoff(
          () => fetch(chatCompletionsRouterUrl(options.routerUrl), {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller ? controller.signal : undefined,
          }),
          { maxRetries: options.maxRetries, retryDelay: options.retryDelay, retryBackoff: options.retryBackoff }
        );
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errText = await sendUpstreamErrorResponse(res, response);
        res.off("close", abortUpstream);
        logProxyError({ message: `upstream ${response.status}`, body: errText });
        return;
      }

      const contentType = response.headers.get("content-type") || "application/json";
      const responseHeaders = {
        "Content-Type": contentType,
        "Cache-Control": response.headers.get("cache-control") || "no-cache",
      };
      if (contentType.includes("text/event-stream")) {
        responseHeaders.Connection = "keep-alive";
        responseHeaders["X-Accel-Buffering"] = "no";
      }
      res.writeHead(response.status, responseHeaders);

      if (!response.body) {
        const raw = await response.text().catch(() => "");
        const safeBody = contentType.includes("json")
          ? sanitizeInternalInstructionJsonText(raw)
          : stripInternalInstructionLeaks(raw);
        res.end(safeBody);
        res.off("close", abortUpstream);
        return;
      }

      if (contentType.includes("text/event-stream")) {
        await streamSanitizedSseResponse(response.body, res);
      } else {
        const raw = await readBoundedTextResponse(response.body);
        const safeBody = contentType.includes("json")
          ? sanitizeInternalInstructionJsonText(raw)
          : stripInternalInstructionLeaks(raw);
        if (isResponseWritable(res)) res.end(safeBody);
      }

      res.off("close", abortUpstream);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logProxyOk({ model: targetModel, reasoning: body.reasoning_effort || "", elapsedSeconds: elapsed });
    } catch (error) {
      if (typeof abortUpstream === "function") res.off("close", abortUpstream);
      logProxyError({ message: error.message });
      if (!res.headersSent) res.writeHead(error.statusCode || 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message, type: "mitm_error" } }));
    }
  }

  const server = https.createServer(sslOptions, async (req, res) => {
    const requestUrl = new URL(req.url, `https://${req.headers.host || targetHosts[0]}`);
    if (req.method === "GET" && requestUrl.pathname === "/_mitm_health") {
      sendJson(res, 200, {
        ok: true,
        app: APP_NAME,
        targetHosts,
        routerUrl: options.routerUrl,
        mappedModels: Object.keys(options.modelMap || {}).length,
      });
      return;
    }

    let bodyBuffer;
    try {
      bodyBuffer = await collectBodyRaw(req, { maxBytes: MAX_REQUEST_BODY_BYTES });
    } catch (error) {
      const statusCode = error.statusCode || 413;
      logProxyError({ message: error.message, statusCode });
      if (!res.headersSent) res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message, type: "request_too_large" } }));
      return;
    }

    if (isAccountBootstrapRequest(req.url)) {
      return passthrough(req, res, bodyBuffer);
    }

    const bypassReason = bypassInterceptReason(req);
    if (bypassReason) {
      return passthrough(req, res, bodyBuffer);
    }

    const isChatRequest = isChatRequestUrl(req.url);
    if (!isChatRequest) return passthrough(req, res, bodyBuffer);

    const model = extractModelFromBody(bodyBuffer) || extractModelFromUrl(req.url);
    const modelAlias = modelAliasFromName(model);
    const effectiveEntry = getMappedEntry(model, options);

    if (!options.alwaysIntercept && !effectiveEntry) {
      return passthrough(req, res, bodyBuffer);
    }

    return intercept(req, res, bodyBuffer, effectiveEntry, model || modelAlias);
  });

  // Listen + return a handle so the caller (CLI or GUI) can control lifecycle
  // without relying on process.exit. CLI binds signal handlers itself.
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      logProxyReady({ port: options.port, routerUrl: options.routerUrl });
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port);
  });

  // Background error handler after listen (port stolen, fd issues, etc.).
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      logProxyError({ message: `port ${options.port} already in use` });
    } else if (error.code === "EACCES") {
      logProxyError({ message: `permission denied for port ${options.port}` });
    } else {
      logProxyError({ message: error.message });
    }
  });

  return {
    server,
    port: options.port,
    routerUrl: options.routerUrl,
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// Re-export proxy-helpers for backward compatibility.
const proxyHelpers = require("./helpers");

module.exports = {
  ...proxyHelpers,
  buildResponsesApiBody,
  responsesApiToGeminiJson,
  runProxy,
  chatCompletionsRouterUrl,
  isGptResponsesModel,
  isInternalInstructionLeak,
  isKiroProviderModel,
  coerceJsonSchemaTypes,
  coerceToolSchemasInBody,
  sanitizeKiroRequestBody,
  stripInternalInstructionLeaks,
  sanitizeInternalInstructionJsonText,
  createInternalInstructionSseSanitizer,
  normalizeReasoningEffort,
  inferReasoningEffort,
  adaptiveGptModelForReasoning,
  shouldUseReasoningEffort,
  transformResponsesApiStream,
};
