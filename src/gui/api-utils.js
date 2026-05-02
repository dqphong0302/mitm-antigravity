const crypto = require("crypto");

const { sendJson } = require("../system/http");
const { appendLog, errorMeta, logPaths } = require("../system/logging");

function requestId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sendHtml(res, html) {
    res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(html);
}

function sendNotFound(res) {
    sendJson(res, 404, { error: "Not found" });
}

function sendApiError(req, res, error) {
    const id = requestId();
    appendLog("error", "GUI API request failed", errorMeta(error, {
        requestId: id,
        method: req.method,
        path: req.url,
    }));
    sendJson(res, 500, {
        error: error.message || String(error),
        requestId: id,
        logPaths: logPaths(),
    });
}

module.exports = {
    requestId,
    sendApiError,
    sendHtml,
    sendNotFound,
};
