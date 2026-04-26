const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const sourceExe = path.join(distDir, "mitm-antigravity-win-x64.exe");
const settingsSource = path.join(distDir, "settings.json");
const portableDir = path.join(distDir, "MITM Antigravity Windows");
const appExe = path.join(portableDir, "MITM Antigravity.exe");

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function copyFile(source, target) {
    if (fs.existsSync(source)) fs.copyFileSync(source, target);
}

function launcherBat() {
    return `@echo off
setlocal
cd /d "%~dp0"
start "MITM Antigravity" "MITM Antigravity.exe" gui
`;
}

function readmeText() {
    return `MITM Antigravity Windows Portable
=================================

How to run
----------
Double-click "Launch MITM Antigravity.bat" to start the local GUI.
The GUI opens at http://127.0.0.1:20245/.

Files
-----
- MITM Antigravity.exe: packaged Windows binary
- Launch MITM Antigravity.bat: double-click launcher for GUI mode
- settings.json: local app settings copied from the build output

Admin/UAC notes
---------------
Windows may show a UAC prompt when the app needs to install the root certificate,
edit the hosts file, or flush DNS. This replaces the sudo password flow used on macOS.

Security note
-------------
By default, npm run build strips apiKey from settings.json. Only set
MITM_COPY_SETTINGS_WITH_SECRETS=true for private builds.
`;
}

if (!fs.existsSync(distDir)) {
    throw new Error(`Missing dist directory: ${distDir}. Run pkg build first.`);
}

if (!fs.existsSync(sourceExe)) {
    throw new Error(`Missing Windows binary: ${sourceExe}. Run npm run build:pkg first.`);
}

fs.rmSync(portableDir, { recursive: true, force: true });
ensureDir(portableDir);
copyFile(sourceExe, appExe);
copyFile(settingsSource, path.join(portableDir, "settings.json"));
fs.writeFileSync(path.join(portableDir, "Launch MITM Antigravity.bat"), launcherBat());
fs.writeFileSync(path.join(portableDir, "README-WINDOWS.txt"), readmeText());

console.log(`Created ${portableDir}`);
