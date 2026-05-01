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

// ─── Responses API helpers (for GPT / Responses API models) ────────────────

/** GPT model names (or legacy cx/ prefix) → OpenAI Responses API instead of chat/completions */
function isGptResponsesModel(modelName) {
  const normalized = String(modelName || "").toLowerCase();
  return normalized.includes("gpt") || normalized.startsWith("cx/");
}

function isInternalInstructionLeak(text) {
  return /(^|\n)\s*CRITICAL INSTRUCTION\s+\d+:/i.test(String(text || ""));
}

function stripInternalInstructionLeaks(text) {
  return String(text || "")
    .replace(/(^|[;\n]\s*)CRITICAL INSTRUCTION\s+\d+:.*?(?=;|\n\s*(?:data:|\{|\[DONE\])|$)/gis, "$1")
    .replace(/;?\s*CRITICAL INSTRUCTION\s+\d+:.*?(?=;|$)/gis, "")
    .replace(/^(?:\s*;\s*)+/, "")
    .trimStart();
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

  function emitGeminiText(text, finishReason) {
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
    res.write(`data: ${chunk}\n\n`);
  }

  function emitFinish() {
    if (finished) return;
    finished = true;
    // Buffer GPT Responses deltas into one Gemini chunk. Antigravity 1.107.0
    // can crash on empty/final-only chunks while consuming Gemini SSE. It also
    // expects an explicit stream sentinel on this internal Cloud Code path.
    emitGeminiText(stripInternalInstructionLeaks(outputText) || " ", "STOP");
    res.write("data: [DONE]\n\n");
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

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
          emitFinish();
        }
        // Các events khác (response.created, in_progress, v.v.) → bỏ qua
      }
    }
    if (!finished) emitFinish();
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
        if (isModelBootstrapMergeRequest(req.url)) {
          const chunks = [];
          forwardRes.on("data", (chunk) => chunks.push(chunk));
          forwardRes.on("end", () => {
            const raw = Buffer.concat(chunks);
            const modelSummary = summarizeAntigravityModelsResponse(raw, forwardRes.headers);
            logPassthroughResponse({
              req,
              statusCode: forwardRes.statusCode,
              targetHost,
              requestPath,
              raw,
              headers: forwardRes.headers,
              extra: `bytes=${raw.length} ${modelSummary}`,
            });
            res.writeHead(forwardRes.statusCode, forwardRes.headers);
            res.end(raw);
          });
          return;
        }

        if (forwardRes.statusCode >= 400) {
          const chunks = [];
          forwardRes.on("data", (chunk) => chunks.push(chunk));
          forwardRes.on("end", () => {
            const raw = Buffer.concat(chunks);
            logPassthroughResponse({
              req,
              statusCode: forwardRes.statusCode,
              targetHost,
              requestPath,
              raw,
              headers: forwardRes.headers,
              extra: `bytes=${raw.length}`,
            });
            res.writeHead(forwardRes.statusCode, forwardRes.headers);
            res.end(raw);
          });
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
      if (mappedEntry && mappedEntry.model) body.model = mappedEntry.model;
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

      // Thêm Anthropic-format thinking block chỉ khi model target là Claude.
      // GPT / Gemini chỉ cần reasoning_effort — thêm thinking block cho GPT sẽ gây 400.
      const targetIsClaudeModel = String(body.model || originalModel || "").toLowerCase().includes("claude");
      if (!body.thinking && body.reasoning_effort && targetIsClaudeModel) {
        const budgetByEffort = { low: 4000, medium: 8000, high: 16000, xhigh: 24000 };
        const explicitBudget = thinkingCfg && Number(thinkingCfg.thinkingBudget || 0);
        body.thinking = {
          type: "enabled",
          budget_tokens: explicitBudget || budgetByEffort[body.reasoning_effort] || 8000,
        };
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
      const response = await retryWithBackoff(
        () => fetch(chatCompletionsRouterUrl(options.routerUrl), {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
        { maxRetries: options.maxRetries, retryDelay: options.retryDelay, retryBackoff: options.retryBackoff }
      );

      if (!response.ok) {
        const errText = await sendUpstreamErrorResponse(res, response);
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
        res.end(stripInternalInstructionLeaks(await response.text().catch(() => "")));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        const chunk = decoder.decode(value, { stream: true });
        const safeChunk = stripInternalInstructionLeaks(chunk);
        if (safeChunk) res.write(Buffer.from(safeChunk));
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logProxyOk({ model: targetModel, reasoning: body.reasoning_effort || "", elapsedSeconds: elapsed });
    } catch (error) {
      logProxyError({ message: error.message });
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
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

    const bodyBuffer = await collectBodyRaw(req);

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

  server.listen(options.port, () => {
    logProxyReady({ port: options.port, routerUrl: options.routerUrl });
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      logProxyError({ message: `port ${options.port} already in use` });
    } else if (error.code === "EACCES") {
      logProxyError({ message: `permission denied for port ${options.port}` });
    } else {
      logProxyError({ message: error.message });
    }
    process.exit(1);
  });

  process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
  process.on("SIGINT", () => { server.close(() => process.exit(0)); });
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
  stripInternalInstructionLeaks,
  normalizeReasoningEffort,
  inferReasoningEffort,
  adaptiveGptModelForReasoning,
  shouldUseReasoningEffort,
  transformResponsesApiStream,
};
