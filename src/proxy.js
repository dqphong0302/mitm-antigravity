const dns = require("dns");
const https = require("https");
const fs = require("fs");
const { promisify } = require("util");

const { ANTIGRAVITY_ALIASES, APP_NAME, DEFAULT_TARGET } = require("./constants");
const { certPaths } = require("./cert");
const { primaryTargetHost, targetHostsFrom } = require("./config");
const { collectBodyRaw, sendJson } = require("./http");
const { redactText } = require("./logging");
const {
  decodeResponseBody,
  extractModelFromBody,
  extractModelFromUrl,
  getMappedEntry,
  mergeAntigravityModelListPayload,
  mergeCascadeModelConfigsInPayload,
  modelAliasFromName,
  summarizeAntigravityModelsResponse,
  summarizeCascadeModelConfigs,
  summarizeRequestBodyForLog,
} = require("./models");

const ROUTER_STRIP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "content-type",
  "authorization",
  "x-9router-source",
  "x-request-source",
]);

const CHAT_URL_PATTERNS = [":generateContent", ":streamGenerateContent"];
const ACCOUNT_BOOTSTRAP_PATTERNS = [
  ":fetchAdminControls",
  "/cascadeNuxes",
  ":loadCodeAssist",
  ":fetchUserInfo",
  ":fetchAvailableModels",
  "/agentPlugins",
];
const ANTIGRAVITY_ALIAS_SET = new Set(ANTIGRAVITY_ALIASES);

function isChatRequestUrl(reqUrl) {
  return CHAT_URL_PATTERNS.some((pattern) => String(reqUrl || "").includes(pattern));
}

function isFetchAvailableModelsRequest(reqUrl) {
  return String(reqUrl || "").includes(":fetchAvailableModels");
}

function isFetchUserInfoRequest(reqUrl) {
  return String(reqUrl || "").includes(":fetchUserInfo");
}

function isAccountBootstrapRequest(reqUrl) {
  const value = String(reqUrl || "");
  return ACCOUNT_BOOTSTRAP_PATTERNS.some((pattern) => value.includes(pattern));
}

function buildRouterHeaders(clientHeaders, apiKey) {
  const headers = { "Content-Type": "application/json" };
  for (const [key, value] of Object.entries(clientHeaders || {})) {
    if (ROUTER_STRIP_HEADERS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) headers[key] = value.join(", ");
    else if (typeof value !== "undefined") headers[key] = String(value);
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function shouldBypassIntercept(req) {
  return Boolean(bypassInterceptReason(req));
}

function bypassInterceptReason(req) {
  const compatibilitySource = String(req.headers["x-9router-source"] || "").toLowerCase();
  if (compatibilitySource === "9router") return "x-9router-source=9router";
  return "";
}

function safeRequestPath(reqUrl) {
  try {
    return new URL(reqUrl, "https://local.invalid").pathname;
  } catch {
    return String(reqUrl || "").split("?")[0];
  }
}

function responseBodySnippetForLog(raw, headers = {}) {
  try {
    const decoded = decodeResponseBody(raw, headers).toString("utf8");
    const compact = redactText(decoded).replace(/\s+/g, " ").trim();
    return compact.length > 1600 ? `${compact.slice(0, 1600)}...` : compact;
  } catch (error) {
    return `unreadable=${error.message} bytes=${raw.length}`;
  }
}

function passthroughLogLabel(reqUrl) {
  if (isFetchAvailableModelsRequest(reqUrl)) return "AUTH MODELS";
  if (isAccountBootstrapRequest(reqUrl)) return "AUTH PASS";
  if (isChatRequestUrl(reqUrl)) return "CHAT PASS";
  return "PASS";
}

function logPassthroughResponse({ req, statusCode, targetHost, requestPath, raw, headers, extra = "" }) {
  const label = passthroughLogLabel(req.url);
  const suffix = extra ? ` ${extra}` : "";
  const base = `${label} ${statusCode} ${req.method} ${targetHost}${requestPath}${suffix}`;
  if (statusCode >= 400) {
    console.error(`${base} errorBody=${responseBodySnippetForLog(raw, headers) || "-"}`);
  } else {
    console.log(base);
  }
}

async function retryWithBackoff(fetchFn, options) {
  const maxRetries = Number(options.maxRetries || 0);
  const retryDelay = Number(options.retryDelay || 1000);
  const retryBackoff = Number(options.retryBackoff || 1);
  let lastError;
  let lastResponse;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchFn();
      lastResponse = response;

      // If response is not ok and it's a 503, retry
      if (!response.ok && (response.status === 503 || response.status === 502 || response.status === 504)) {
        if (attempt < maxRetries) {
          const waitMs = retryDelay * Math.pow(retryBackoff, attempt);
          console.log(`Retry ${attempt + 1}/${maxRetries} after HTTP ${response.status} (waiting ${(waitMs / 1000).toFixed(1)}s)...`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
          continue;
        }
      }

      // Success or non-503 error - return response
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const waitMs = retryDelay * Math.pow(retryBackoff, attempt);
        console.log(`Retry ${attempt + 1}/${maxRetries} after error (waiting ${(waitMs / 1000).toFixed(1)}s)...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }

  // All retries exhausted - return the last response or throw error
  if (lastResponse) return lastResponse;
  throw lastError || new Error('Max retries exceeded');
}

async function runProxy(options) {
  const targetHosts = targetHostsFrom(options);
  const cert = certPaths();
  const sslOptions = {
    key: fs.readFileSync(cert.keyPath),
    cert: fs.readFileSync(cert.certPath),
  };

  const cachedTargetIPs = new Map();
  async function resolveTargetIP(targetHost) {
    if (cachedTargetIPs.has(targetHost)) return cachedTargetIPs.get(targetHost);
    const resolver = new dns.Resolver();
    resolver.setServers(["8.8.8.8"]);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(targetHost);
    cachedTargetIPs.set(targetHost, addresses[0]);
    return addresses[0];
  }

  async function passthrough(req, res, bodyBuffer) {
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
      if (isFetchAvailableModelsRequest(req.url) || isFetchUserInfoRequest(req.url)) {
        const chunks = [];
        forwardRes.on("data", (chunk) => chunks.push(chunk));
        forwardRes.on("end", () => {
          const raw = Buffer.concat(chunks);
          const modelSummary = summarizeAntigravityModelsResponse(raw, forwardRes.headers);

          if (options.mockModelList !== true || forwardRes.statusCode < 200 || forwardRes.statusCode >= 300) {
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
            return;
          }

          try {
            const decoded = decodeResponseBody(raw, forwardRes.headers);
            const upstreamPayload = decoded.length > 0 ? JSON.parse(decoded.toString("utf8")) : {};
            const isModelList = isFetchAvailableModelsRequest(req.url);
            const merged = isModelList
              ? mergeAntigravityModelListPayload(upstreamPayload, options)
              : mergeCascadeModelConfigsInPayload(upstreamPayload, options);
            const payload = Buffer.from(JSON.stringify(merged.payload));
            const headers = {
              ...forwardRes.headers,
              "content-type": "application/json; charset=utf-8",
              "content-length": String(payload.length),
            };
            delete headers["content-encoding"];
            delete headers["transfer-encoding"];
            if (isModelList) {
              console.log(`AUTH MODELS+MERGE ${forwardRes.statusCode} ${req.method} ${targetHost}${requestPath} upstream=${merged.existingCount} added=${merged.added.length} total=${merged.totalCount} aliases=${merged.added.join(",") || "-"}`);
            } else {
              console.log(`AUTH USER+MODELS ${forwardRes.statusCode} ${req.method} ${targetHost}${requestPath} added=${merged.added.length} labels=${merged.added.join(",") || "-"} ${summarizeCascadeModelConfigs(merged.payload)}`);
            }
            res.writeHead(forwardRes.statusCode, headers);
            res.end(payload);
          } catch (error) {
            console.error(`Model config merge failed; passing upstream response unchanged: ${error.message}`);
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
          }
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

      console.log(`${passthroughLogLabel(req.url)} ${forwardRes.statusCode} ${req.method} ${targetHost}${requestPath}`);
      res.writeHead(forwardRes.statusCode, forwardRes.headers);
      forwardRes.pipe(res);
    });

    forwardReq.on("error", (err) => {
      console.error(`Passthrough error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end("Bad Gateway");
    });

    if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer);
    forwardReq.end();
  }

  async function intercept(req, res, bodyBuffer, mappedEntry, requestedModel) {
    try {
      const body = JSON.parse(bodyBuffer.toString());
      const originalModel = requestedModel || body.model;
      if (mappedEntry && mappedEntry.model) body.model = mappedEntry.model;
      if (mappedEntry && mappedEntry.reasoning_effort) body.reasoning_effort = mappedEntry.reasoning_effort;

      const headers = buildRouterHeaders(req.headers, options.apiKey);

      const startTime = Date.now();
      const response = await retryWithBackoff(
        () => fetch(options.routerUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
        {
          maxRetries: options.maxRetries,
          retryDelay: options.retryDelay,
          retryBackoff: options.retryBackoff,
        }
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Upstream ${response.status}: ${errText}`);
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
        res.end(await response.text().catch(() => ""));
        return;
      }

      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(Buffer.from(value));
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const loggedModel = mappedEntry && mappedEntry.model ? mappedEntry.model : originalModel;
      const reasoning = mappedEntry && mappedEntry.reasoning_effort ? ` reasoning_effort=${mappedEntry.reasoning_effort}` : "";
      console.log(`OK ${loggedModel || "unknown"}${reasoning} - ${elapsed}s`);
    } catch (error) {
      console.error(`ERROR ${error.message}`);
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
      if (isFetchAvailableModelsRequest(req.url)) {
        console.log(`AUTH MODELS ${req.method} ${String(req.headers.host || "").split(":")[0]}${safeRequestPath(req.url)} -> passthrough${options.mockModelList === true ? "+merge" : ""}`);
      }
      return passthrough(req, res, bodyBuffer);
    }

    const bypassReason = bypassInterceptReason(req);
    if (bypassReason) {
      console.log(`BYPASS ${req.method} ${String(req.headers.host || "").split(":")[0]}${safeRequestPath(req.url)} reason=${bypassReason}`);
      return passthrough(req, res, bodyBuffer);
    }

    const isChatRequest = isChatRequestUrl(req.url);
    if (!isChatRequest) return passthrough(req, res, bodyBuffer);

    const model = extractModelFromBody(bodyBuffer) || extractModelFromUrl(req.url);
    const modelAlias = modelAliasFromName(model);
    const mappedEntry = getMappedEntry(model, options);
    let effectiveEntry = mappedEntry;

    if (!effectiveEntry && options.modelPrefix && modelAlias && !ANTIGRAVITY_ALIAS_SET.has(modelAlias)) {
      effectiveEntry = { model: `${options.modelPrefix}${modelAlias}` };
    }

    if (!options.alwaysIntercept && !effectiveEntry) {
      console.log(`CHAT PASS unmapped model=${model || "unknown"} ${String(req.headers.host || "").split(":")[0]}${safeRequestPath(req.url)} ${summarizeRequestBodyForLog(bodyBuffer)}`);
      return passthrough(req, res, bodyBuffer);
    }

    const effectiveModel = effectiveEntry && effectiveEntry.model;
    if (effectiveModel) {
      const reasoning = effectiveEntry.reasoning_effort ? ` + reasoning_effort=${effectiveEntry.reasoning_effort}` : "";
      const modelText = modelAlias && modelAlias !== model ? `${model} (${modelAlias})` : model;
      console.log(`${modelText || "unknown"} -> ${effectiveModel}${reasoning}`);
    } else console.log(`${model || "unknown"} -> (no mapping)`);

    return intercept(req, res, bodyBuffer, effectiveEntry, model || modelAlias);
  });

  server.listen(options.port, () => {
    console.log(`MITM ready on :${options.port} -> ${options.routerUrl}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${options.port} already in use`);
    } else if (error.code === "EACCES") {
      console.error(`Permission denied for port ${options.port}`);
    } else {
      console.error(error.message);
    }
    process.exit(1);
  });

  process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
  process.on("SIGINT", () => { server.close(() => process.exit(0)); });
}

module.exports = {
  bypassInterceptReason,
  buildRouterHeaders,
  isAccountBootstrapRequest,
  isChatRequestUrl,
  isFetchAvailableModelsRequest,
  retryWithBackoff,
  runProxy,
  safeRequestPath,
  shouldBypassIntercept,
};
