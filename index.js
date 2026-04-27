#!/usr/bin/env node

const { main } = require("./src/cli");

// Global safety nets: log errors and prevent silent crashes.
process.on("uncaughtException", (error) => {
  try {
    const { appendLog, errorMeta } = require("./src/logging");
    appendLog("error", "Uncaught exception", errorMeta(error));
  } catch {
    // Keep error logging best-effort.
  }
  console.error(`[FATAL] Uncaught exception: ${error.message || error}`);
  if (error.stack) console.error(error.stack);
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  try {
    const { appendLog, errorMeta } = require("./src/logging");
    const error = reason instanceof Error ? reason : new Error(String(reason));
    appendLog("error", "Unhandled rejection", errorMeta(error));
  } catch {
    // Keep error logging best-effort.
  }
  console.error(`[FATAL] Unhandled rejection: ${reason instanceof Error ? reason.message : reason}`);
});

if (require.main === module) {
  main().catch((err) => {
    try {
      const { appendLog, errorMeta } = require("./src/logging");
      appendLog("error", "CLI fatal error", errorMeta(err));
    } catch {
      // Keep fatal error handling best-effort.
    }
    console.error(err.message || String(err));
    process.exit(1);
  });
} else {
  module.exports = require("./src");
}
