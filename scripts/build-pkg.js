#!/usr/bin/env node
/**
 * Build một pkg binary cụ thể và verify output tồn tại.
 * Usage: node scripts/build-pkg.js <target>
 * Target: macos-arm64 | macos-x64 | win-x64 | win-arm64 | linux-x64 | linux-arm64
 */

const { execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

const root    = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");

const PKG_TARGETS = {
  "macos-arm64": "node20-macos-arm64",
  "macos-x64":   "node20-macos-x64",
  "win-x64":     "node20-win-x64",
  "win-arm64":   "node20-win-arm64",
  "linux-x64":   "node20-linux-x64",
  "linux-arm64": "node20-linux-arm64",
};

const OUTPUT_NAMES = {
  "macos-arm64": "mitm-antigravity-macos-arm64",
  "macos-x64":   "mitm-antigravity-macos-x64",
  "win-x64":     "mitm-antigravity-win-x64.exe",
  "win-arm64":   "mitm-antigravity-win-arm64.exe",
  "linux-x64":   "mitm-antigravity-linux-x64",
  "linux-arm64": "mitm-antigravity-linux-arm64",
};

const target = process.argv[2];

if (!target || !PKG_TARGETS[target]) {
  console.error("Usage: node scripts/build-pkg.js <target>");
  console.error("Valid targets: " + Object.keys(PKG_TARGETS).join(", "));
  process.exit(1);
}

const pkgTarget  = PKG_TARGETS[target];
const outputName = OUTPUT_NAMES[target];
const outputPath = path.join(distDir, outputName);

fs.mkdirSync(distDir, { recursive: true });
console.log("Building " + target + " → " + outputName);
console.log("pkg target: " + pkgTarget);

try {
  execSync(
    "node node_modules/@yao-pkg/pkg/lib-es5/bin.js . --targets " + pkgTarget + " --out-path dist",
    { stdio: "inherit", cwd: root }
  );
} catch (_) {
  // pkg có thể exit non-zero trên một số platform dù build thành công → kiểm tra output
}

if (!fs.existsSync(outputPath)) {
  console.error("ERROR: Expected binary not found: " + outputPath);
  try { console.error("dist/ contents: " + fs.readdirSync(distDir).join(", ")); } catch {}
  process.exit(1);
}

const sizeKB = Math.round(fs.statSync(outputPath).size / 1024);
console.log("Built: " + outputPath + " (" + sizeKB.toLocaleString() + " KB)");
