const { redactText } = require("../system/logging");
const { extractModelFromBody, extractModelFromUrl } = require("../models");
const { logProxyError, logProxyPass, logProxyRetry } = require("./logger");
const { decodeResponseBody } = require("../models/serialization");

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
const MODEL_BOOTSTRAP_URL_PATTERNS = [":fetchAvailableModels", ":fetchUserInfo", ":loadCodeAssist"];
const ACCOUNT_BOOTSTRAP_URL_PATTERNS = [
    ":fetchAdminControls",
    "/cascadeNuxes",
    ":loadCodeAssist",
    ":fetchUserInfo",
    ":fetchAvailableModels",
    ":listExperiments",
    ":onboardUser",
    ":recordTrajectoryAnalytics",
    "/agentPlugins",
];
const ACCOUNT_QUOTA_URL_PATTERNS = [
    ":retrieveUserQuota",
    ":countTokens",
    ":getQuota",
    ":checkQuota",
];
const ACCOUNT_ENTITLEMENT_URL_PATTERNS = [
    ":getEntitlements",
    ":getUserEntitlements",
];
const ACCOUNT_PASSTHROUGH_URL_PATTERNS = [
    ...ACCOUNT_BOOTSTRAP_URL_PATTERNS,
    ...ACCOUNT_QUOTA_URL_PATTERNS,
    ...ACCOUNT_ENTITLEMENT_URL_PATTERNS,
];

function urlIncludesAny(reqUrl, patterns) {
    const value = String(reqUrl || "");
    return patterns.some((pattern) => value.includes(pattern));
}

function isChatRequestUrl(reqUrl) {
    return urlIncludesAny(reqUrl, CHAT_URL_PATTERNS);
}

function isFetchAvailableModelsRequest(reqUrl) {
    return urlIncludesAny(reqUrl, [":fetchAvailableModels"]);
}

function isFetchUserInfoRequest(reqUrl) {
    return urlIncludesAny(reqUrl, [":fetchUserInfo"]);
}

function isLoadCodeAssistRequest(reqUrl) {
    return urlIncludesAny(reqUrl, [":loadCodeAssist"]);
}

function isModelBootstrapMergeRequest(reqUrl) {
    return urlIncludesAny(reqUrl, MODEL_BOOTSTRAP_URL_PATTERNS);
}

function isAccountBootstrapRequest(reqUrl) {
    return urlIncludesAny(reqUrl, ACCOUNT_PASSTHROUGH_URL_PATTERNS);
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

function logPassthroughResponse({ req, statusCode, targetHost, requestPath, raw, headers, bodyBuffer, extra = "" }) {
    if (statusCode >= 400) {
        const model = isChatRequestUrl(req && req.url)
            ? (extractModelFromBody(bodyBuffer) || extractModelFromUrl(req.url) || "unknown")
            : "";
        logProxyError({
            message: model ? `passthrough failed model=${model}` : "passthrough failed",
            statusCode,
            method: req.method,
            targetHost,
            requestPath,
            body: responseBodySnippetForLog(raw, headers) || "-",
        });
        return;
    }

    if (isAccountBootstrapRequest(req && req.url)) {
        logProxyPass({
            label: passthroughLogLabel(req.url),
            statusCode,
            method: req.method,
            targetHost,
            requestPath,
            extra,
        });
    }
}

function logChatPassthrough({ req, bodyBuffer, statusCode, targetHost, requestPath }) {
    if (!isChatRequestUrl(req && req.url)) return;
    const model = extractModelFromBody(bodyBuffer) || extractModelFromUrl(req.url) || "unknown";
    logProxyPass({
        label: "CHAT PASS",
        statusCode,
        method: req.method,
        targetHost,
        requestPath,
        extra: `model=${model}`,
    });
}

function isRetryableUpstreamStatus(statusCode) {
    return [408, 429, 502, 503, 504, 524].includes(Number(statusCode));
}

function routerErrorBody(statusCode, bodyText) {
    const fallback = bodyText || `Upstream ${statusCode}`;
    try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed === "object") return parsed;
    } catch {
        // Non-JSON upstream errors, such as Cloudflare HTML 524 pages, are wrapped below.
    }
    return {
        error: {
            message: fallback,
            type: "upstream_error",
            status: Number(statusCode),
        },
    };
}

async function sendUpstreamErrorResponse(res, response) {
    const statusCode = response.status || 502;
    const bodyText = await response.text().catch(() => "");
    const payload = routerErrorBody(statusCode, bodyText);
    if (!res.headersSent) {
        res.writeHead(statusCode, {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
        });
    }
    if (!res.writableEnded) res.end(JSON.stringify(payload));
    return bodyText;
}

function isClientAbortError(error) {
    if (!error) return false;
    // AbortController.abort() throws an Error whose name is "AbortError" in
    // node's fetch impl. We also flag explicit "client disconnected ..."
    // strings we set ourselves in the proxy.
    if (error.name === "AbortError") return true;
    if (error.code === "ABORT_ERR") return true;
    const msg = String(error.message || "").toLowerCase();
    return msg.includes("client disconnected") || msg.includes("aborted");
}

async function retryWithBackoff(fetchFn, options) {
    // Guard NaN – nếu config invalid thì dùng safe defaults
    const maxRetries  = Number.isFinite(Number(options.maxRetries))  ? Math.max(0, Number(options.maxRetries))  : 0;
    const retryDelay  = Number.isFinite(Number(options.retryDelay))  ? Math.max(0, Number(options.retryDelay))  : 1000;
    const retryBackoff = Number.isFinite(Number(options.retryBackoff)) && Number(options.retryBackoff) > 0
      ? Number(options.retryBackoff) : 1;
    let lastError;
    let lastResponse;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetchFn();
            lastResponse = response;

            if (!response.ok && isRetryableUpstreamStatus(response.status)) {
                if (attempt < maxRetries) {
                    const waitMs = retryDelay * Math.pow(retryBackoff, attempt);
                    logProxyRetry({
                        attempt: attempt + 1,
                        maxRetries,
                        status: response.status,
                        waitMs,
                    });
                    if (response.body && typeof response.body.cancel === "function") {
                        await response.body.cancel().catch(() => {});
                    }
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                    continue;
                }
            }

            return response;
        } catch (error) {
            lastError = error;
            // Client already disconnected – nobody is reading the response.
            // Retrying just burns provider quota and produces ghost successful
            // calls on 9router with output=0. Surface the error immediately so
            // the proxy can clean up and the next request can proceed.
            if (isClientAbortError(error)) {
                throw error;
            }
            if (attempt < maxRetries) {
                const waitMs = retryDelay * Math.pow(retryBackoff, attempt);
                logProxyRetry({
                    attempt: attempt + 1,
                    maxRetries,
                    message: error.message,
                    waitMs,
                });
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
        }
    }

    if (lastResponse) return lastResponse;
    throw lastError || new Error('Max retries exceeded');
}

module.exports = {
    buildRouterHeaders,
    bypassInterceptReason,
    isAccountBootstrapRequest,
    isChatRequestUrl,
    isClientAbortError,
    isFetchAvailableModelsRequest,
    isFetchUserInfoRequest,
    isLoadCodeAssistRequest,
    isModelBootstrapMergeRequest,
    isRetryableUpstreamStatus,
    logChatPassthrough,
    logPassthroughResponse,
    passthroughLogLabel,
    responseBodySnippetForLog,
    retryWithBackoff,
    routerErrorBody,
    safeRequestPath,
    sendUpstreamErrorResponse,
    shouldBypassIntercept,
};
