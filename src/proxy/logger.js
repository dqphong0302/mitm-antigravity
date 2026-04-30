const { redactText } = require("../system/logging");

function compactTime(date = new Date()) {
    return date.toISOString().slice(11, 19);
}

function compactValue(value) {
    if (value === null || typeof value === "undefined" || value === "") return "-";
    const text = redactText(String(value)).replace(/\s+/g, " ").trim();
    if (!text) return "-";
    return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function compactTarget(host, requestPath) {
    const safeHost = compactValue(host);
    const safePath = compactValue(requestPath || "/");
    return `${safeHost}:${safePath}`;
}

function writeProxyLog(level, message) {
    const line = `${compactTime()} ${String(level || "INFO").toUpperCase()} ${message}`;
    if (String(level || "").toUpperCase() === "ERR") console.error(line);
    else console.log(line);
}

function logProxyReady({ port, routerUrl }) {
    writeProxyLog("READY", `:${port} -> ${compactValue(routerUrl)}`);
}

function logProxyPass({ label = "PASS", statusCode, method, targetHost, requestPath, extra = "" }) {
    const status = statusCode || "-";
    const suffix = extra ? ` ${compactValue(extra)}` : "";
    writeProxyLog(label, `${status} ${method || "-"} ${compactTarget(targetHost, requestPath)}${suffix}`);
}

function logProxyMap({ sourceModel, targetModel, reasoning }) {
    const suffix = reasoning ? ` reason=${compactValue(reasoning)}` : "";
    writeProxyLog("MAP", `${compactValue(sourceModel || "unknown")} -> ${compactValue(targetModel || "no mapping")}${suffix}`);
}

function logProxyOk({ model, reasoning, elapsedSeconds }) {
    const suffix = reasoning ? ` reason=${compactValue(reasoning)}` : "";
    writeProxyLog("OK", `${compactValue(model || "unknown")} ${elapsedSeconds || "-"}s${suffix}`);
}

function logProxyRetry({ attempt, maxRetries, status, message, waitMs }) {
    const reason = status ? `http=${status}` : `msg=${compactValue(message)}`;
    writeProxyLog("RETRY", `${attempt}/${maxRetries} ${reason} wait=${((waitMs || 0) / 1000).toFixed(1)}s`);
}

function logProxyError({ message, statusCode, method, targetHost, requestPath, body }) {
    const prefix = statusCode ? `${statusCode} ${method || "-"} ${compactTarget(targetHost, requestPath)}` : "";
    const bodyText = body ? ` body=${compactValue(body)}` : "";
    writeProxyLog("ERR", `${prefix ? `${prefix} ` : ""}msg=${compactValue(message)}${bodyText}`);
}

module.exports = {
    compactTarget,
    compactTime,
    compactValue,
    logProxyError,
    logProxyMap,
    logProxyOk,
    logProxyPass,
    logProxyReady,
    logProxyRetry,
};
