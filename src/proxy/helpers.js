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
const ACCOUNT_BOOTSTRAP_PATTERNS = [
    ":fetchAdminControls",
    "/cascadeNuxes",
    ":loadCodeAssist",
    ":fetchUserInfo",
    ":fetchAvailableModels",
    "/agentPlugins",
];

function isChatRequestUrl(reqUrl) {
    return CHAT_URL_PATTERNS.some((pattern) => String(reqUrl || "").includes(pattern));
}

function isFetchAvailableModelsRequest(reqUrl) {
    return String(reqUrl || "").includes(":fetchAvailableModels");
}

function isFetchUserInfoRequest(reqUrl) {
    return String(reqUrl || "").includes(":fetchUserInfo");
}

function isLoadCodeAssistRequest(reqUrl) {
    return String(reqUrl || "").includes(":loadCodeAssist");
}

function isModelBootstrapMergeRequest(reqUrl) {
    return isFetchAvailableModelsRequest(reqUrl)
        || isFetchUserInfoRequest(reqUrl)
        || isLoadCodeAssistRequest(reqUrl);
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

function logPassthroughResponse({ req, statusCode, targetHost, requestPath, raw, headers }) {
    if (statusCode >= 400) {
        logProxyError({
            message: "passthrough failed",
            statusCode,
            method: req.method,
            targetHost,
            requestPath,
            body: responseBodySnippetForLog(raw, headers) || "-",
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

            if (!response.ok && isRetryableUpstreamStatus(response.status)) {
                if (attempt < maxRetries) {
                    const waitMs = retryDelay * Math.pow(retryBackoff, attempt);
                    logProxyRetry({
                        attempt: attempt + 1,
                        maxRetries,
                        status: response.status,
                        waitMs,
                    });
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                    continue;
                }
            }

            return response;
        } catch (error) {
            lastError = error;
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
