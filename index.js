#!/usr/bin/env node

const { main } = require("./src/cli");

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
