"use strict";

const MB = 1024 * 1024;

function bytesLabel(bytes) {
  return `${(bytes / MB).toFixed(1)}MB`;
}

class ProxyMemoryLimitError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = "ProxyMemoryLimitError";
    this.statusCode = statusCode;
  }
}

function ensureBufferLimit(totalBytes, maxBytes, label) {
  if (maxBytes > 0 && totalBytes > maxBytes) {
    throw new ProxyMemoryLimitError(`${label} exceeds ${bytesLabel(maxBytes)}`);
  }
}

module.exports = {
  MB,
  ProxyMemoryLimitError,
  bytesLabel,
  ensureBufferLimit,
};
