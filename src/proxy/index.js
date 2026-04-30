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

async function runProxy(options) {
  const targetHosts = targetHostsFrom(options);
  const cert = certPaths();
  const sslOptions = {
    key: fs.readFileSync(cert.keyPath),
    cert: fs.readFileSync(cert.certPath),
  };

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
      ip = addresses[0];
    } catch {
      // Không có A record – thử AAAA (Google đôi khi dùng IPv6-only endpoint)
      const addresses = await resolve6(targetHost);
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
      const originalModel = requestedModel || body.model;
      if (mappedEntry && mappedEntry.model) body.model = mappedEntry.model;
      if (mappedEntry && mappedEntry.reasoning_effort) body.reasoning_effort = mappedEntry.reasoning_effort;

      const headers = buildRouterHeaders(req.headers, options.apiKey);
      const targetModel = body.model || originalModel;
      const reasoning = body.reasoning_effort || "";

      logProxyMap({
        sourceModel: originalModel,
        targetModel,
        reasoning,
      });

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
      logProxyOk({ model: targetModel, reasoning, elapsedSeconds: elapsed });
      // elapsed đã được ghi trong logProxyOk – không log thêm error cho slow response vì đây không phải lỗi thực sự
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
  runProxy,
};
