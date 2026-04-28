const { redactText } = require("./logging");
const { logProxyError, logProxyRetry } = require("./proxy-logger");
const { decodeResponseBody } = require("./model-serialization");

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

            if (!response.ok && (response.status === 503 || response.status === 502 || response.status === 504)) {
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
    logPassthroughResponse,
    passthroughLogLabel,
    responseBodySnippetForLog,
    retryWithBackoff,
    safeRequestPath,
    shouldBypassIntercept,
};
