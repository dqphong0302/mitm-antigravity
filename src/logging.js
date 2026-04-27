const fs = require("fs");
const os = require("os");
const path = require("path");

const { APP_NAME } = require("./constants");

const DEFAULT_MAX_LOG_BYTES = 220 * 1024;
const SECRET_KEY_PATTERN = /(api[-_]?key|token|password|authorization|secret)/i;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_TEXT_PATTERN = /(["']?(?:access_token|refresh_token|id_token|auth_token|api_key|apikey|authorization|cookie|token|secret)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi;

function appLogPath() {
  return process.env.MITM_APP_LOG || path.join(os.tmpdir(), `${APP_NAME}-backend.log`);
}

function proxyLogPath() {
  return process.env.MITM_PROXY_LOG || path.join(os.tmpdir(), `${APP_NAME}-proxy.log`);
}

function logPaths() {
  return {
    backend: appLogPath(),
    proxy: proxyLogPath(),
  };
}

function redact(value, key = "") {
  if (SECRET_KEY_PATTERN.test(key)) return value ? "[redacted]" : value;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item));
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    redact(childValue, childKey),
  ]));
}

function redactText(value) {
  return String(value || "")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SECRET_TEXT_PATTERN, "$1[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-[redacted]")
    .replace(EMAIL_PATTERN, "[redacted-email]");
}

function serializeMeta(meta) {
  if (!meta) return "";
  try {
    return ` ${JSON.stringify(redact(meta))}`;
  } catch {
    return " [unserializable metadata]";
  }
}

function appendLog(level, message, meta) {
  const line = `[${new Date().toISOString()}] ${String(level || "info").toUpperCase()} ${message}${serializeMeta(meta)}\n`;
  try {
    fs.appendFileSync(appLogPath(), line, "utf8");
  } catch (error) {
    console.error(`Failed to write backend log: ${error.message}`);
  }
}

function errorMeta(error, extra = {}) {
  return {
    ...extra,
    error: {
      name: error && error.name ? error.name : "Error",
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : "",
      code: error && error.code ? error.code : undefined,
    },
  };
}

function readLogFile(filePath, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) return fs.readFileSync(filePath, "utf8");

    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
      return buffer.toString("utf8").replace(/^[^\n]*\n?/, "");
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return `Failed to read ${filePath}: ${error.message}`;
  }
}

function readRecentLogs(maxBytes = DEFAULT_MAX_LOG_BYTES) {
  const paths = logPaths();
  return {
    paths,
    maxBytes,
    backend: readLogFile(paths.backend, maxBytes),
    proxy: readLogFile(paths.proxy, maxBytes),
  };
}

function clearLogs() {
  const paths = logPaths();
  for (const filePath of Object.values(paths)) {
    try {
      fs.writeFileSync(filePath, "", "utf8");
    } catch (error) {
      appendLog("warn", "Failed to clear log file", { filePath, message: error.message });
    }
  }
  return paths;
}

module.exports = {
  appendLog,
  appLogPath,
  clearLogs,
  errorMeta,
  logPaths,
  proxyLogPath,
  redact,
  redactText,
  readLogFile,
  readRecentLogs,
};
