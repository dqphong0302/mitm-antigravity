#!/usr/bin/env node
// Delete 19 one-liner shim files left over from the src/ refactoring.
// Run once: node scripts/cleanup-shims.js

const fs   = require("fs");
const path = require("path");

const ROOT  = path.resolve(__dirname, "..");
const SHIMS = [
  "src/args.js",
  "src/autostart.js",
  "src/cert.js",
  "src/cli.js",
  "src/config.js",
  "src/constants.js",
  "src/dns.js",
  "src/gui.js",
  "src/http.js",
  "src/logging.js",
  "src/model-list.js",
  "src/model-serialization.js",
  "src/models.js",
  "src/proxy-control.js",
  "src/proxy-helpers.js",
  "src/proxy-logger.js",
  "src/proxy.js",
  "src/system.js",
  "src/wizard.js",
];

let deleted = 0;
for (const rel of SHIMS) {
  const p = path.join(ROOT, rel);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log("  deleted  " + rel);
    deleted++;
  } else {
    console.log("  skipped  " + rel + " (not found)");
  }
}
console.log("\nDone: " + deleted + "/" + SHIMS.length + " shim files removed.");
