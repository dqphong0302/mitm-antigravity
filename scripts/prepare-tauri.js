const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const resourcesDir = path.join(root, "src-tauri", "resources");
const backendName = process.platform === "win32" ? "mitm-ag-backend.exe" : "mitm-ag-backend";
const sourceName = process.platform === "win32"
    ? "mitm-antigravity-win-x64.exe"
    : process.arch === "arm64"
        ? "mitm-antigravity-macos-arm64"
        : "mitm-antigravity-macos-x64";
const sourcePath = path.join(distDir, sourceName);
const targetPath = path.join(resourcesDir, backendName);

function stripSecrets(settings) {
    const clone = JSON.parse(JSON.stringify(settings || {}));
    for (const machine of Object.values(clone.machines || {})) {
        if (machine && typeof machine === "object") {
            machine.apiKey = "";
            machine.routerUrl = "";
            machine.model = "";
            machine.modelPrefix = "ag/";
            machine.modelMap = {};
        }
    }
    if (clone.apiKey) clone.apiKey = "";
    if (clone.routerUrl) clone.routerUrl = "";
    return clone;
}

if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing backend binary: ${sourcePath}. Run npm run build:pkg first.`);
}

fs.mkdirSync(resourcesDir, { recursive: true });
fs.copyFileSync(sourcePath, targetPath);
if (process.platform !== "win32") fs.chmodSync(targetPath, 0o755);

const settingsSource = path.join(root, "settings.json");
const settingsTarget = path.join(resourcesDir, "settings.json");
if (fs.existsSync(settingsSource)) {
    const settings = JSON.parse(fs.readFileSync(settingsSource, "utf8"));
    const output = process.env.MITM_COPY_SETTINGS_WITH_SECRETS === "true" ? settings : stripSecrets(settings);
    fs.writeFileSync(settingsTarget, `${JSON.stringify(output, null, 2)}\n`);
} else if (!fs.existsSync(settingsTarget)) {
    fs.writeFileSync(settingsTarget, "{}\n");
}

console.log(`Prepared Tauri backend resource: ${targetPath}`);
