"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { redact } = require("../system/logging");

const RECENT_REQUEST_LOG_PATH = process.env.MITM_RECENT_REQUEST_LOG
  || path.join(os.tmpdir(), "mitm-antigravity-recent-requests.json");
const RECENT_REQUEST_LOG_LIMIT = Math.max(1, Number(process.env.MITM_RECENT_REQUEST_LOG_LIMIT || 10));
const RECENT_REQUEST_BODY_PREVIEW_BYTES = Math.max(0, Number(process.env.MITM_RECENT_REQUEST_BODY_PREVIEW_BYTES || 20000));

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return fallback;
  }
}

function previewJson(value, maxBytes = RECENT_REQUEST_BODY_PREVIEW_BYTES) {
  if (maxBytes <= 0) return undefined;
  let text;
  try {
    text = JSON.stringify(redact(value));
  } catch {
    text = "[unserializable]";
  }
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return { truncated: false, bytes: buffer.length, json: text };
  return {
    truncated: true,
    bytes: buffer.length,
    json: buffer.subarray(0, maxBytes).toString("utf8"),
  };
}

function appendRecentRequestLog(entry, filePath = RECENT_REQUEST_LOG_PATH, limit = RECENT_REQUEST_LOG_LIMIT) {
  const existing = safeJsonParse(fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "[]", []);
  const entries = Array.isArray(existing) ? existing : [];
  entries.push(entry);
  const kept = entries.slice(-Math.max(1, Number(limit) || 10));
  fs.writeFileSync(filePath, `${JSON.stringify(kept, null, 2)}\n`, "utf8");
}

module.exports = {
  appendRecentRequestLog,
  previewJson,
  safeJsonParse,
};
