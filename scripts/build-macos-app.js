const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const appName = "MITM Antigravity";
const bundleId = "com.phongdang.mitm-antigravity";
const binaryNames = [
    { arch: "arm64", file: "mitm-antigravity-macos-arm64" },
    { arch: "x64", file: "mitm-antigravity-macos-x64" },
];

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function copyFile(source, target, mode) {
    fs.copyFileSync(source, target);
    if (mode) fs.chmodSync(target, mode);
}

function plistFor({ arch, executable }) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>${executable}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}.${arch}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.2.0</string>
  <key>CFBundleVersion</key>
  <string>0.2.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}

function launcherScript(binaryName) {
    return `#!/bin/sh
set -eu
APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BIN="$APP_DIR/Resources/${binaryName}"
cd "$APP_DIR/Resources"
exec "$BIN" gui
`;
}

if (!fs.existsSync(distDir)) {
    throw new Error(`Missing dist directory: ${distDir}. Run pkg build first.`);
}

for (const item of binaryNames) {
    const sourceBinary = path.join(distDir, item.file);
    if (!fs.existsSync(sourceBinary)) {
        console.warn(`Skipping ${item.arch}: missing ${sourceBinary}`);
        continue;
    }

    const appDir = path.join(distDir, `${appName}-${item.arch}.app`);
    const contentsDir = path.join(appDir, "Contents");
    const macosDir = path.join(contentsDir, "MacOS");
    const resourcesDir = path.join(contentsDir, "Resources");
    const launcherName = "mitm-antigravity-launcher";

    fs.rmSync(appDir, { recursive: true, force: true });
    ensureDir(macosDir);
    ensureDir(resourcesDir);

    copyFile(sourceBinary, path.join(resourcesDir, item.file), 0o755);
    const settingsSource = path.join(distDir, "settings.json");
    if (fs.existsSync(settingsSource)) copyFile(settingsSource, path.join(resourcesDir, "settings.json"));

    fs.writeFileSync(path.join(contentsDir, "Info.plist"), plistFor({ arch: item.arch, executable: launcherName }));
    fs.writeFileSync(path.join(macosDir, launcherName), launcherScript(item.file));
    fs.chmodSync(path.join(macosDir, launcherName), 0o755);

    console.log(`Created ${appDir}`);
}
