const fs = require("fs");
const path = require("path");
const { shouldIncludeSecrets, stripReleaseSettings } = require("./settings-sanitizer");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const resourcesDir = path.join(root, "src-tauri", "resources");

function tauriTargetTriple() {
    return process.env.MITM_TAURI_TARGET || process.env.CARGO_BUILD_TARGET || process.env.TAURI_TARGET_TRIPLE || "";
}

function isWindowsTarget(target = tauriTargetTriple()) {
    return target ? target.includes("pc-windows") : process.platform === "win32";
}

function backendResourceName() {
    return isWindowsTarget() ? "mitm-ag-backend.exe" : "mitm-ag-backend";
}

function pkgBuildScript() {
    const target = tauriTargetTriple();
    if (target.includes("pc-windows")) return "build:pkg:windows";
    if (target.includes("unknown-linux")) return "build:pkg:linux";
    if (target.includes("apple-darwin")) return "build:pkg:macos";
    if (process.platform === "win32") return "build:pkg:windows";
    if (process.platform === "linux") return "build:pkg:linux";
    return "build:pkg:macos";
}

function resolvePkgBinaryName() {
    // Khi cross-compile, wrapper script set target env để chọn đúng backend binary.
    // Dùng biến đó để chọn đúng backend binary thay vì dựa vào platform của máy host.
    const target = tauriTargetTriple();
    if (target) {
        if (target.includes("aarch64-apple-darwin")) return "mitm-antigravity-macos-arm64";
        if (target.includes("x86_64-apple-darwin")) return "mitm-antigravity-macos-x64";
        if (target.includes("x86_64-pc-windows")) return "mitm-antigravity-win-x64.exe";
        if (target.includes("aarch64-pc-windows")) return "mitm-antigravity-win-arm64.exe";
        if (target.includes("x86_64-unknown-linux")) return "mitm-antigravity-linux-x64";
        if (target.includes("aarch64-unknown-linux")) return "mitm-antigravity-linux-arm64";
    }
    // Fallback: native platform detection
    const { platform, arch } = process;
    if (platform === "win32") return arch === "arm64" ? "mitm-antigravity-win-arm64.exe" : "mitm-antigravity-win-x64.exe";
    if (platform === "linux") return arch === "arm64" ? "mitm-antigravity-linux-arm64" : "mitm-antigravity-linux-x64";
    return arch === "arm64" ? "mitm-antigravity-macos-arm64" : "mitm-antigravity-macos-x64";
}

const sourceName = resolvePkgBinaryName();
const sourcePath = path.join(distDir, sourceName);
const targetPath = path.join(resourcesDir, backendResourceName());

if (!fs.existsSync(sourcePath)) {
    // Binary chưa có – tự build thay vì crash.
    // Chọn script build đúng platform để tránh download base binary không cần thiết.
    const { execSync } = require("child_process");
    const pkgScript = pkgBuildScript();
    console.log(`Backend binary not found. Building with npm run ${pkgScript} ...`);
    execSync(`npm run ${pkgScript}`, { stdio: "inherit", cwd: root });
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
