const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");

const targets = {
  macos: [
    ["node20-macos-arm64", "mitm-antigravity-macos-arm64"],
    ["node20-macos-x64", "mitm-antigravity-macos-x64"],
  ],
  windows: [
    ["node20-win-x64", "mitm-antigravity-win-x64.exe"],
  ],
  linux: [
    ["node20-linux-x64", "mitm-antigravity-linux-x64"],
    ["node20-linux-arm64", "mitm-antigravity-linux-arm64"],
  ],
  "linux-x64": [
    ["node20-linux-x64", "mitm-antigravity-linux-x64"],
  ],
  "linux-arm64": [
    ["node20-linux-arm64", "mitm-antigravity-linux-arm64"],
  ],
};

function selectedTargets(scope) {
  if (scope === "all") return [...targets.macos, ...targets.windows, ...targets.linux];
  if (!targets[scope]) throw new Error(`Unknown pkg build scope: ${scope}`);
  return targets[scope];
}

function pkgBinPath() {
  return require.resolve("@yao-pkg/pkg/lib-es5/bin.js");
}

function buildTarget(target, outputName) {
  const outputPath = path.join(distDir, outputName);
  console.log(`Building ${target} -> ${outputPath}`);
  execFileSync(process.execPath, [pkgBinPath(), ".", "--targets", target, "--output", outputPath], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
}

const scope = process.argv[2] || "all";
fs.mkdirSync(distDir, { recursive: true });

for (const [target, outputName] of selectedTargets(scope)) {
  buildTarget(target, outputName);
}
