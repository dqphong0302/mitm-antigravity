class PayloadTooLargeError extends Error {
  constructor(message, maxBytes) {
    super(message);
    this.name = "PayloadTooLargeError";
    this.code = "PAYLOAD_TOO_LARGE";
    this.statusCode = 413;
    this.maxBytes = maxBytes;
  }
}

function collectBodyRaw(req, options = {}) {
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Number(options.maxBytes) : 0;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    function cleanup() {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    }

    function settle(error, body) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(body);
    }

    function onData(chunk) {
      total += chunk.length;
      if (maxBytes > 0 && total > maxBytes) {
        settle(new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`, maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      settle(null, Buffer.concat(chunks, total));
    }

    function onError(error) {
      settle(error);
    }

    function onAborted() {
      settle(new Error("Request aborted before body completed"));
    }

    function onClose() {
      if (!req.complete) onAborted();
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    req.on("close", onClose);
  });
}

function readRequestJson(req) {
  return collectBodyRaw(req).then((body) => {
    if (!body.length) return {};
    try {
      return JSON.parse(body.toString());
    } catch {
      throw new Error(`Invalid JSON in request body (${body.length} bytes)`);
    }
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

module.exports = {
  collectBodyRaw,
  PayloadTooLargeError,
  readRequestJson,
  sendJson,
};
