"use strict";

// Low-level response-write primitives shared by the router-intercept path and
// the GPT Responses-API adapter. Kept separate from index.js so both can use
// them without pulling in the whole proxy server closure.

const { ensureBufferLimit, MB } = require("./memory");
const { createInternalInstructionSseSanitizer } = require("./internal-instruction-sanitizer");
const { logProxyError } = require("./logger");

const MAX_SSE_BUFFER_BYTES = 6 * MB;
const MAX_RESPONSE_BODY_BYTES = 192 * MB;

function isResponseWritable(res) {
  return !res.writableEnded && !res.destroyed;
}

// Write a chunk with backpressure handling. Resolves true when flushed, false
// when the socket closed. `reader` (optional) is cancelled if the client goes
// away mid-stream so we don't leak the upstream body.
function writeResponseChunk(res, chunk, reader = null) {
  if (!chunk || !isResponseWritable(res)) return Promise.resolve(false);
  if (typeof res.once !== "function" || typeof res.off !== "function") {
    res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Promise.resolve(true);
  }

  return new Promise((resolve, reject) => {
    const onDrain = () => cleanup(true);
    const onClose = () => {
      if (reader && typeof reader.cancel === "function") reader.cancel().catch(() => {});
      cleanup(false);
    };
    const onError = (error) => cleanup(false, error);
    const cleanup = (ok, error) => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      if (error) reject(error);
      else resolve(ok);
    };

    res.once("close", onClose);
    res.once("error", onError);
    if (res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))) cleanup(true);
    else res.once("drain", onDrain);
  });
}

async function streamSanitizedSseResponse(responseBody, res, options = {}) {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  const sseSanitizer = createInternalInstructionSseSanitizer();
  const idleTimeoutMs = Number.isFinite(Number(options.idleTimeoutMs))
    ? Math.max(0, Number(options.idleTimeoutMs))
    : 2 * 60 * 1000;
  const requestId = options.requestId || "";
  const model = options.model || "";

  // Raw SSE tee logger — ghi tối đa 32KB đầu tiên để debug thinking leak
  const SSE_RAW_LOG = "/tmp/mitm-sse-raw.log";
  let rawBytesLogged = 0;
  const MAX_RAW_LOG_BYTES = 32 * 1024;
  function logRawChunk(text) {
    if (rawBytesLogged >= MAX_RAW_LOG_BYTES) return;
    try {
      const fs = require("fs");
      const toWrite = text.slice(0, MAX_RAW_LOG_BYTES - rawBytesLogged);
      fs.appendFileSync(SSE_RAW_LOG, toWrite);
      rawBytesLogged += toWrite.length;
    } catch { /* best effort */ }
  }
  let idleTimer = null;
  const clearIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const armIdleTimer = () => {
    clearIdleTimer();
    if (idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      const message = `upstream SSE idle timeout after ${idleTimeoutMs}ms`;
      logProxyError({ message, requestId, model });
      try { reader.cancel(new Error(message)).catch(() => {}); } catch (_) { /* ignore */ }
      if (isResponseWritable(res)) res.end();
    }, idleTimeoutMs);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  };

  try {
    armIdleTimer();
    while (isResponseWritable(res)) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleTimer();
      const decoded = decoder.decode(value, { stream: true });
      logRawChunk(decoded);
      const safeChunk = sseSanitizer.push(decoded);
      if (safeChunk) await writeResponseChunk(res, safeChunk, reader);
    }
    clearIdleTimer();
    if (!isResponseWritable(res)) return;

    const decodedTail = decoder.decode();
    if (decodedTail) {
      const safeTailChunk = sseSanitizer.push(decodedTail);
      if (safeTailChunk) await writeResponseChunk(res, safeTailChunk, reader);
    }
    const tail = sseSanitizer.flush();
    if (tail) await writeResponseChunk(res, tail, reader);
    if (isResponseWritable(res)) res.end();
  } finally {
    clearIdleTimer();
    reader.releaseLock();
  }
}

async function readBoundedTextResponse(responseBody, maxBytes = MAX_RESPONSE_BODY_BYTES) {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let rawBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawBytes += value.byteLength;
      ensureBufferLimit(rawBytes, maxBytes, "Upstream response body");
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    return raw;
  } finally {
    reader.releaseLock();
  }
}

module.exports = {
  isResponseWritable,
  writeResponseChunk,
  streamSanitizedSseResponse,
  readBoundedTextResponse,
  MAX_SSE_BUFFER_BYTES,
  MAX_RESPONSE_BODY_BYTES,
};
