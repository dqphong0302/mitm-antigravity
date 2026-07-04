const dns = require("dns");
const http2 = require("http2");
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const crypto = require("crypto");

const { APP_NAME } = require("../config/constants");
const { certPaths } = require("../cert");
const { primaryTargetHost, targetHostsFrom } = require("../config");
const { collectBodyRaw, sendJson } = require("../system/http");
const { applyAntigravityIdeVersionOverride } = require("./ide-version");
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
  isAccountQuotaRequest,
  isChatRequestUrl,
  isLoopbackHost,
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
  logProxyPass,
  logProxyReady,
} = require("./logger");
const { MB, ProxyMemoryLimitError, bytesLabel } = require("./memory");
const { appendRecentRequestLog, previewJson } = require("./request-log");
const {
  createInternalInstructionSseSanitizer,
  createThinkBlockStripper,
  isInternalInstructionLeak,
  sanitizeInternalInstructionJsonText,
  stripInternalInstructionLeaks,
  stripThinkBlocks,
  stripThoughtPartsFromGeminiPayload,
} = require("./internal-instruction-sanitizer");
const {
  adaptiveGptModelForReasoning,
  inferReasoningEffort,
  normalizeReasoningEffort,
  shouldUseReasoningEffort,
} = require("./reasoning");
const { coerceJsonSchemaTypes, coerceToolSchemasInBody } = require("./schema");
const { isKiroProviderModel, sanitizeKiroRequestBody } = require("./kiro");
const {
  isResponseWritable,
  writeResponseChunk,
  streamSanitizedSseResponse,
  readBoundedTextResponse,
} = require("./stream-io");
const {
  isGptResponsesModel,
  chatCompletionsRouterUrl,
  buildResponsesApiBody,
  responsesApiToGeminiJson,
  transformResponsesApiStream,
} = require("./responses-api");
const {
  ensureFunctionCallThoughtSignaturesInContents,
  summarizeAntigravityPayload,
  syntheticThoughtSignatureForFunctionCall,
} = require("./payload");

// Normal Antigravity chat payloads are much smaller; keep guards ~1.5x larger
// than generous baseline sizes so heavy prompts breathe but bad streams cannot
// grow memory without bound.
const MAX_REQUEST_BODY_BYTES = 96 * MB;
const MAX_PASSTHROUGH_BUFFER_BYTES = 48 * MB;

// ─────────────────────────────────────────────────────────────────────────────

// ── HOST_REWRITE: bypass rate-limit 429 on PROD cloudcode-pa ─────────────────
// PROD cloudcode-pa.googleapis.com is rate-limited (429). The daily-cloudcode-pa
// (dev endpoint) accepts the same body+token. Only applied to chat endpoints;
// auth/login requests must use the original host.
const HOST_REWRITE = {
  "cloudcode-pa.googleapis.com": "daily-cloudcode-pa.googleapis.com",
};

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
  const IP_CACHE_TTL_MS = 60 * 1000; // short TTL: network changes/sleep can stale resolved Google IPs
  const PASSTHROUGH_TIMEOUT_MS = Math.max(1000, Number(process.env.MITM_PASSTHROUGH_TIMEOUT_MS || 60_000));
  const PASSTHROUGH_IDLE_TIMEOUT_MS = Math.max(1000, Number(process.env.MITM_PASSTHROUGH_IDLE_TIMEOUT_MS || 90_000));

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

    let ip;
    try {
      const addresses = await dns.promises.resolve4(targetHost);
      if (!addresses || addresses.length === 0) throw new Error("empty A record");
      ip = addresses[0];
    } catch {
      // Không có A record – thử AAAA (Google đôi khi dùng IPv6-only endpoint).
      const addresses = await dns.promises.resolve6(targetHost);
      if (!addresses || addresses.length === 0) {
        throw new Error(`Cannot resolve ${targetHost}: no A or AAAA record`);
      }
      ip = addresses[0];
    }

    pruneTargetIPCache();
    cachedTargetIPs.set(targetHost, { ip, ts: Date.now() });
    return ip;
  }

  // ── ALPN negotiation cache ──────────────────────────────────────────────────
  // Try HTTP/2 first (like browsers / mitmweb), fallback HTTP/1.1.
  // Google backend prefers HTTP/2; using H1 only may cause issues.
  const alpnCache = new Map();
  async function negotiateAlpn(host) {
    const cached = alpnCache.get(host);
    if (cached && Date.now() - cached.ts < IP_CACHE_TTL_MS) return cached.proto;
    const ip = await resolveTargetIP(host);
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: ip, port: 443, servername: host,
        ALPNProtocols: ["h2", "http/1.1"], rejectUnauthorized: false,
      }, () => {
        const proto = socket.alpnProtocol || "http/1.1";
        alpnCache.set(host, { proto, ts: Date.now() });
        socket.end();
        resolve(proto);
      });
      socket.once("error", reject);
      socket.setTimeout(5000, () => { socket.destroy(new Error("ALPN timeout")); });
    });
  }

  // ── HTTP/2 passthrough ─────────────────────────────────────────────────────
  async function passthroughHttp2(req, res, bodyForForwarding, headersForForwarding, targetHost) {
    const targetIP = await resolveTargetIP(targetHost);
    const h2Headers = {};
    for (const [k, v] of Object.entries(headersForForwarding)) {
      const lk = k.toLowerCase();
      if (lk === "host" || lk === "connection" || lk === "keep-alive" ||
          lk === "transfer-encoding" || lk === "upgrade" || lk === "proxy-connection") continue;
      h2Headers[lk] = v;
    }
    h2Headers[":method"] = req.method;
    h2Headers[":path"] = req.url;
    h2Headers[":scheme"] = "https";
    h2Headers[":authority"] = targetHost;

    return new Promise((resolve) => {
      const client = http2.connect(`https://${targetHost}`, {
        createConnection: () => tls.connect({
          host: targetIP, port: 443, servername: targetHost,
          ALPNProtocols: ["h2"], rejectUnauthorized: false,
        }),
      });
      client.once("error", (e) => {
        logProxyError({ message: `h2 client error: ${e.message}`, targetHost });
        if (!res.headersSent) res.writeHead(502);
        if (!res.writableEnded) res.end("Bad Gateway");
        try { client.close(); } catch { /* ignore */ }
        resolve();
      });

      const stream = client.request(h2Headers, { endStream: bodyForForwarding.length === 0 });
      const timeout = setTimeout(() => {
        logProxyError({ message: `h2 passthrough timeout after ${PASSTHROUGH_TIMEOUT_MS}ms`, targetHost });
        try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch { /* ignore */ }
        try { client.close(); } catch { /* ignore */ }
        if (!res.headersSent) res.writeHead(504);
        if (!res.writableEnded) res.end("Gateway Timeout");
        resolve();
      }, PASSTHROUGH_TIMEOUT_MS);
      if (typeof timeout.unref === "function") timeout.unref();
      const clearTimeoutOnce = () => clearTimeout(timeout);
      req.once("close", () => {
        try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch { /* ignore */ }
        try { client.close(); } catch { /* ignore */ }
        clearTimeoutOnce();
      });
      res.once("close", clearTimeoutOnce);
      if (bodyForForwarding.length > 0) stream.end(bodyForForwarding);

      stream.once("response", (responseHeaders) => {
        clearTimeoutOnce();
        const status = responseHeaders[":status"];
        const outHeaders = {};
        for (const [k, v] of Object.entries(responseHeaders)) {
          if (k.startsWith(":")) continue;
          if (k === "connection" || k === "keep-alive" || k === "transfer-encoding") continue;
          outHeaders[k] = v;
        }
        res.writeHead(status, outHeaders);

        stream.on("data", (chunk) => { res.write(chunk); });
        stream.setTimeout(PASSTHROUGH_IDLE_TIMEOUT_MS, () => {
          logProxyError({ message: `h2 passthrough idle timeout after ${PASSTHROUGH_IDLE_TIMEOUT_MS}ms`, targetHost });
          try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch { /* ignore */ }
          if (!res.writableEnded) res.end();
        });
        stream.on("end", () => {
          clearTimeoutOnce();
          if (!res.writableEnded) res.end();
          try { client.close(); } catch { /* ignore */ }
          resolve();
        });
      });
      stream.once("error", (e) => {
        clearTimeoutOnce();
        logProxyError({ message: `h2 stream error: ${e.message}`, targetHost });
        if (!res.headersSent) res.writeHead(502);
        if (!res.writableEnded) res.end();
        try { client.close(); } catch { /* ignore */ }
        resolve();
      });
    });
  }

  async function passthrough(req, res, bodyBuffer) {
    try {
      const hostHeader = String(req.headers.host || "").trim().toLowerCase();
      const bracketedHost = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader);
      const requestHost = bracketedHost
        ? bracketedHost[1]
        : (hostHeader === "::1" ? hostHeader : hostHeader.split(":")[0]);
      if (isLoopbackHost(requestHost)) {
        logProxyPass({
          label: "LOOPBACK PASS",
          method: req.method,
          targetHost: req.headers.host || "localhost",
          requestPath: safeRequestPath(req.url),
          extra: "reason=oauth_callback_not_proxied",
        });
        if (!res.headersSent) res.writeHead(421, { "Content-Type": "text/plain" });
        res.end("Loopback OAuth callback is not proxied. Remove localhost/127.0.0.1 from MITM DNS/proxy rules.");
        return;
      }

      // HOST_REWRITE: only rewrite host for chat endpoints — daily-cloudcode-pa
      // rejects auth/login requests but accepts chat with same body+token,
      // and the PROD endpoint is rate-limited (429).
      const originalHost = requestHost || primaryTargetHost(options);
      const isChatEndpoint = isChatRequestUrl(req.url);
      const targetHost = isChatEndpoint ? (HOST_REWRITE[originalHost] || originalHost) : originalHost;

      // Antigravity IDE version override: rewrite User-Agent + body.metadata.ideVersion
      // to a known-good version so upstream AG 2.x backend accepts the request.
      //
      // Scope to chat endpoints ONLY — same rule as HOST_REWRITE above. Auth,
      // login, and account-bootstrap handshakes (loadCodeAssist, fetchUserInfo,
      // onboardUser, listExperiments, OAuth) must carry the IDE's real version
      // identity. Forging a hardcoded version on those requests makes upstream
      // reject the session and breaks login in the IDE.
      let bodyForForwarding = bodyBuffer;
      let headersForForwarding = { ...req.headers, host: targetHost };
      if (isChatEndpoint) {
        const versionOverride = applyAntigravityIdeVersionOverride(bodyBuffer, req.headers);
        bodyForForwarding = versionOverride.bodyBuffer;
        headersForForwarding = { ...versionOverride.headers, host: targetHost };
        if (bodyForForwarding !== bodyBuffer) {
          headersForForwarding["content-length"] = String(bodyForForwarding.length);
        }
      }

      const targetIP = await resolveTargetIP(targetHost);
      const requestPath = safeRequestPath(req.url);

      // ALPN negotiate: try HTTP/2 first (like browsers/mitmweb), fallback HTTP/1.1
      try {
        const proto = await negotiateAlpn(targetHost);
        if (proto === "h2") {
          return await passthroughHttp2(req, res, bodyForForwarding, headersForForwarding, targetHost);
        }
      } catch {
        // ALPN negotiation failed — fallback to HTTP/1.1
      }

      const forwardReq = https.request({
        hostname: targetIP,
        port: 443,
        path: req.url,
        method: req.method,
        headers: headersForForwarding,
        servername: targetHost,
        rejectUnauthorized: false,
        timeout: PASSTHROUGH_TIMEOUT_MS,
      }, (forwardRes) => {
        forwardReq.setTimeout(PASSTHROUGH_IDLE_TIMEOUT_MS);
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
              const quotaSummary = isAccountQuotaRequest(req.url)
                ? `quota_response_bytes=${raw.length}`
                : "";
              logPassthroughResponse({
                req,
                statusCode: forwardRes.statusCode,
                targetHost,
                requestPath,
                raw,
                headers: forwardRes.headers,
                bodyBuffer,
                extra: `bytes=${raw.length}${modelSummary ? ` ${modelSummary}` : ""}${quotaSummary ? ` ${quotaSummary}` : ""}`,
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

      forwardReq.on("timeout", () => {
        logProxyError({ message: `passthrough timeout after ${PASSTHROUGH_IDLE_TIMEOUT_MS}ms`, method: req.method, targetHost, requestPath });
        forwardReq.destroy(new Error(`passthrough timeout after ${PASSTHROUGH_IDLE_TIMEOUT_MS}ms`));
      });
      req.once("close", () => {
        if (!forwardReq.destroyed) forwardReq.destroy(new Error("client closed passthrough request"));
      });
      forwardReq.on("error", (err) => {
        logProxyError({ message: `passthrough ${err.message}`, method: req.method, targetHost, requestPath });
        if (!res.headersSent) res.writeHead(err.message.includes("timeout") ? 504 : 502);
        if (!res.writableEnded) res.end(err.message.includes("timeout") ? "Gateway Timeout" : "Bad Gateway");
      });

      if (bodyForForwarding.length > 0) forwardReq.write(bodyForForwarding);
      forwardReq.end();
    } catch (error) {
      logProxyError({ message: `passthrough ${error.message}` });
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      if (!res.writableEnded) res.end("Bad Gateway");
    }
  }

  async function intercept(req, res, bodyBuffer, mappedEntry, requestedModel) {
    // Declared at function scope so the catch block below can detach the
    // res "close" listener even when an error is thrown after it was attached.
    // (A const inside the try block is out of scope in catch, so its cleanup
    // guard would silently never run and the listener would leak.)
    let abortUpstream = null;
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
        // Fallback for unmapped native Antigravity models.
        // Ensures they route to valid upstream models rather than failing with 400.
        const modelLower = String(originalModel || "").toLowerCase();

        // ── Claude 4.6 versioned ───────────────────────────────────────────
        if (modelLower.includes("claude-opus-4.7") || modelLower.includes("claude-opus-4.6") || modelLower.includes("claude-opus-4-6-thinking")) {
          body.model = "kr/claude-sonnet-4.6-thinking-agentic";
        } else if (modelLower.includes("claude-sonnet-4.6") || modelLower.includes("claude-sonnet-4-6")) {
          body.model = "kr/claude-sonnet-4.6-agentic";
        } else if (modelLower.includes("claude-sonnet-4.5")) {
          body.model = "kr/claude-sonnet-4.5-agentic";
        } else if (modelLower.includes("claude-opus-4.5")) {
          body.model = "kr/claude-sonnet-4.5-thinking-agentic";

        // ── Claude 4 short aliases (Antigravity 2.0) ──────────────────────
        } else if (modelLower === "claude-opus-4-thinking" || modelLower === "claude-opus-4.0-thinking") {
          body.model = "kr/claude-sonnet-4.6-thinking-agentic";
        } else if (modelLower === "claude-opus-4" || modelLower === "claude-opus-4.0") {
          body.model = "kr/claude-sonnet-4.6-agentic";
        } else if (modelLower === "claude-sonnet-4" || modelLower === "claude-sonnet-4.0") {
          body.model = "kr/claude-sonnet-4.6-agentic";

        // ── Gemini 3.5 (Antigravity 2.0 default) ──────────────────────────
        } else if (modelLower.includes("gemini-3.5-pro-thinking") || modelLower.includes("gemini-3.5-pro-high")) {
          body.model = "gemini-3.1-pro-high";
        } else if (modelLower.includes("gemini-3.5-pro")) {
          body.model = "gemini-3.1-pro-low";
        } else if (modelLower.includes("gemini-3.5-flash-extra-low")) {
          body.model = "gemini-3.5-flash-low";
        } else if (modelLower.includes("gemini-3.5-flash-thinking")) {
          body.model = "gemini-2.5-flash-thinking";
        } else if (modelLower.includes("gemini-3.5-flash")) {
          // Default model for agy 2.0 — route to gemini-3-flash (fast, no thinking overhead)
          body.model = "gemini-3-flash";
        }
      }
      // Flatten nested body.request.* fields to top-level so 9router can find them.
      // Antigravity sends { model, userAgent, request: { contents, systemInstruction, ... } }
      // but 9router's Antigravity translator reads top-level contents/systemInstruction/tools.
      // Without flattening, 9router sees messages=0 and produces empty responses.
      if (body.request && typeof body.request === "object") {
        const req_ = body.request;
        if (Array.isArray(req_.contents)       && !body.contents)          body.contents          = req_.contents;
        if (req_.systemInstruction             && !body.systemInstruction)  body.systemInstruction = req_.systemInstruction;
        if (req_.generationConfig              && !body.generationConfig)   body.generationConfig  = req_.generationConfig;
        if (Array.isArray(req_.tools)          && !body.tools)              body.tools             = req_.tools;
        if (req_.toolConfig                    && !body.toolConfig)         body.toolConfig        = req_.toolConfig;
        // Keep body.request intact — some 9router versions still read it
      }

      // Inject userAgent for both nested and flat body formats.
      const hasContents = Array.isArray(body.contents) && body.contents.length > 0;
      if (hasContents && !body.userAgent) body.userAgent = "antigravity";
      if (String(req.url || "").includes(":streamGenerateContent")) body.stream = true;

      // ─── Strip inline image data ─────────────────────────────────────────
      // Antigravity embeds generated images (base64) back into conversation history
      // nested inside functionResponse.parts[].inlineData.
      // This bloats the body to 10-50MB causing 9router to reject with 400.
      // Only strip images inside functionResponse (tool outputs / generated images).
      // Keep user-provided images (direct parts[].inlineData in user messages) intact
      // so the model can still answer questions about user-uploaded images.
      function stripGeneratedImages(contents) {
        if (!Array.isArray(contents)) return;
        for (const msg of contents) {
          if (!msg || !Array.isArray(msg.parts)) continue;
          for (let i = 0; i < msg.parts.length; i++) {
            const part = msg.parts[i];
            if (!part) continue;
            // Strip inlineData inside functionResponse (generated images from tools)
            if (part.functionResponse && part.functionResponse.parts) {
              stripInlineDataInParts(part.functionResponse.parts);
            }
            if (part.functionResponse && part.functionResponse.response && part.functionResponse.response.parts) {
              stripInlineDataInParts(part.functionResponse.response.parts);
            }
            // Strip executableCode output that contains large base64 blobs
            if (part.codeExecutionResult && part.codeExecutionResult.output
              && part.codeExecutionResult.output.length > 500000) {
              part.codeExecutionResult.output = "[large output stripped]";
            }
          }
        }
      }
      function stripInlineDataInParts(parts) {
        if (!Array.isArray(parts)) return;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (p && p.inlineData && p.inlineData.data) {
            const mime = p.inlineData.mimeType || "image/unknown";
            parts[i] = { text: `[generated image: ${mime}]` };
          }
        }
      }
      if (Array.isArray(body.contents)) stripGeneratedImages(body.contents);
      if (body.request && Array.isArray(body.request.contents)) stripGeneratedImages(body.request.contents);

      // Gemini requires every replayed model functionCall part to carry a
      // thoughtSignature when tools are enabled. Some upstream adapters omit it
      // on tool-call chunks, and Antigravity replays that history to Google on
      // the next turn. Add a deterministic surrogate so the request passes
      // Google's schema validation instead of 400'ing before proxy routing.
      const addedThoughtSignatures = ensureFunctionCallThoughtSignaturesInContents(body.contents)
        + ensureFunctionCallThoughtSignaturesInContents(body.request && body.request.contents);
      if (addedThoughtSignatures > 0) {
        logProxyPass({
          label: "PATCH",
          method: req.method,
          targetHost: req.headers.host || "unknown",
          requestPath: safeRequestPath(req.url),
          extra: `addedThoughtSignatures=${addedThoughtSignatures}`,
        });
      }
      // ────────────────────────────────────────────────────────────────────────

      // ─── Large payload passthrough (fallback) ──────────────────────────────
      // After stripping images, if body is still too large, passthrough to Google.
      const bodySize = Buffer.byteLength(JSON.stringify(body));
      const LARGE_BODY_THRESHOLD = 5 * 1024 * 1024; // 5MB
      if (bodySize > LARGE_BODY_THRESHOLD) {
        logProxyPass({
          label: "CHAT PASS",
          method: req.method,
          targetHost: req.headers.host || "unknown",
          requestPath: safeRequestPath(req.url),
          extra: `model=${originalModel} reason=large_body(${(bodySize / 1024 / 1024).toFixed(1)}MB)`,
        });
        return passthrough(req, res, bodyBuffer);
      }
      // ────────────────────────────────────────────────────────────────────────

      // ─── Thinking / Reasoning passthrough ───────────────────────────────────
      // Antigravity gửi thinkingConfig theo Gemini API format; proxy phải map sang
      // format mà upstream router (thường OpenAI-compatible / Anthropic) hiểu.
      // Ưu tiên: (1) config mapping có reasoning_effort → giữ nguyên
      //          (2) body có thinkingConfig VÀ target model là thinking model → infer reasoning_effort
      //          (3) model target kết thúc "-thinking" → mặc định bật thinking
      //
      // QUAN TRỌNG: KHÔNG forward thinkingConfig từ Antigravity IDE sang non-thinking models
      // (vd: gpt5-5-fallback → kr/claude-sonnet-4.6-agentic). Antigravity đánh dấu tất cả
      // models là supportsThinking:true nên IDE luôn gửi thinkingConfig, kể cả với models
      // không cần thinking. Nếu forward thinkingConfig tới Kiro/9router:
      //   → Kiro activate thinking → thinking leak ra chat (Bug 1)
      //   → 9router đổi code path, tools không được forward đúng format → tool calls thành text (Bug 2)
      const thinkingCfg = (requestBody.generationConfig && requestBody.generationConfig.thinkingConfig)
        || (requestBody.config && requestBody.config.thinkingConfig)
        || (body.generationConfig && body.generationConfig.thinkingConfig)
        || (body.config && body.config.thinkingConfig)
        || null;
      const targetModelName = String(body.model || originalModel || "").toLowerCase();
      // Models ending in "-thinking" OR containing "-thinking-" (e.g. kr/claude-sonnet-4.6-thinking-agentic)
      // are both considered thinking models for reasoning effort inference.
      const isThinkingModel = targetModelName.endsWith("-thinking") || targetModelName.includes("-thinking-");

      // Chỉ dùng thinkingCfg để infer reasoning_effort khi target model LÀ thinking model.
      // Với non-thinking models, chỉ cho phép reasoning_effort nếu mapping config chỉ định tường minh.
      if (mappedEntry && mappedEntry.reasoning_effort) {
        body.reasoning_effort = mappedEntry.reasoning_effort;
      } else if (shouldUseReasoningEffort(isThinkingModel ? thinkingCfg : null, isThinkingModel)) {
        const inferred = inferReasoningEffort(thinkingCfg, isThinkingModel, { preferXhigh: true });
        if (inferred) body.reasoning_effort = inferred;
        else delete body.reasoning_effort;
      } else {
        delete body.reasoning_effort;
      }

      if (body.reasoning_effort) {
        body.reasoning_effort = normalizeReasoningEffort(body.reasoning_effort, { preferXhigh: true }) || body.reasoning_effort;
      }

      if (body.model) {
        body.model = adaptiveGptModelForReasoning(body.model, body.reasoning_effort);
      }

      // Strip thinkingConfig khỏi generationConfig khi target model KHÔNG phải thinking model.
      // Antigravity IDE gửi thinkingConfig cho tất cả models (supportsThinking:true), nhưng
      // non-thinking models như gpt5-5-fallback không được phép forward field này tới 9router/Kiro.
      if (!isThinkingModel) {
        if (requestBody.generationConfig && requestBody.generationConfig.thinkingConfig) {
          delete requestBody.generationConfig.thinkingConfig;
        }
        if (body.generationConfig && body.generationConfig !== requestBody.generationConfig
            && body.generationConfig.thinkingConfig) {
          delete body.generationConfig.thinkingConfig;
        }
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
      } else if (isThinkingModel && thinkingCfg && thinkingCfg.includeThoughts == null) {
        // thinkingConfig có nhưng thiếu includeThoughts → thêm vào (chỉ cho thinking models)
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
      const routerUrl = new URL(chatCompletionsRouterUrl(options.routerUrl));

      logProxyMap({
        sourceModel: originalModel,
        targetModel,
        reasoning: body.reasoning_effort || "",
      });
      logProxyPass({
        label: "UPSTREAM",
        method: "POST",
        targetHost: routerUrl.host,
        requestPath: routerUrl.pathname,
        extra: `model=${targetModel} stream=${body.stream === true} ${summarizeAntigravityPayload(body)}`,
      });
      const requestLogEntry = {
        ts: new Date().toISOString(),
        id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString("hex"),
        sourceModel: originalModel || "",
        targetModel: targetModel || "",
        reasoning: body.reasoning_effort || "",
        method: req.method,
        url: safeRequestPath(req.url),
        stream: body.stream === true,
        bodyBytes: Buffer.byteLength(JSON.stringify(body)),
        summary: summarizeAntigravityPayload(body),
        bodyPreview: previewJson(body),
      };
      try {
        appendRecentRequestLog(requestLogEntry);
      } catch (error) {
        logProxyError({ message: `recent request log failed: ${error.message}` });
      }

      const startTime = Date.now();

      // Forward Antigravity body to 9router's chat endpoint. 9router detects
      // userAgent:"antigravity" + request.contents, then translates provider
      // output back to wrapped Antigravity SSE (`response.candidates`).
      const requestTimeoutMs = Number.isFinite(Number(options.requestTimeoutMs))
        ? Math.max(0, Number(options.requestTimeoutMs))
        : 10 * 60 * 1000;
      const controller = requestTimeoutMs > 0 ? new AbortController() : null;
      // Only abort upstream if we haven't started receiving data yet.
      // Once 9router begins streaming, we must let it finish — aborting mid-stream
      // causes Antigravity to see a truncated response and retry indefinitely.
      let upstreamStarted = false;
      abortUpstream = () => {
        if (res.writableEnded) return;
        if (upstreamStarted) return; // already streaming — don't abort
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
        logProxyPass({
          label: "UPSTREAM",
          statusCode: response.status,
          method: "POST",
          targetHost: routerUrl.host,
          requestPath: routerUrl.pathname,
          extra: `headers content-type=${response.headers.get("content-type") || "-"}`,
        });

        // Mark upstream as started — from here on, don't abort even if client closes.
        upstreamStarted = true;

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
          const streamIdleTimeoutMs = Number.isFinite(Number(options.streamIdleTimeoutMs))
            ? Math.max(0, Number(options.streamIdleTimeoutMs))
            : 2 * 60 * 1000;
          await streamSanitizedSseResponse(response.body, res, {
            idleTimeoutMs: streamIdleTimeoutMs,
            requestId: requestLogEntry.id,
            model: targetModel,
          });
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
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    } catch (error) {
      if (abortUpstream) res.off("close", abortUpstream);
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

  server.requestTimeout = Math.max(60_000, Number(process.env.MITM_SERVER_REQUEST_TIMEOUT_MS || 10 * 60 * 1000));
  server.headersTimeout = Math.max(30_000, Number(process.env.MITM_SERVER_HEADERS_TIMEOUT_MS || 65_000));
  server.keepAliveTimeout = Math.max(1000, Number(process.env.MITM_SERVER_KEEP_ALIVE_TIMEOUT_MS || 15_000));
  server.timeout = Math.max(0, Number(process.env.MITM_SERVER_SOCKET_TIMEOUT_MS || 0));
  server.on("clientError", (error, socket) => {
    logProxyError({ message: `client socket error: ${error.message}` });
    try { socket.destroy(); } catch { /* ignore */ }
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
  appendRecentRequestLog,
  previewJson,
  ensureFunctionCallThoughtSignaturesInContents,
  syntheticThoughtSignatureForFunctionCall,
  stripInternalInstructionLeaks,
  sanitizeInternalInstructionJsonText,
  createInternalInstructionSseSanitizer,
  createThinkBlockStripper,
  stripThinkBlocks,
  stripThoughtPartsFromGeminiPayload,
  normalizeReasoningEffort,
  inferReasoningEffort,
  adaptiveGptModelForReasoning,
  shouldUseReasoningEffort,
  transformResponsesApiStream,
};
