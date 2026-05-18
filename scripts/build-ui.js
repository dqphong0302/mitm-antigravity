/**
 * scripts/build-ui.js
 *
 * Generates static frontend files into tauri-ui/:
 *   tauri-ui/index.html  - full standalone HTML (CSS + JS inlined)
 *
 * Run automatically via:
 *   npm run tauri:prepare     (production)
 *   npm run tauri:prepare:dev (dev)
 */

"use strict";

const path = require("path");
const fs   = require("fs");

// ── Resolve project root ──────────────────────────────────────────────────────
const root    = path.resolve(__dirname, "..");
const outDir  = path.join(root, "tauri-ui");
const outFile = path.join(outDir, "index.html");

// ── Load GUI modules ──────────────────────────────────────────────────────────
const { guiHtml } = require(path.join(root, "src", "gui", "template"));

// ── Emit ──────────────────────────────────────────────────────────────────────
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, guiHtml(), "utf8");

const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`[build-ui] wrote tauri-ui/index.html (${kb} KB)`);
