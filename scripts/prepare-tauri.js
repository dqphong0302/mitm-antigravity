const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { shouldIncludeSecrets, stripReleaseSettings } = require("./settings-sanitizer");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const resourcesDir = path.join(root, "src-tauri", "resources");

const TARGETS = [
  ["aarch64-apple-darwin", { binary: "mitm-antigravity-macos-arm64", pkgTarget: "macos-arm64" }],
  ["x86_64-apple-darwin", { binary: "mitm-antigravity-macos-x64", pkgTarget: "macos-x64" }],
  ["x86_64-pc-windows", { binary: "mitm-antigravity-win-x64.exe", pkgTarget: "win-x64" }],
  ["aarch64-pc-windows", { binary: "mitm-antigravity-win-arm64.exe", pkgTarget: "win-arm64" }],
  ["x86_64-unknown-linux", { binary: "mitm-antigravity-linux-x64", pkgTarget: "linux-x64" }],
  ["aarch64-unknown-linux", { binary: "mitm-antigravity-linux-arm64", pkgTarget: "linux-arm64" }],
];

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

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
      pkgTarget: arch === "arm64" ? "win-arm64" : "win-x64",
    };
  }
  if (platform === "linux") {
    return {
      binary: arch === "arm64" ? "mitm-antigravity-linux-arm64" : "mitm-antigravity-linux-x64",
      pkgTarget: arch === "arm64" ? "linux-arm64" : "linux-x64",
    };
  }
  return {
    binary: arch === "arm64" ? "mitm-antigravity-macos-arm64" : "mitm-antigravity-macos-x64",
    pkgTarget: arch === "arm64" ? "macos-arm64" : "macos-x64",
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

function sameFileContent(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath) || !fs.existsSync(targetPath)) return false;
  const source = fs.readFileSync(sourcePath);
  const target = fs.readFileSync(targetPath);
  return source.length === target.length && source.equals(target);
}

function writeJsonIfChanged(filePath, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === next) return;
  fs.writeFileSync(filePath, next);
}

const config = resolvedConfig();
const sourcePath = path.join(distDir, config.binary);
const targetPath = path.join(resourcesDir, backendResourceName());

if (!fs.existsSync(sourcePath)) {
  console.log(`Backend binary not found. Building ${config.pkgTarget} ...`);
  execFileSync(executable("node"), [path.join("scripts", "build-pkg.js"), config.pkgTarget], {
    stdio: "inherit",
    cwd: root,
  });
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`pkg build finished but binary still missing: ${sourcePath}`);
  }
}

fs.mkdirSync(resourcesDir, { recursive: true });
if (sameFileContent(sourcePath, targetPath)) {
  console.log(`Prepared Tauri backend resource unchanged: ${targetPath}`);
} else {
  fs.copyFileSync(sourcePath, targetPath);
  if (!isWindowsTarget()) fs.chmodSync(targetPath, 0o755);
  console.log(`Prepared Tauri backend resource: ${targetPath}`);
}

const settingsSource = path.join(root, "settings.json");
const settingsTarget = path.join(resourcesDir, "settings.json");
if (fs.existsSync(settingsSource)) {
  const settings = JSON.parse(fs.readFileSync(settingsSource, "utf8"));
  writeJsonIfChanged(settingsTarget, stripReleaseSettings(settings, { includeSecrets: shouldIncludeSecrets() }));
} else if (!fs.existsSync(settingsTarget)) {
  fs.writeFileSync(settingsTarget, "{}\n");
}
