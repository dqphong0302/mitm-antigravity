const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { shouldIncludeSecrets, stripReleaseSettings } = require("./settings-sanitizer");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const resourcesDir = path.join(root, "src-tauri", "resources");

const TARGETS = [
  ["aarch64-apple-darwin", { binary: "mitm-antigravity-macos-arm64", pkgScript: "build:pkg:macos" }],
  ["x86_64-apple-darwin", { binary: "mitm-antigravity-macos-x64", pkgScript: "build:pkg:macos" }],
  ["x86_64-pc-windows", { binary: "mitm-antigravity-win-x64.exe", pkgScript: "build:pkg:windows" }],
  ["aarch64-pc-windows", { binary: "mitm-antigravity-win-arm64.exe", pkgScript: "build:pkg:windows" }],
  ["x86_64-unknown-linux", { binary: "mitm-antigravity-linux-x64", pkgScript: "build:pkg:linux" }],
  ["aarch64-unknown-linux", { binary: "mitm-antigravity-linux-arm64", pkgScript: "build:pkg:linux" }],
];

function tauriTargetTriple() {
  return process.env.MITM_TAURI_TARGET || process.env.CARGO_BUILD_TARGET || process.env.TAURI_TARGET_TRIPLE || "";
}

function targetConfig(target = tauriTargetTriple()) {
  const match = TARGETS.find(([needle]) => target.includes(needle));
  return match ? match[1] : null;
}

function nativeTargetConfig() {
  const { platform, arch } = process;
  if (platform === "win32") {
    return {
      binary: arch === "arm64" ? "mitm-antigravity-win-arm64.exe" : "mitm-antigravity-win-x64.exe",
      pkgScript: "build:pkg:windows",
    };
  }
  if (platform === "linux") {
    return {
      binary: arch === "arm64" ? "mitm-antigravity-linux-arm64" : "mitm-antigravity-linux-x64",
      pkgScript: "build:pkg:linux",
    };
  }
  return {
    binary: arch === "arm64" ? "mitm-antigravity-macos-arm64" : "mitm-antigravity-macos-x64",
    pkgScript: "build:pkg:macos",
  };
}

function resolvedConfig() {
  return targetConfig() || nativeTargetConfig();
}

function isWindowsTarget(target = tauriTargetTriple()) {
  return target ? target.includes("pc-windows") : process.platform === "win32";
}

function backendResourceName() {
  return isWindowsTarget() ? "mitm-ag-backend.exe" : "mitm-ag-backend";
}

const config = resolvedConfig();
const sourcePath = path.join(distDir, config.binary);
const targetPath = path.join(resourcesDir, backendResourceName());

if (!fs.existsSync(sourcePath)) {
  console.log(`Backend binary not found. Building with npm run ${config.pkgScript} ...`);
  execFileSync("npm", ["run", config.pkgScript], { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`pkg build finished but binary still missing: ${sourcePath}`);
  }
}

fs.mkdirSync(resourcesDir, { recursive: true });
fs.copyFileSync(sourcePath, targetPath);
if (!isWindowsTarget()) fs.chmodSync(targetPath, 0o755);

const settingsSource = path.join(root, "settings.json");
const settingsTarget = path.join(resourcesDir, "settings.json");
if (fs.existsSync(settingsSource)) {
  const settings = JSON.parse(fs.readFileSync(settingsSource, "utf8"));
  const output = stripReleaseSettings(settings, { includeSecrets: shouldIncludeSecrets() });
  fs.writeFileSync(settingsTarget, `${JSON.stringify(output, null, 2)}\n`);
} else if (!fs.existsSync(settingsTarget)) {
  fs.writeFileSync(settingsTarget, "{}\n");
}

console.log(`Prepared Tauri backend resource: ${targetPath}`);
